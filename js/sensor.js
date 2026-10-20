/**
 * Live hardware connection (browser <-> ESP8266 WebSocket) and the protocol parser.
 * The browser connects DIRECTLY to the ESP8266 (ws://<esp-ip>:81); no relay is needed.
 * Live Mode never falls back to simulated data.
 */
import { CONFIG } from './config.js';

export const CONN = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  SENSOR_UNAVAILABLE: 'sensor_unavailable',
  CONNECTION_LOST: 'connection_lost',
};

export const CONN_LABEL = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  sensor_unavailable: 'Sensor unavailable',
  connection_lost: 'Connection lost',
};

/**
 * Parse one WebSocket text frame.
 * Protocol (all JSON objects, see README):
 *   {"type":"hello","fw":"1.0.0","rate":50,"accel_unit":"g","gyro_unit":"dps","sensor":"ok"|"error","msg":"..."}
 *   {"type":"status","sensor":"ok"|"error","msg":"..."}
 *   {"type":"sample","seq":N,"ts":ms,"ax":g,"ay":g,"az":g,"gx":dps,"gy":dps,"gz":dps}
 * @returns {{kind:'sample',sample:object}|{kind:'hello'|'status',sensor:string,msg:string,info:object}|{kind:'error',reason:string}}
 */
export function parseMessage(text, { sampleIntervalMs = 1000 / CONFIG.sampleRateHz.live } = {}) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { kind: 'error', reason: 'invalid JSON' };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { kind: 'error', reason: 'not an object' };
  switch (m.type) {
    case 'sample': {
      const sample = { ...m };
      if (sample.ts === undefined && Number.isFinite(Number(sample.seq))) sample.ts = Number(sample.seq) * sampleIntervalMs;
      return { kind: 'sample', sample };
    }
    case 'hello':
    case 'status':
      if (m.sensor !== 'ok' && m.sensor !== 'error') return { kind: 'error', reason: `bad sensor field in ${m.type}` };
      return { kind: m.type, sensor: m.sensor, msg: typeof m.msg === 'string' ? m.msg : '', info: m };
    default:
      return { kind: 'error', reason: `unknown message type "${m.type}"` };
  }
}

export function troubleshootingText(host, port) {
  return `Could not reach the ESP8266 at ws://${host}:${port}. Check that: (1) the ESP8266 is powered and shows an IP on the Serial Monitor (115200 baud); (2) this device is on the same Wi-Fi network; (3) the address and port below match the ESP8266; (4) the page is served over http:// (not https://).`;
}

export class LiveSensor {
  /** @param h {onState(state, detail), onSample(rawSample), onInvalid(reason), onDisconnect()} */
  constructor(h = {}) {
    this.h = h;
    this.state = CONN.DISCONNECTED;
    this.detail = '';
    this.ws = null;
    this.url = '';
    this.host = '';
    this.port = 0;
    this.wantOpen = false;
    this.everConnected = false;
    this.lastMsg = 0;
    this.rxCount = 0;
    this.invalidCount = 0;
    this.eventLog = [];
    this._timers = { connect: null, reconnect: null, watchdog: null };
  }

  logEvent(event, detail = '') {
    const entry = { time: new Date().toISOString(), event, detail };
    this.eventLog.push(entry);
    if (this.eventLog.length > 50) this.eventLog.shift();
    // Console log for troubleshooting connection events with timestamps
    console.log(`[${entry.time}] [LiveSensor] ${event}: ${detail}`);
  }

  connect(host, port, force = false) {
    const targetUrl = `ws://${host}:${port}`;
    if (!force && this.wantOpen && this.url === targetUrl && (this.state === CONN.CONNECTED || this.state === CONN.CONNECTING)) {
      this.logEvent('connect_ignored', `Already ${this.state} to ${targetUrl}`);
      return;
    }
    this.disconnect(true);
    this.host = host;
    this.port = port;
    this.url = targetUrl;
    this.wantOpen = true;
    this.everConnected = false;
    this.logEvent('connect_initiated', targetUrl);
    this._open();
  }

  disconnect(silent = false) {
    this.wantOpen = false;
    this._clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    this.logEvent('disconnected', silent ? 'silent' : 'explicit');
    if (!silent) this._set(CONN.DISCONNECTED, 'Not connected.');
  }

  _clearTimers() {
    for (const k of Object.keys(this._timers)) {
      if (this._timers[k]) {
        clearTimeout(this._timers[k]);
        clearInterval(this._timers[k]);
        this._timers[k] = null;
      }
    }
  }

  _set(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.logEvent(state, detail);
    if (this.h.onState) this.h.onState(state, detail);
  }

  _open() {
    this._clearTimers();
    // Clean up any stale socket reference completely before creating a new one
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.onopen = oldWs.onclose = oldWs.onmessage = oldWs.onerror = null;
      try { oldWs.close(); } catch { /* ignore */ }
    }

    this._set(CONN.CONNECTING, `Connecting to ${this.url}…`);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._lost(`Invalid address: ${e.message}`);
      return;
    }
    this.ws = ws;

    this._timers.connect = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) {
        ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
        try { ws.close(); } catch { /* ignore */ }
        this._lost('Connection attempt timed out.');
      }
    }, CONFIG.esp.connectTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this._timers.connect);
      this._timers.connect = null;
      this.everConnected = true;
      this.lastMsg = Date.now();
      this._set(CONN.CONNECTED, `Connected to ${this.url}. Waiting for sensor data…`);

      // Watchdog checks if messages stop arriving while in CONNECTED state
      this._timers.watchdog = setInterval(() => {
        if (this.ws === ws && this.state === CONN.CONNECTED && Date.now() - this.lastMsg > CONFIG.esp.staleMs) {
          const w = this.ws;
          this.ws = null;
          if (w) {
            w.onopen = w.onclose = w.onmessage = w.onerror = null;
            try { w.close(); } catch { /* ignore */ }
          }
          this._lost('No data received from the ESP8266 (connection lost).');
        }
      }, 1000);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsg = Date.now();
      const r = parseMessage(typeof ev.data === 'string' ? ev.data : '');
      if (r.kind === 'sample') {
        if (this.state !== CONN.CONNECTED) this._set(CONN.CONNECTED, 'Receiving sensor data.');
        this.rxCount++;
        if (this.h.onSample) this.h.onSample(r.sample);
      } else if (r.kind === 'hello' || r.kind === 'status') {
        if (r.sensor === 'error') {
          this._set(CONN.SENSOR_UNAVAILABLE, r.msg || 'MPU6050 not detected. Check wiring (SDA/SCL/3V3/GND).');
        } else if (this.state !== CONN.CONNECTED) {
          this._set(CONN.CONNECTED, 'Sensor OK. Receiving data.');
        }
      } else {
        this.invalidCount++;
        if (this.h.onInvalid) this.h.onInvalid(r.reason);
      }
    };

    ws.onerror = () => {
      // onclose fires immediately after onerror in standard WebSocket implementations
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._lost(this.everConnected ? 'The ESP8266 closed the connection.' : troubleshootingText(this.host, this.port));
    };
  }

  _lost(why) {
    this._clearTimers();
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      w.onopen = w.onclose = w.onmessage = w.onerror = null;
      try { w.close(); } catch { /* ignore */ }
    }
    if (this.h.onDisconnect) this.h.onDisconnect();

    if (this.wantOpen) {
      this._set(CONN.RECONNECTING, `${why} Reconnecting in ${Math.round(CONFIG.esp.reconnectMs / 1000)}s…`);
      // Single reconnection timer to avoid duplicate concurrent loops
      this._timers.reconnect = setTimeout(() => {
        this._timers.reconnect = null;
        if (this.wantOpen) this._open();
      }, CONFIG.esp.reconnectMs);
    } else {
      this._set(this.everConnected ? CONN.CONNECTION_LOST : CONN.DISCONNECTED, why);
    }
  }
}
