/**
 * Session: accumulates samples, detects swings, tracks ACTIVE time and builds the saved record.
 * Pure logic (no DOM) so it is unit-testable.
 *
 * Active time: session time `t` (ms) is derived from the sample timestamps (`ts`) and is only
 * advanced by samples accepted while the session is running. Samples arriving while paused are
 * dropped and, on resume, the time base is re-anchored, so paused time is never counted.
 * Gaps longer than limits.maxGapMs (e.g. Wi-Fi dropout) and timestamp resets (device reboot)
 * are likewise re-anchored instead of inflating the duration.
 */
import { CONFIG } from './config.js';
import { SwingDetector, magnitude, normalizeSample, estimateSwingSpeed, consistencyScore, validateEquipment, calculateEffectiveRadius } from './analytics.js';

export const SCHEMA_VERSION = 1;

export function makeId() {
  // crypto.randomUUID is unavailable on plain-http LAN pages (insecure context), so use a fallback.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

export class Session {
  constructor({ id = makeId(), sport, name = '', mode, nominalMs, equipment = null, now = () => Date.now() } = {}) {
    if (!CONFIG.sports[sport]) throw new Error(`Unknown sport: ${sport}`);
    this.id = id;
    this.sport = sport;
    this.name = name;
    this.mode = mode;
    this.now = now;
    this.state = 'ready'; // ready | running | paused | stopped
    this.nominalMs = nominalMs || 1000 / (CONFIG.sampleRateHz[mode] || 50);

    // Equipment configuration snapshot and effective radius
    if (equipment && typeof equipment === 'object') {
      const v = validateEquipment(sport, equipment);
      if (v.valid) {
        this.equipment = { lengthInches: v.lengthInches, weightGrams: v.weightGrams, sensorMount: 'below_grip' };
        this.radiusM = calculateEffectiveRadius(sport, v.lengthInches);
      } else {
        this.equipment = null;
        this.radiusM = CONFIG.sports[sport].radiusM;
      }
    } else {
      this.equipment = null;
      this.radiusM = CONFIG.sports[sport].radiusM;
    }

    this.params = { ...CONFIG.sports[sport].swing };
    this.detector = new SwingDetector(this.params);
    this.rows = []; // [t, ax, ay, az, gx, gy, gz] (stored, possibly decimated)
    this.swings = [];
    this.stride = 1;
    this.startedAt = null;
    this.endedAt = null;
    this.sampleCount = 0;
    this.invalidCount = 0;
    this.gapCount = 0;
    this.lastT = 0;
    this._prevTs = null;
    this._offset = 0;
    this._rebase = false;
    this._sumGyro = 0;
    this._sumAccel = 0;
    this.maxGyro = 0;
    this.maxAccel = 0;
  }

  triggerRebase() {
    this._rebase = true;
    if (this.detector) this.detector.reset();
  }

  start() {
    if (this.state !== 'ready') return false;
    this.state = 'running';
    this.startedAt = this.now();
    return true;
  }

  pause() {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'running';
    this._rebase = true;
    this.detector.reset();
    return true;
  }

  stop() {
    if (this.state !== 'running' && this.state !== 'paused') return false;
    this.state = 'stopped';
    this.endedAt = this.now();
    return true;
  }

  get durationMs() {
    return this.lastT;
  }

  /** @returns {{accepted:boolean, reason?:string, row?:number[], swing?:object}} */
  addSample(raw) {
    if (this.state !== 'running') return { accepted: false, reason: 'not-running' };
    const s = normalizeSample(raw);
    if (!s) {
      this.invalidCount++;
      return { accepted: false, reason: 'invalid' };
    }

    if (this._prevTs === null) {
      this._offset = -s.ts;
    } else {
      if (s.ts === this._prevTs && !this._rebase) return { accepted: false, reason: 'duplicate' };
      const jumped = s.ts < this._prevTs || s.ts - this._prevTs > CONFIG.limits.maxGapMs;
      if (this._rebase || jumped) {
        if (jumped && !this._rebase) this.gapCount++;
        this._offset = this.lastT + this.nominalMs - s.ts;
        this.detector.reset();
      }
    }
    this._rebase = false;
    this._prevTs = s.ts;

    const t = Math.round(s.ts + this._offset);
    this.lastT = t;
    const accelMag = magnitude(s.ax, s.ay, s.az);
    const gyroMag = magnitude(s.gx, s.gy, s.gz);
    this.sampleCount++;
    this._sumGyro += gyroMag;
    this._sumAccel += accelMag;
    if (gyroMag > this.maxGyro) this.maxGyro = gyroMag;
    if (accelMag > this.maxAccel) this.maxAccel = accelMag;

    const row = [t, r3(s.ax), r3(s.ay), r3(s.az), r3(s.gx), r3(s.gy), r3(s.gz)];
    if ((this.sampleCount - 1) % this.stride === 0) {
      this.rows.push(row);
      if (this.rows.length > CONFIG.limits.maxStoredSamples) {
        this.rows = this.rows.filter((_, i) => i % 2 === 0);
        this.stride *= 2;
      }
    }

    let swing = null;
    const ev = this.detector.process({ t, accelMag, gyroMag });
    if (ev) {
      const sp = estimateSwingSpeed(ev.peakDps, this.radiusM);
      swing = { t: ev.t, durationMs: ev.durationMs, peakDps: r3(ev.peakDps), peakG: r3(ev.peakG), speedMs: r3(sp.ms), speedKmh: r3(sp.kmh) };
      this.swings.push(swing);
    }
    return { accepted: true, row, swing };
  }

  metrics() {
    const n = this.swings.length;
    const speeds = this.swings.map((s) => s.speedKmh);
    const peaks = this.swings.map((s) => s.peakDps);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const minutes = this.lastT / 60000;
    return {
      activeDurationMs: this.lastT,
      sampleCount: this.sampleCount,
      totalSwings: n,
      swingsPerMinute: minutes > 0 ? n / minutes : 0,
      avgSpeedKmh: n ? sum(speeds) / n : null,
      maxSpeedKmh: n ? Math.max(...speeds) : null,
      avgPeakGyroDps: n ? sum(peaks) / n : null,
      avgGyroDps: this.sampleCount ? this._sumGyro / this.sampleCount : null,
      maxGyroDps: this.sampleCount ? this.maxGyro : null,
      avgAccelG: this.sampleCount ? this._sumAccel / this.sampleCount : null,
      maxAccelG: this.sampleCount ? this.maxAccel : null,
      consistency: consistencyScore(peaks),
    };
  }

  toRecord() {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      sport: this.sport,
      name: this.name,
      mode: this.mode,
      simulated: this.mode === 'demo',
      startedAt: this.startedAt,
      endedAt: this.endedAt ?? this.now(),
      activeDurationMs: this.lastT,
      storedStride: this.stride,
      invalidSamples: this.invalidCount,
      timeGaps: this.gapCount,
      equipment: this.equipment ? { ...this.equipment } : null,
      settings: { radiusM: this.radiusM, swing: { ...this.params } },
      metrics: this.metrics(),
      swings: this.swings.map((s) => ({ ...s })),
      samples: this.rows,
    };
  }
}
