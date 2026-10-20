/**
 * Sensor <-> video synchronisation (pure logic, no DOM, unit-tested in Node).
 *
 * Three different clocks are involved and are NEVER assumed to be the same:
 *   1. Session time `t` (ms)      — derived from the ESP8266 `ts` (millis()) or the simulator, re-anchored
 *                                   on pause/resume/gaps (see js/session.js). One "segment" per anchor.
 *   2. Browser monotonic time     — performance.now(), stored RELATIVE to the session origin
 *                                   (`perf` = performance.now() - originPerf), in ms.
 *   3. Video media time (s)       — position in the recorded file. MediaRecorder pauses remove wall time,
 *                                   so the video timeline is piecewise relative to the browser clock.
 *
 *   sensor t --(SensorClockMap: perf = t + offset per segment/window)--> perf
 *   perf     --(RecordingTimeline: recording segments)----------------> video seconds
 *   + calibrationOffsetMs (user-measured, positive = event appears LATER in the video than predicted)
 *
 * The sensor->browser offset is estimated with a lower envelope: for every accepted sample we know its
 * session time t and its arrival time perf. Arrival = true time + latency (latency >= 0, variable), so
 * min(perf - t) over a short window is the best estimate of the offset (plus an unknown constant minimum
 * latency, which calibration absorbs). Windows also follow slow clock drift between the ESP and the laptop.
 */

export const SYNC_STATUS = {
  OK: 'ok',
  NO_VIDEO: 'no-video',
  BEFORE: 'before-recording',
  AFTER: 'after-recording',
  GAP: 'recording-paused',
  NO_TIMING: 'no-sensor-timing',
};

export const SYNC_LABEL = {
  'ok': 'In video',
  'no-video': 'No video recorded',
  'before-recording': 'Before recording started',
  'after-recording': 'After recording ended',
  'recording-paused': 'Recording paused / interrupted',
  'no-sensor-timing': 'No browser timing for this sample',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ---------------------------------------------------------------------------------------------- */
/*  Sensor clock -> browser clock                                                                  */
/* ---------------------------------------------------------------------------------------------- */
export class SensorClockMap {
  constructor({ windowMs = 3000, toleranceMs = 100 } = {}) {
    this.windowMs = windowMs;
    this.toleranceMs = toleranceMs;
    this._pieces = [];
    this._cur = null;
    this.count = 0;
  }

  /** Record one accepted sample: session time t (ms), browser arrival perf (ms rel. origin), segment id. */
  add(t, perf, segment = 0) {
    if (!isNum(t) || !isNum(perf)) return;
    this.count++;
    const off = perf - t;
    const c = this._cur;
    if (!c || c.seg !== segment || t - c.t0 >= this.windowMs || t < c.t1) {
      if (c) this._pieces.push(this._close(c));
      this._cur = { seg: segment, t0: t, t1: t, off, offs: [off] };
      return;
    }
    c.t1 = t;
    if (off < c.off) c.off = off;
    if (c.offs.length < 1000) c.offs.push(off);
  }

  _close(c) {
    const jitter = median(c.offs.map((o) => o - c.off));
    return { seg: c.seg, t0: c.t0, t1: c.t1, off: r1(c.off), jitterMs: r1(jitter), n: c.offs.length };
  }

  pieces() {
    return this._cur ? [...this._pieces, this._close(this._cur)] : [...this._pieces];
  }

  toJSON() {
    return { windowMs: this.windowMs, pieces: this.pieces() };
  }

  static fromJSON(obj, opts = {}) {
    const m = new SensorClockMap({ windowMs: obj?.windowMs || 3000, ...opts });
    m._pieces = Array.isArray(obj?.pieces) ? obj.pieces.map((p) => ({ ...p })) : [];
    m.count = m._pieces.reduce((a, p) => a + (p.n || 0), 0);
    return m;
  }

  /** Map a session time to browser perf. Returns {perf, jitterMs} or null if no timing covers t. */
  sensorToPerf(t) {
    if (!isNum(t)) return null;
    const ps = this.pieces();
    let best = null;
    let bestDist = Infinity;
    for (const p of ps) {
      if (t >= p.t0 && t <= p.t1) return { perf: t + p.off, jitterMs: p.jitterMs, seg: p.seg };
      const d = t < p.t0 ? p.t0 - t : t - p.t1;
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best && bestDist <= this.toleranceMs) return { perf: t + best.off, jitterMs: best.jitterMs, seg: best.seg };
    return null;
  }

  /** Inverse mapping: browser perf -> session time (or null). */
  perfToSensor(perf) {
    if (!isNum(perf)) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of this.pieces()) {
      const a = p.t0 + p.off;
      const b = p.t1 + p.off;
      if (perf >= a && perf <= b) return perf - p.off;
      const d = perf < a ? a - perf : perf - b;
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best && bestDist <= this.toleranceMs) return perf - best.off;
    return null;
  }

  /** Median jitter across pieces (ms), a rough indicator of sample-delivery variability. */
  typicalJitterMs() {
    const ps = this.pieces();
    return ps.length ? r1(median(ps.map((p) => p.jitterMs))) : null;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Browser clock -> video media time                                                              */
/* ---------------------------------------------------------------------------------------------- */
export class RecordingTimeline {
  constructor() {
    this.segments = []; // { p0, p1|null, v0 }  perf ms rel. origin, video seconds at p0
    this.state = 'idle'; // idle | recording | paused | stopped
    this.interrupted = false;
    this.interruptReason = '';
  }

  start(perf) {
    if (this.state !== 'idle' || !isNum(perf)) return false;
    this.segments.push({ p0: perf, p1: null, v0: 0 });
    this.state = 'recording';
    return true;
  }

  pause(perf) {
    if (this.state !== 'recording' || !isNum(perf)) return false;
    this._closeOpen(perf);
    this.state = 'paused';
    return true;
  }

  resume(perf) {
    if (this.state !== 'paused' || !isNum(perf)) return false;
    this.segments.push({ p0: perf, p1: null, v0: this.durationS() });
    this.state = 'recording';
    return true;
  }

  stop(perf, { interrupted = false, reason = '' } = {}) {
    if (this.state === 'idle' || this.state === 'stopped') return false;
    if (this.state === 'recording') this._closeOpen(perf);
    this.state = 'stopped';
    if (interrupted) { this.interrupted = true; this.interruptReason = reason || 'interrupted'; }
    return true;
  }

  _closeOpen(perf) {
    const s = this.segments[this.segments.length - 1];
    if (s && s.p1 === null) s.p1 = Math.max(s.p0, perf);
  }

  /** Total recorded media duration in seconds (an open segment is measured up to nowPerf). */
  durationS(nowPerf = null) {
    let d = 0;
    for (const s of this.segments) {
      const end = s.p1 ?? (isNum(nowPerf) ? Math.max(s.p0, nowPerf) : s.p0);
      d += (end - s.p0) / 1000;
    }
    return d;
  }

  perfToVideo(perf, nowPerf = null) {
    if (!this.segments.length) return { status: SYNC_STATUS.NO_VIDEO, videoS: null };
    if (!isNum(perf)) return { status: SYNC_STATUS.NO_TIMING, videoS: null };
    const first = this.segments[0];
    if (perf < first.p0) return { status: SYNC_STATUS.BEFORE, videoS: null };
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const end = s.p1 ?? (isNum(nowPerf) ? nowPerf : Infinity);
      if (perf >= s.p0 && perf <= end) return { status: SYNC_STATUS.OK, videoS: s.v0 + (perf - s.p0) / 1000 };
      const next = this.segments[i + 1];
      if (next && perf > end && perf < next.p0) return { status: SYNC_STATUS.GAP, videoS: next.v0 };
    }
    return { status: SYNC_STATUS.AFTER, videoS: null };
  }

  videoToPerf(videoS) {
    if (!isNum(videoS) || !this.segments.length) return null;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const len = s.p1 === null ? Infinity : (s.p1 - s.p0) / 1000;
      if (videoS >= s.v0 && videoS <= s.v0 + len) return s.p0 + (videoS - s.v0) * 1000;
    }
    const last = this.segments[this.segments.length - 1];
    return last.p1 === null ? null : last.p1; // beyond the end: clamp
  }

  toJSON() {
    return { segments: this.segments.map((s) => ({ ...s })), interrupted: this.interrupted, interruptReason: this.interruptReason };
  }

  static fromJSON(obj) {
    const tl = new RecordingTimeline();
    tl.segments = Array.isArray(obj?.segments) ? obj.segments.map((s) => ({ p0: s.p0, p1: s.p1 ?? null, v0: s.v0 })) : [];
    tl.interrupted = !!obj?.interrupted;
    tl.interruptReason = typeof obj?.interruptReason === 'string' ? obj.interruptReason : '';
    tl.state = tl.segments.length ? 'stopped' : 'idle';
    return tl;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Swing <-> video mapping                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Map one session time (ms) to a video position, applying the calibration offset. */
export function sensorTimeToVideo(t, clock, timeline, calibrationOffsetMs = 0, nowPerf = null) {
  if (!timeline || !timeline.segments.length) return { status: SYNC_STATUS.NO_VIDEO, videoS: null, perf: null, jitterMs: null };
  const m = clock ? clock.sensorToPerf(t) : null;
  if (!m) return { status: SYNC_STATUS.NO_TIMING, videoS: null, perf: null, jitterMs: null };
  const cal = isNum(calibrationOffsetMs) ? calibrationOffsetMs : 0;
  const v = timeline.perfToVideo(m.perf + cal, nowPerf);
  return { status: v.status, videoS: v.videoS, perf: m.perf, jitterMs: m.jitterMs };
}

/** Inverse of sensorTimeToVideo: video position (s) -> session time (ms) or null. */
export function videoToSensorTime(videoS, clock, timeline, calibrationOffsetMs = 0) {
  if (!timeline || !clock) return null;
  const perf = timeline.videoToPerf(videoS);
  if (perf === null) return null;
  const cal = isNum(calibrationOffsetMs) ? calibrationOffsetMs : 0;
  return clock.perfToSensor(perf - cal);
}

/** Map every swing (by its PEAK time `t`) to the video. Never throws on missing data. */
export function mapSwingsToVideo(swings, clock, timeline, calibrationOffsetMs = 0) {
  return (swings || []).map((s, i) => {
    if (!s || !isNum(s.t)) return { i, t: null, status: SYNC_STATUS.NO_TIMING, videoS: null, perf: null, jitterMs: null };
    const r = sensorTimeToVideo(s.t, clock, timeline, calibrationOffsetMs);
    return { i, t: s.t, ...r, videoS: r.videoS === null ? null : Math.round(r.videoS * 1000) / 1000 };
  });
}

/** Clamp replay padding to sane values. Invalid input falls back to defaults. */
export function sanitizePadding(preS, postS, { defPre = 1.5, defPost = 1.5, max = 10 } = {}) {
  const fix = (v, d) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!isNum(n) || n < 0) return d;
    return Math.min(max, Math.round(n * 100) / 100);
  };
  return { preS: fix(preS, defPre), postS: fix(postS, defPost) };
}

/** Replay window around a swing peak, clamped to [0, durationS]. */
export function replayWindow(centerS, preS, postS, durationS = Infinity) {
  if (!isNum(centerS)) return null;
  const dur = isNum(durationS) && durationS > 0 ? durationS : Infinity;
  const startS = Math.max(0, centerS - preS);
  const endS = Math.min(dur, centerS + postS);
  return { startS, endS: Math.max(startS, endS) };
}

/**
 * Honest alignment uncertainty estimate (ms, ~1 sigma-ish half width) from its components:
 *  - jitterMs: typical sample-delivery jitter after the lower-envelope fit
 *  - sampleIntervalMs: peak detection is quantised to the sensor sample period
 *  - fps: video frames quantise time to one frame
 *  - startUncertaintyMs: delay between MediaRecorder.start() and its "start" event
 * Camera capture latency (often 50–150 ms) is a systematic bias that cannot be measured
 * automatically; it is only removed by manual calibration.
 */
export function estimateUncertainty({ jitterMs = 0, sampleIntervalMs = 20, fps = 30, startUncertaintyMs = 0, calibrated = false } = {}) {
  const frame = isNum(fps) && fps > 0 ? 1000 / fps : 33.3;
  const parts = {
    sensorJitterMs: isNum(jitterMs) ? jitterMs : 0,
    sampleQuantMs: (isNum(sampleIntervalMs) ? sampleIntervalMs : 20) / 2,
    frameQuantMs: frame / 2,
    recorderStartMs: isNum(startUncertaintyMs) ? Math.min(startUncertaintyMs, 500) : 0,
  };
  const random = Math.sqrt(Object.values(parts).reduce((a, v) => a + v * v, 0));
  return {
    plusMinusMs: Math.round(random),
    components: parts,
    calibrated: !!calibrated,
    note: calibrated
      ? 'Calibrated: remaining error is mostly frame and sample quantisation.'
      : 'Not calibrated: the video may additionally lag the sensor by the camera pipeline latency (often 50–150 ms). Use calibration to remove it.',
  };
}

/** Find the entry in a time-sorted list whose `perf` is nearest to `perf` (within tolerance). */
export function nearestByPerf(list, perf, toleranceMs) {
  if (!Array.isArray(list) || !list.length || !isNum(perf)) return null;
  let best = null;
  let bestD = Infinity;
  for (const e of list) {
    const d = Math.abs(e.perf - perf);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best && bestD <= toleranceMs ? { entry: best, dtMs: Math.round(best.perf - perf) } : null;
}
