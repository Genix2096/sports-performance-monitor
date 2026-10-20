/**
 * Webcam access + local recording (getUserMedia + MediaRecorder).
 *
 * Privacy: the stream and the recorded chunks only live in this browser tab. Nothing here sends video
 * to the ESP8266, the Node server or the internet.
 *
 * All browser globals are injectable (`env`) so the state machine is unit-tested in Node with fakes.
 */
import { RecordingTimeline } from './sync.js';

export const REC_STATE = {
  OFF: 'off', // no camera stream
  REQUESTING: 'requesting', // waiting for the permission prompt / device
  PREVIEW: 'preview', // stream live, not recording
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  ERROR: 'error',
};

/** Preference order. WebM/VP9 or VP8 in Chromium & Firefox, MP4/H.264 in Safari. */
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

export function pickMimeType(MR, candidates = MIME_CANDIDATES) {
  if (!MR) return null;
  if (typeof MR.isTypeSupported !== 'function') return ''; // let the browser choose its default
  for (const c of candidates) {
    try { if (MR.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return null; // MediaRecorder exists but no usable codec
}

export function extensionFor(mime) {
  return /mp4/i.test(mime || '') ? 'mp4' : 'webm';
}

/** What this browser can do, with a human-readable reason when something is missing. */
export function cameraSupport(env = globalThis) {
  const secure = env.isSecureContext !== false;
  const gum = !!(env.navigator && env.navigator.mediaDevices && typeof env.navigator.mediaDevices.getUserMedia === 'function');
  const MR = env.MediaRecorder;
  const mime = pickMimeType(MR);
  let reason = '';
  if (!secure) reason = 'The camera needs a secure page: open the app at http://localhost:8080 on this laptop (plain http:// LAN addresses are blocked by browsers).';
  else if (!gum) reason = 'This browser does not support camera access (navigator.mediaDevices.getUserMedia).';
  return {
    secureContext: secure,
    getUserMedia: gum && secure,
    mediaRecorder: !!MR,
    mimeType: mime,
    canRecord: !!MR && mime !== null,
    reason,
    recordReason: !MR ? 'MediaRecorder is not supported in this browser — camera preview and pose work, but video cannot be recorded.'
      : mime === null ? 'No supported video codec for MediaRecorder in this browser — recording is unavailable.' : '',
  };
}

/** Translate getUserMedia / MediaRecorder errors into actionable messages. */
export function describeCameraError(err) {
  const name = err && (err.name || err.code) ? String(err.name || err.code) : 'Error';
  const map = {
    NotAllowedError: 'Camera permission was denied. Allow camera access in the browser’s address-bar site settings, then press “Enable camera” again.',
    SecurityError: 'The browser blocked camera access for this page (insecure context or policy). Use http://localhost:8080 on this laptop.',
    NotFoundError: 'No camera was found. Connect a webcam or use the synthetic demo video.',
    DevicesNotFoundError: 'No camera was found. Connect a webcam or use the synthetic demo video.',
    NotReadableError: 'The camera is in use by another application (or failed to start). Close other apps using the camera and retry.',
    TrackStartError: 'The camera is in use by another application (or failed to start). Close other apps using the camera and retry.',
    OverconstrainedError: 'The selected camera does not support the requested settings. Try another camera.',
    AbortError: 'Starting the camera was interrupted. Please retry.',
    TypeError: 'Camera access is not available on this page.',
  };
  return { code: name, message: map[name] || `Camera error: ${err && err.message ? err.message : name}` };
}

export class VideoRecorder {
  /**
   * @param {object} o
   * @param {object} [o.env] globals: navigator, MediaRecorder, Blob, isSecureContext
   * @param {Function} [o.now] monotonic clock in ms (performance.now)
   * @param {Function} [o.onChange] called on every state/progress change
   */
  constructor({ env = globalThis, now = () => performance.now(), onChange = () => {}, maxBytes = Infinity, maxDurationS = Infinity, timesliceMs = 1000, videoBitsPerSecond = 2500000, video = {} } = {}) {
    this.env = env;
    this.now = now;
    this.onChange = onChange;
    this.maxBytes = maxBytes;
    this.maxDurationS = maxDurationS;
    this.timesliceMs = timesliceMs;
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.videoOpts = video;
    this.state = REC_STATE.OFF;
    this.error = null; // {code, message}
    this.warning = '';
    this.stream = null;
    this.source = 'webcam';
    this.trackInfo = null;
    this._resetRecording();
    this._onTrackEnded = () => this._handleTrackEnded();
  }

  _resetRecording() {
    this.recorder = null;
    this.mimeType = '';
    this.chunks = [];
    this.bytes = 0;
    this.timeline = new RecordingTimeline();
    this.originPerf = 0;
    this.startCallPerf = null;
    this.startUncertaintyMs = null;
    this.result = null; // { blob, info } after stop
    this.stopReason = '';
    this._stopWaiters = [];
    this._interruptReason = '';
    this.recordedOnce = false;
  }

  _emit() { try { this.onChange(this); } catch { /* UI errors must not break recording */ } }

  get support() { return cameraSupport(this.env); }

  rel() { return this.now() - this.originPerf; }

  get hasStream() { return !!this.stream; }

  get isRecording() { return this.state === REC_STATE.RECORDING || this.state === REC_STATE.PAUSED; }

  durationS() { return this.timeline.durationS(this.rel()); }

  /** Request the webcam (shows the browser permission prompt). Resolves true on success. */
  async openCamera({ deviceId = '' } = {}) {
    if (this.stream) return true;
    const sup = this.support;
    if (!sup.getUserMedia) {
      this.error = { code: 'Unsupported', message: sup.reason };
      this.state = REC_STATE.ERROR;
      this._emit();
      return false;
    }
    this.state = REC_STATE.REQUESTING;
    this.error = null;
    this._emit();
    const v = this.videoOpts;
    const constraints = {
      audio: false,
      video: {
        width: { ideal: v.idealWidth || 1280 },
        height: { ideal: v.idealHeight || 720 },
        frameRate: { ideal: v.frameRate || 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    try {
      const stream = await this.env.navigator.mediaDevices.getUserMedia(constraints);
      this.attachStream(stream, 'webcam');
      return true;
    } catch (e) {
      this.error = describeCameraError(e);
      this.state = REC_STATE.ERROR;
      this._emit();
      return false;
    }
  }

  /** Use an existing MediaStream (e.g. the synthetic demo camera). */
  attachStream(stream, source = 'synthetic') {
    this.closeCamera(true);
    this.stream = stream;
    this.source = source;
    this.error = null;
    const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (track) {
      track.addEventListener?.('ended', this._onTrackEnded);
      const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
      this.trackInfo = { label: track.label || source, width: s.width || null, height: s.height || null, frameRate: s.frameRate || null, deviceId: s.deviceId || '' };
    } else {
      this.trackInfo = { label: source, width: null, height: null, frameRate: null, deviceId: '' };
    }
    this.state = REC_STATE.PREVIEW;
    this._emit();
  }

  /** Start recording. `originPerf` = performance.now() at session start (timeline is relative to it). */
  startRecording(originPerf = 0) {
    if (this.state !== REC_STATE.PREVIEW || !this.stream) return false;
    if (this.recordedOnce) { this.warning = 'Only one recording per session is supported.'; this._emit(); return false; }
    const sup = this.support;
    if (!sup.canRecord) {
      this.warning = sup.recordReason;
      this._emit();
      return false;
    }
    this._resetRecording();
    this.originPerf = originPerf;
    const MR = this.env.MediaRecorder;
    const opts = { videoBitsPerSecond: this.videoBitsPerSecond };
    if (sup.mimeType) opts.mimeType = sup.mimeType;
    let rec;
    try {
      rec = new MR(this.stream, opts);
    } catch (e) {
      try { rec = new MR(this.stream); } catch (e2) {
        this.warning = `Recording could not start: ${e2.message || e.message}`;
        this._emit();
        return false;
      }
    }
    this.recorder = rec;
    this.mimeType = rec.mimeType || sup.mimeType || 'video/webm';
    rec.ondataavailable = (ev) => this._onData(ev);
    rec.onstart = () => {
      const p = this.rel();
      this.timeline.start(p);
      this.startUncertaintyMs = Math.max(0, Math.round(p - this.startCallPerf));
      this._emit();
    };
    rec.onpause = () => { this.timeline.pause(this.rel()); this._emit(); };
    rec.onresume = () => { this.timeline.resume(this.rel()); this._emit(); };
    rec.onerror = (ev) => {
      const err = ev && ev.error ? ev.error : ev;
      this.warning = `Recording error: ${err && (err.message || err.name) ? (err.message || err.name) : 'unknown'}. The part recorded so far is kept.`;
      this._markInterrupted('recorder-error');
      this._emit();
    };
    rec.onstop = () => this._finalize();
    this.startCallPerf = this.rel();
    try {
      rec.start(this.timesliceMs);
    } catch (e) {
      this.recorder = null;
      this.warning = `Recording could not start: ${e.message}`;
      this._emit();
      return false;
    }
    this.recordedOnce = true;
    this.state = REC_STATE.RECORDING;
    this._emit();
    return true;
  }

  pause() {
    if (this.state !== REC_STATE.RECORDING || !this.recorder) return false;
    try { this.recorder.pause(); } catch { return false; }
    this.state = REC_STATE.PAUSED;
    this._emit();
    return true;
  }

  resume() {
    if (this.state !== REC_STATE.PAUSED || !this.recorder) return false;
    try { this.recorder.resume(); } catch { return false; }
    this.state = REC_STATE.RECORDING;
    this._emit();
    return true;
  }

  /** Stop recording; resolves with {blob, info} (or the earlier result if it already stopped). */
  stopRecording(reason = 'user', timeoutMs = 4000) {
    if (this.result) return Promise.resolve(this.result);
    if (!this.recorder) return Promise.resolve(null);
    return new Promise((resolve) => {
      this._stopWaiters.push(resolve);
      if (this.state !== REC_STATE.STOPPING) {
        this.stopReason = this.stopReason || reason;
        this.state = REC_STATE.STOPPING;
        this._emit();
        try {
          if (this.recorder.state !== 'inactive') this.recorder.stop();
          else this._finalize();
        } catch { this._finalize(); }
      }
      setTimeout(() => { if (!this.result) this._finalize(); }, timeoutMs);
    });
  }

  _onData(ev) {
    if (!ev || !ev.data || !ev.data.size) return;
    this.chunks.push(ev.data);
    this.bytes += ev.data.size;
    if (this.bytes >= this.maxBytes && this.state === REC_STATE.RECORDING) {
      this.warning = `Recording stopped automatically: size limit (${Math.round(this.maxBytes / 1048576)} MB) reached.`;
      this._markInterrupted('size-limit');
      this.stopRecording('size-limit');
    } else if (this.durationS() >= this.maxDurationS && this.state === REC_STATE.RECORDING) {
      this.warning = `Recording stopped automatically: maximum duration (${Math.round(this.maxDurationS / 60)} min) reached.`;
      this._markInterrupted('duration-limit');
      this.stopRecording('duration-limit');
    }
    this._emit();
  }

  _markInterrupted(reason) {
    this._interruptReason = this._interruptReason || reason;
  }

  _handleTrackEnded() {
    // Camera unplugged, permission revoked, or the OS took the device.
    if (this.isRecording) {
      this.warning = 'The camera stopped (disconnected or permission revoked). The part recorded so far is kept.';
      this._markInterrupted('camera-ended');
      this.stopRecording('camera-ended');
    } else {
      this.warning = 'The camera stopped (disconnected or permission revoked).';
    }
    this._releaseStream();
    if (this.state === REC_STATE.PREVIEW) this.state = REC_STATE.OFF;
    this._emit();
  }

  _finalize() {
    if (this.result) return;
    const BlobC = this.env.Blob;
    const type = (this.mimeType || 'video/webm').split(';')[0];
    const blob = this.chunks.length && BlobC ? new BlobC(this.chunks, { type }) : null;
    const interrupted = !!this._interruptReason;
    this.timeline.stop(this.rel(), { interrupted, reason: this._interruptReason || '' });
    this.result = blob ? { blob, info: this.info() } : null;
    this.chunks = []; // the Blob now owns the data
    if (this.recorder) {
      this.recorder.ondataavailable = this.recorder.onstart = this.recorder.onpause = this.recorder.onresume = this.recorder.onerror = this.recorder.onstop = null;
    }
    this.recorder = null;
    this.state = this.stream ? REC_STATE.PREVIEW : REC_STATE.OFF;
    const waiters = this._stopWaiters;
    this._stopWaiters = [];
    waiters.forEach((w) => w(this.result));
    this._emit();
  }

  /** Metadata stored with the session (never the video itself). */
  info() {
    return {
      recorded: this.timeline.segments.length > 0,
      mimeType: this.mimeType || '',
      sizeBytes: this.bytes,
      durationS: Math.round(this.timeline.durationS(this.rel()) * 1000) / 1000,
      fps: this.trackInfo?.frameRate || null,
      width: this.trackInfo?.width || null,
      height: this.trackInfo?.height || null,
      source: this.source,
      interrupted: !!this._interruptReason,
      interruptReason: this._interruptReason || '',
      startUncertaintyMs: this.startUncertaintyMs,
      timeline: this.timeline.toJSON(),
    };
  }

  _releaseStream() {
    const s = this.stream;
    this.stream = null;
    if (!s) return;
    for (const t of s.getTracks ? s.getTracks() : []) {
      t.removeEventListener?.('ended', this._onTrackEnded);
      try { t.stop(); } catch { /* ignore */ }
    }
  }

  /**
   * Stop any active recording, wait for it to finalize, and release the camera stream completely.
   * Stops every active media track so the camera indicator light turns off immediately.
   * Resolves with { blob, info } or null if nothing was recorded.
   */
  async stopAndRelease(reason = 'session_end') {
    let result = null;
    if (this.isRecording || this.state === REC_STATE.STOPPING) {
      try {
        result = await this.stopRecording(reason);
      } catch { /* proceed to release */ }
    } else if (this.result) {
      result = this.result;
    }
    this._releaseStream();
    this.state = REC_STATE.OFF;
    this._emit();
    return result;
  }

  /** Stop the camera (turns the camera light off). Does not discard a finished recording. */
  closeCamera(silent = false, force = false) {
    if (this.isRecording && !force) return false; // must stop recording first unless forced
    this._releaseStream();
    if (this.state !== REC_STATE.STOPPING) this.state = REC_STATE.OFF;
    if (!silent) this._emit();
    return true;
  }

  /** Begin a fresh session: forget the previous recording state (the app keeps the Blob separately). */
  resetForSession() {
    if (this.isRecording || this.state === REC_STATE.STOPPING) return false;
    this._resetRecording();
    this._interruptReason = '';
    this.warning = '';
    return true;
  }

  /** Full cleanup (page unload / component unmount). */
  dispose() {
    if (this.recorder) {
      try { if (this.recorder.state !== 'inactive') this.recorder.stop(); } catch { /* ignore */ }
      this.recorder.ondataavailable = this.recorder.onstop = this.recorder.onerror = null;
      this.recorder = null;
    }
    this.chunks = [];
    this._releaseStream();
    this.state = REC_STATE.OFF;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Synthetic camera for Demo Mode (no webcam needed). Clearly labelled as synthetic in the frame.  */
/* ---------------------------------------------------------------------------------------------- */
/**
 * Draws an animated stick figure whose racket rotates with the latest (simulated or real) gyro reading,
 * and burns the latest sensor session time into each frame. Replaying a swing therefore shows directly
 * how well the video lines up with the graph cursor.
 * @param {{getMotion:()=>({t:number,gyroMag:number,accelMag:number}|null), width?:number, height?:number, fps?:number}} o
 */
export function createSyntheticCamera({ getMotion, width = 640, height = 360, fps = 30, doc = globalThis.document } = {}) {
  if (!doc) return null;
  const canvas = doc.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  let angle = -60;
  let last = performance.now();
  let frame = 0;
  const draw = () => {
    const now = performance.now();
    const dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    frame++;
    const m = getMotion ? getMotion() : null;
    const w = m ? m.gyroMag : 0;
    // integrate |omega| (deg/s) into a racket angle, spring back to rest when slow
    angle += (w > 120 ? w : 0) * dt * 0.6;
    if (w <= 120) angle += (-60 - angle) * Math.min(1, dt * 2.5);
    if (angle > 240) angle = 240;
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, '#13204a');
    g.addColorStop(1, '#0b1020');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(148,163,184,.10)';
    for (let x = 0; x < width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    // stick figure
    const cx = width * 0.45;
    const hipY = height * 0.62;
    const shY = height * 0.36;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#c7d0e0';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, shY - 30, 18, 0, Math.PI * 2);
    ctx.moveTo(cx, shY - 12); ctx.lineTo(cx, hipY);
    ctx.moveTo(cx, hipY); ctx.lineTo(cx - 30, height * 0.9);
    ctx.moveTo(cx, hipY); ctx.lineTo(cx + 30, height * 0.9);
    ctx.moveTo(cx - 35, shY); ctx.lineTo(cx + 35, shY);
    ctx.stroke();
    const rad = (angle * Math.PI) / 180;
    const hx = cx + 35 + Math.cos(rad) * 50;
    const hy = shY + Math.sin(rad) * 50;
    ctx.beginPath(); ctx.moveTo(cx + 35, shY); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.strokeStyle = w > 300 ? '#f472b6' : '#34d399';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + Math.cos(rad) * 90, hy + Math.sin(rad) * 90); ctx.stroke();
    // labels
    ctx.fillStyle = 'rgba(11,16,32,.75)';
    ctx.fillRect(0, 0, width, 30);
    ctx.fillRect(0, height - 30, width, 30);
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('SYNTHETIC DEMO VIDEO — not a camera image', 10, 20);
    ctx.fillStyle = '#e8edf8';
    ctx.font = '14px ui-monospace, Consolas, monospace';
    const tTxt = m && Number.isFinite(m.t) ? (m.t / 1000).toFixed(3) : '—';
    ctx.fillText(`sensor t = ${tTxt} s   |ω| = ${m ? Math.round(w) : '—'} °/s   frame ${frame}`, 10, height - 10);
  };
  draw();
  const timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);
  return {
    stream,
    stop() {
      clearInterval(timer);
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    },
  };
}
