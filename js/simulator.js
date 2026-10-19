/**
 * Simulated sensor for Demo Mode. Produces samples in exactly the same shape as the ESP8266
 * firmware (see README "WebSocket protocol"). Data is SIMULATED and is always labelled as such in the UI.
 */
import { CONFIG } from './config.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm3 = (v) => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};

/** Deterministic-capable sensor model (inject `rng` for tests). */
export class SensorModel {
  constructor(sport, { rate = CONFIG.sampleRateHz.demo, rng = Math.random, firstSwingMs = 2000 } = {}) {
    this.cfg = CONFIG.sports[sport].sim;
    this.rate = rate;
    this.rng = rng;
    this.ts = 0;
    this.seq = 0;
    this.nextSwingAt = firstSwingMs;
    this.swing = null;
    this.walkPhase = rng() * 10;
  }

  _rand(a, b) { return a + (b - a) * this.rng(); }

  _gauss() {
    const u = Math.max(1e-9, this.rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng());
  }

  next() {
    this.ts += 1000 / this.rate;
    this.seq++;
    const t = this.ts / 1000 + this.walkPhase;

    // Normal movement: slow tilt of the equipment + gentle "walking/handling" motion.
    const tx = 0.25 * Math.sin(0.6 * t) + 0.1 * Math.sin(1.7 * t);
    const ty = 0.2 * Math.sin(0.4 * t + 1);
    let ax = Math.sin(tx);
    let ay = Math.sin(ty);
    let az = Math.sqrt(Math.max(0, 1 - ax * ax - ay * ay));
    let gx = 0.6 * 57.3 * 0.25 * Math.cos(0.6 * t);
    let gy = 0;
    let gz = 0;
    const walk = Math.pow(0.5 + 0.5 * Math.sin(0.35 * t), 2);
    const w = Math.sin(2 * Math.PI * 1.8 * t);
    gy += 70 * walk * w;
    gz += 30 * walk * Math.sin(2 * Math.PI * 0.9 * t);
    az += 0.25 * walk * Math.sin(2 * Math.PI * 1.8 * t + 1);

    // Swing burst
    if (!this.swing && this.ts >= this.nextSwingAt) {
      const axis = norm3([this._rand(0.2, 0.6), this._rand(-0.3, 0.3), this._rand(0.7, 1)]);
      this.swing = {
        start: this.ts,
        dur: this._rand(260, 420),
        peakDps: this._rand(...this.cfg.peakDps),
        peakG: this._rand(...this.cfg.peakG),
        axis,
        dir: norm3([axis[1], -axis[0], 0.5]),
      };
    }
    if (this.swing) {
      const u = (this.ts - this.swing.start) / this.swing.dur;
      if (u >= 1) {
        this.swing = null;
        this.nextSwingAt = this.ts + this._rand(...this.cfg.intervalS) * 1000;
      } else {
        const e = Math.pow(Math.sin(Math.PI * u), 2);
        const s = this.swing;
        gx += s.peakDps * e * s.axis[0];
        gy += s.peakDps * e * s.axis[1];
        gz += s.peakDps * e * s.axis[2];
        ax += s.peakG * e * s.dir[0];
        ay += s.peakG * e * s.dir[1];
        az += s.peakG * e * s.dir[2];
      }
    }

    const ng = () => this._gauss() * 0.015;
    const nd = () => this._gauss() * 1.2;
    return {
      type: 'sample',
      seq: this.seq,
      ts: Math.round(this.ts),
      ax: +(ax + ng()).toFixed(3),
      ay: +(ay + ng()).toFixed(3),
      az: +(az + ng()).toFixed(3),
      gx: +(gx + nd()).toFixed(2),
      gy: +(gy + nd()).toFixed(2),
      gz: +(gz + nd()).toFixed(2),
    };
  }
}

/** Timer-driven source used by the app in Demo Mode. */
export class DemoSource {
  constructor(sport) {
    this.sport = sport;
    this.sink = null;
    this.timer = null;
    this.model = new SensorModel(sport);
    this._acc = 0;
    this._last = 0;
  }

  setSink(fn) { this.sink = fn; }

  start() {
    if (this.timer) return;
    this._last = performance.now();
    this.timer = setInterval(() => this._tick(), 20);
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resume() { this.start(); }

  stop() { this.pause(); }

  /** Restart the simulated motion (fresh swing schedule) without touching the session. */
  reset(sport = this.sport) {
    this.sport = sport;
    this.model = new SensorModel(sport);
    this._acc = 0;
    this._last = performance.now();
  }

  _tick() {
    const now = performance.now();
    this._acc += ((now - this._last) * this.model.rate) / 1000;
    this._last = now;
    let n = Math.min(Math.floor(this._acc), this.model.rate * 2);
    this._acc -= Math.floor(this._acc);
    while (n-- > 0) if (this.sink) this.sink(this.model.next());
  }
}
