/**
 * Pure analytics helpers (no DOM, no browser APIs) so they can be unit tested in Node.
 *
 * Units: acceleration in g, angular velocity in degrees/second (dps), time in ms.
 */
import { CONFIG } from './config.js';

export const SAMPLE_FIELDS = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];

export function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Validate and normalise a raw sample object. Returns null for anything malformed
 * (missing/non-numeric fields, NaN/Infinity, physically implausible values).
 * Numeric strings are accepted. `ts` (ms) is required.
 */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['ts', ...SAMPLE_FIELDS]) {
    let v = raw[k];
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  const { maxG, maxDps } = CONFIG.sensorLimits;
  if (Math.abs(out.ax) > maxG || Math.abs(out.ay) > maxG || Math.abs(out.az) > maxG) return null;
  if (Math.abs(out.gx) > maxDps || Math.abs(out.gy) > maxDps || Math.abs(out.gz) > maxDps) return null;
  return out;
}

/**
 * Estimated linear speed of the point at distance `radiusM` from the rotation axis:
 *   v = omega * r   (omega in rad/s = dps * pi / 180)
 * This is a rough ESTIMATE of tip/hitting-zone speed. It is NOT ball speed and
 * depends entirely on the assumed radius and on where the sensor is mounted.
 */
export function estimateSwingSpeed(peakDps, radiusM) {
  const ms = (peakDps * Math.PI / 180) * radiusM;
  return { ms, kmh: ms * 3.6 };
}

/**
 * Consistency score from the variation in peak angular velocity of detected swings.
 *   CV    = sample standard deviation / mean            (coefficient of variation)
 *   score = round(100 * (1 - min(CV, 0.5) / 0.5))       0..100  (CV 0 -> 100, CV >= 0.5 -> 0)
 * Needs >= 3 swings; otherwise status is "insufficient" and score is null.
 */
export function consistencyScore(peaks, minSwings = 3) {
  const vals = (peaks || []).filter((p) => Number.isFinite(p));
  if (vals.length < minSwings) return { score: null, cv: null, status: 'insufficient', n: vals.length };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return { score: null, cv: null, status: 'insufficient', n: vals.length };
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
  const cv = Math.sqrt(variance) / mean;
  const score = Math.round(100 * (1 - Math.min(cv, 0.5) / 0.5));
  const status = score >= 80 ? 'high' : score >= 60 ? 'moderate' : 'variable';
  return { score, cv, status, n: vals.length };
}

/**
 * Threshold-based swing detector (state machine).
 *
 *  IDLE --(gyro >= startDps, cooldown over, re-armed)--> IN_SWING
 *  IN_SWING --(gyro <= endDps)--> evaluate -> maybe emit swing -> cooldown + must re-arm
 *  IN_SWING --(duration > maxDurationMs)--> rejected (sustained rotation, not a swing)
 *  IN_SWING --(gap in samples > maxGapMs)--> aborted
 *
 * A candidate only counts if peak gyro >= minPeakDps, peak accel >= minPeakG and its
 * duration lies within [minDurationMs, maxDurationMs]. After any candidate the gyro must
 * drop below endDps (re-arming) and the cooldown must pass, so one swing is never counted twice.
 */
export class SwingDetector {
  constructor(params) {
    this.p = { ...params };
    this.reset();
  }

  reset() {
    this.inSwing = false;
    this.needRearm = false;
    this.cooldownUntil = -Infinity;
    this.lastT = null;
    this.cand = null;
  }

  /** @param s {t:number(ms), accelMag:number(g), gyroMag:number(dps)} @returns swing event or null */
  process(s) {
    const p = this.p;
    if (!Number.isFinite(s.t) || !Number.isFinite(s.gyroMag) || !Number.isFinite(s.accelMag)) return null;
    if (this.lastT !== null && s.t - this.lastT > p.maxGapMs) {
      this.inSwing = false;
      this.cand = null;
      this.needRearm = true;
    }
    this.lastT = s.t;

    if (this.needRearm && s.gyroMag <= p.endDps) this.needRearm = false;

    if (!this.inSwing) {
      if (!this.needRearm && s.t >= this.cooldownUntil && s.gyroMag >= p.startDps) {
        this.inSwing = true;
        this.cand = { startT: s.t, peakDps: s.gyroMag, peakT: s.t, peakG: s.accelMag };
      }
      return null;
    }

    const c = this.cand;
    if (s.gyroMag > c.peakDps) { c.peakDps = s.gyroMag; c.peakT = s.t; }
    if (s.accelMag > c.peakG) c.peakG = s.accelMag;
    const dur = s.t - c.startT;

    if (dur > p.maxDurationMs) {
      this._close(s.t);
      return null;
    }
    if (s.gyroMag <= p.endDps) {
      this._close(s.t);
      const ok = c.peakDps >= p.minPeakDps && c.peakG >= p.minPeakG && dur >= p.minDurationMs;
      return ok ? { t: c.peakT, startT: c.startT, durationMs: dur, peakDps: c.peakDps, peakG: c.peakG } : null;
    }
    return null;
  }

  _close(t) {
    this.inSwing = false;
    this.cand = null;
    this.needRearm = true;
    this.cooldownUntil = t + this.p.cooldownMs;
  }
}

/** Reduce a list of rows to at most maxPoints, keeping the highest gyro-magnitude row per bucket. */
export function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const size = rows.length / maxPoints;
  const out = [];
  for (let b = 0; b < maxPoints; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(rows.length, Math.floor((b + 1) * size));
    let best = from;
    let bestVal = -1;
    for (let i = from; i < to; i++) {
      const r = rows[i];
      const m = magnitude(r[4], r[5], r[6]);
      if (m > bestVal) { bestVal = m; best = i; }
    }
    out.push(rows[best]);
  }
  return out;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmt(v, digits = 1, unit = '') {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';
}

/** Plain-language summary generated from actual metrics. */
export function buildSummaryText(m, sportLabel, mode) {
  const parts = [];
  const dur = formatDuration(m.activeDurationMs ?? m.durationMs);
  const src = mode === 'demo' ? 'simulated (demo) data' : 'live sensor data';
  parts.push(`This ${sportLabel.toLowerCase()} session lasted ${dur} of active time and is based on ${src}.`);
  if (!m.totalSwings) {
    parts.push('No swings were detected. If this was a live session, the detector thresholds may need tuning to your equipment.');
  } else {
    parts.push(`${m.totalSwings} swing${m.totalSwings === 1 ? '' : 's'} detected (${fmt(m.swingsPerMinute, 1)} per minute).`);
    parts.push(`Estimated swing speed averaged ${fmt(m.avgSpeedKmh)} km/h with a maximum of ${fmt(m.maxSpeedKmh)} km/h (estimate from gyroscope and an assumed radius, not ball speed).`);
    parts.push(`Peak angular velocity reached ${fmt(m.maxGyroDps, 0)} °/s and peak acceleration ${fmt(m.maxAccelG, 2)} g.`);
    const c = m.consistency;
    if (!c || c.score === null) parts.push('Consistency: insufficient data (at least 3 swings are needed).');
    else parts.push(`Swing consistency is ${c.status} (${c.score}/100, peak angular velocity varied by ${(c.cv * 100).toFixed(0)}%).`);
  }
  return parts.join(' ');
}
