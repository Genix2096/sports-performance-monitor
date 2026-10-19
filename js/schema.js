/**
 * Session record schema validation + CSV/JSON export helpers (pure, Node-testable).
 */
import { CONFIG, SPORT_IDS } from './config.js';
import { SCHEMA_VERSION } from './session.js';
import { magnitude } from './analytics.js';

export const EXPORT_FORMAT = 'sports-performance-monitor';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (v === null || v === undefined ? null : isNum(v) ? v : undefined);

/** @returns {{ok:true, record:object} | {ok:false, error:string}} */
export function validateSessionRecord(obj) {
  const fail = (error) => ({ ok: false, error });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('Session is not an object');
  if (obj.schemaVersion !== SCHEMA_VERSION) return fail(`Unsupported schemaVersion (${obj.schemaVersion}), expected ${SCHEMA_VERSION}`);
  if (typeof obj.id !== 'string' || !obj.id.trim() || obj.id.length > 100) return fail('Missing or invalid id');
  if (!SPORT_IDS.includes(obj.sport)) return fail(`Invalid sport "${obj.sport}"`);
  if (obj.mode !== 'demo' && obj.mode !== 'live') return fail('Invalid mode (must be "demo" or "live")');
  if (!isNum(obj.startedAt) || !isNum(obj.endedAt) || obj.endedAt < obj.startedAt) return fail('Invalid start/end timestamps');
  if (!isNum(obj.activeDurationMs) || obj.activeDurationMs < 0) return fail('Invalid activeDurationMs');

  const m = obj.metrics;
  if (!m || typeof m !== 'object') return fail('Missing metrics');
  const required = ['totalSwings', 'activeDurationMs', 'sampleCount', 'swingsPerMinute'];
  for (const k of required) if (!isNum(m[k]) || m[k] < 0) return fail(`Invalid metrics.${k}`);
  const nullable = ['avgSpeedKmh', 'maxSpeedKmh', 'avgPeakGyroDps', 'avgGyroDps', 'maxGyroDps', 'avgAccelG', 'maxAccelG'];
  const metrics = {};
  for (const k of required) metrics[k] = m[k];
  for (const k of nullable) {
    const v = numOrNull(m[k]);
    if (v === undefined) return fail(`Invalid metrics.${k}`);
    metrics[k] = v;
  }
  const c = m.consistency;
  if (!c || typeof c !== 'object' || !['insufficient', 'high', 'moderate', 'variable'].includes(c.status)) return fail('Invalid metrics.consistency');
  if (numOrNull(c.score) === undefined || numOrNull(c.cv) === undefined) return fail('Invalid metrics.consistency values');
  metrics.consistency = { score: c.score ?? null, cv: c.cv ?? null, status: c.status, n: isNum(c.n) ? c.n : 0 };

  if (!Array.isArray(obj.swings)) return fail('swings must be an array');
  const swings = [];
  for (const s of obj.swings) {
    if (!s || !['t', 'durationMs', 'peakDps', 'peakG', 'speedMs', 'speedKmh'].every((k) => isNum(s[k]))) return fail('Invalid swing entry');
    swings.push({ t: s.t, durationMs: s.durationMs, peakDps: s.peakDps, peakG: s.peakG, speedMs: s.speedMs, speedKmh: s.speedKmh });
  }

  if (!Array.isArray(obj.samples)) return fail('samples must be an array');
  if (obj.samples.length > CONFIG.limits.maxImportSamples) return fail('Too many samples');
  const samples = new Array(obj.samples.length);
  for (let i = 0; i < obj.samples.length; i++) {
    const r = obj.samples[i];
    if (!Array.isArray(r) || r.length !== 7 || !r.every(isNum)) return fail(`Invalid sample row at index ${i}`);
    samples[i] = r.slice();
  }

  const swingSettings = obj.settings && obj.settings.swing && typeof obj.settings.swing === 'object' ? obj.settings.swing : {};
  const cleanSwing = {};
  for (const [k, v] of Object.entries(swingSettings)) if (isNum(v)) cleanSwing[k] = v;

  return {
    ok: true,
    record: {
      schemaVersion: SCHEMA_VERSION,
      id: obj.id.trim(),
      sport: obj.sport,
      name: typeof obj.name === 'string' ? obj.name.slice(0, 120) : '',
      mode: obj.mode,
      simulated: obj.mode === 'demo',
      startedAt: obj.startedAt,
      endedAt: obj.endedAt,
      activeDurationMs: obj.activeDurationMs,
      storedStride: isNum(obj.storedStride) && obj.storedStride >= 1 ? obj.storedStride : 1,
      invalidSamples: isNum(obj.invalidSamples) ? obj.invalidSamples : 0,
      timeGaps: isNum(obj.timeGaps) ? obj.timeGaps : 0,
      settings: { radiusM: isNum(obj.settings?.radiusM) ? obj.settings.radiusM : CONFIG.sports[obj.sport].radiusM, swing: cleanSwing },
      metrics,
      swings,
      samples,
    },
  };
}

/** Parse an exported/imported file. Accepts a bundle {sessions:[...]} or a single session object. */
export function parseImportText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { valid: [], errors: ['File is not valid JSON'] };
  }
  const list = Array.isArray(data?.sessions) ? data.sessions : data && typeof data === 'object' && !Array.isArray(data) && data.id ? [data] : null;
  if (!list) return { valid: [], errors: ['File does not contain any sessions (expected a "sessions" array or a session object)'] };
  if (list.length === 0) return { valid: [], errors: ['File contains no sessions'] };
  const valid = [];
  const errors = [];
  list.forEach((s, i) => {
    const r = validateSessionRecord(s);
    if (r.ok) valid.push(r.record);
    else errors.push(`Session ${i + 1}: ${r.error}`);
  });
  return { valid, errors };
}

export function toExportBundle(records) {
  return { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), sessions: records };
}

export function toCsv(record) {
  const lines = ['t_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,accel_mag_g,gyro_mag_dps'];
  for (const r of record.samples) {
    lines.push([...r, magnitude(r[1], r[2], r[3]).toFixed(3), magnitude(r[4], r[5], r[6]).toFixed(2)].join(','));
  }
  return lines.join('\n');
}
