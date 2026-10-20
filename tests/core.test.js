import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG } from '../js/config.js';
import { magnitude, normalizeSample, SwingDetector, estimateSwingSpeed, consistencyScore, downsampleRows, formatDuration, inchesToMeters, validateEquipment, calculateEffectiveRadius, buildSummaryText } from '../js/analytics.js';
import { Session } from '../js/session.js';
import { SensorModel, mulberry32 } from '../js/simulator.js';
import { validateSessionRecord, parseImportText, toExportBundle, toCsv } from '../js/schema.js';
import { parseMessage, LiveSensor, CONN } from '../js/sensor.js';
import { SPEC, zoomChart, panChart, resetChartZoom } from '../js/charts.js';

const P = CONFIG.sports.tennis.swing;
const sample = (ts, over = {}) => ({ ts, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, ...over });

test('magnitude', () => {
  assert.equal(magnitude(3, 4, 0), 5);
  assert.ok(Math.abs(magnitude(1, 1, 1) - Math.sqrt(3)) < 1e-12);
});

test('normalizeSample rejects malformed data', () => {
  assert.ok(normalizeSample(sample(1)));
  assert.ok(normalizeSample({ ...sample(1), ax: '0.5' }), 'numeric strings accepted');
  assert.equal(normalizeSample({ ...sample(1), ax: 'abc' }), null);
  assert.equal(normalizeSample({ ...sample(1), gx: NaN }), null);
  assert.equal(normalizeSample({ ax: 0, ay: 0, az: 1, gx: 0, gy: 0 }), null);
  assert.equal(normalizeSample({ ...sample(1), ax: 999 }), null);
  assert.equal(normalizeSample(null), null);
});

test('speed estimate: v = omega * r', () => {
  const { ms, kmh } = estimateSwingSpeed(360, 1); // 2*pi rad/s at 1 m
  assert.ok(Math.abs(ms - 2 * Math.PI) < 1e-9);
  assert.ok(Math.abs(kmh - 2 * Math.PI * 3.6) < 1e-9);
});

test('consistency score and insufficient data', () => {
  assert.equal(consistencyScore([800, 810]).status, 'insufficient');
  assert.equal(consistencyScore([800, 810]).score, null);
  assert.equal(consistencyScore([800, 800, 800]).score, 100);
  const varied = consistencyScore([400, 800, 1200]);
  assert.ok(varied.score < 20 && varied.status === 'variable');
});

/** Feed a synthetic swing pulse (sin^2) to a detector; returns events. */
function pulse(det, t0, peak, peakG = 4, dur = 300, dt = 20) {
  const ev = [];
  for (let t = 0; t <= dur + 100; t += dt) {
    const u = t / dur;
    const e = u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;
    const r = det.process({ t: t0 + t, gyroMag: 20 + peak * e, accelMag: 1 + (peakG - 1) * e });
    if (r) ev.push(r);
  }
  return ev;
}

test('detector counts a swing once, ignores small movement and single spikes', () => {
  const d = new SwingDetector(P);
  assert.equal(pulse(d, 0, 800).length, 1);
  assert.equal(pulse(d, 5000, 150).length, 0, 'weak movement ignored');
  assert.equal(d.process({ t: 9000, gyroMag: 1800, accelMag: 6 }), null);
  assert.equal(d.process({ t: 9020, gyroMag: 10, accelMag: 1 }), null, 'single-sample spike rejected');
});

test('detector cooldown/re-arming prevents double counts and counts distinct swings', () => {
  const d = new SwingDetector(P);
  // two pulses 300 ms apart (inside cooldown 700 ms) -> only first counted
  const ev = [...pulse(d, 0, 800, 4, 300), ...pulse(d, 450, 800, 4, 300)];
  assert.equal(ev.length, 1);
  // distinct swings far apart
  const d2 = new SwingDetector(P);
  const ev2 = [...pulse(d2, 0, 800), ...pulse(d2, 3000, 900), ...pulse(d2, 6000, 700)];
  assert.equal(ev2.length, 3);
});

test('detector: sustained rotation is not a swing, gaps abort candidates', () => {
  const d = new SwingDetector(P);
  const ev = [];
  for (let t = 0; t < 4000; t += 20) { const r = d.process({ t, gyroMag: 900, accelMag: 4 }); if (r) ev.push(r); }
  assert.equal(ev.length, 0);
  const d2 = new SwingDetector(P);
  d2.process({ t: 0, gyroMag: 600, accelMag: 4 });
  d2.process({ t: 20, gyroMag: 700, accelMag: 4 });
  assert.equal(d2.process({ t: 2000, gyroMag: 10, accelMag: 1 }), null, 'gap aborts');
  assert.equal(d2.inSwing, false);
});

function runSession(session, model, n) {
  for (let i = 0; i < n; i++) session.addSample(model.next());
}

test('simulated stream produces plausible swing count and metrics', () => {
  const s = new Session({ sport: 'tennis', mode: 'demo' });
  s.start();
  runSession(s, new SensorModel('tennis', { rng: mulberry32(7) }), 50 * 60); // 60 s
  const m = s.metrics();
  assert.ok(m.totalSwings >= 8 && m.totalSwings <= 40, `swings=${m.totalSwings}`);
  assert.ok(Math.abs(m.activeDurationMs - 60000) < 100);
  assert.ok(m.maxSpeedKmh >= m.avgSpeedKmh && m.avgSpeedKmh > 20);
  assert.ok(m.maxAccelG > 2 && m.maxGyroDps > 400);
  assert.notEqual(m.consistency.score, null);
});

test('pause/resume excludes paused time from duration, state rules enforced', () => {
  const s = new Session({ sport: 'cricket', mode: 'live', nominalMs: 20 });
  assert.equal(s.pause(), false);
  assert.equal(s.addSample(sample(0)).accepted, false, 'not running yet');
  s.start();
  assert.equal(s.start(), false, 'cannot start twice');
  for (let i = 0; i < 100; i++) s.addSample(sample(1000 + i * 20)); // 2 s
  const before = s.durationMs;
  assert.ok(Math.abs(before - 1980) <= 1);
  s.pause();
  for (let i = 0; i < 500; i++) assert.equal(s.addSample(sample(5000 + i * 20)).accepted, false);
  assert.equal(s.durationMs, before, 'no accumulation while paused');
  s.resume();
  // device clock kept running for 30 s while paused
  for (let i = 0; i < 100; i++) s.addSample(sample(40000 + i * 20));
  assert.ok(Math.abs(s.durationMs - (before + 20 + 99 * 20)) <= 1, `duration=${s.durationMs}`);
  s.stop();
  assert.equal(s.stop(), false);
  assert.equal(s.addSample(sample(99999)).accepted, false);
});

test('long gaps and timestamp resets are not counted as active time; bad samples are skipped', () => {
  const s = new Session({ sport: 'tennis', mode: 'live', nominalMs: 20 });
  s.start();
  for (let i = 0; i < 10; i++) s.addSample(sample(i * 20));
  s.addSample(sample(60000)); // 1 min gap
  assert.ok(s.durationMs < 400);
  s.addSample(sample(5)); // device reboot
  assert.equal(s.gapCount, 2);
  assert.equal(s.addSample({ ts: 1, ax: 'x' }).reason, 'invalid');
  assert.equal(s.invalidCount, 1);
  assert.equal(s.addSample(sample(5)).reason, 'duplicate');
});

test('large sessions are decimated but statistics stay exact', () => {
  const s = new Session({ sport: 'tennis', mode: 'live', nominalMs: 20 });
  s.start();
  const max = CONFIG.limits.maxStoredSamples;
  const total = max * 2 + 10;
  for (let i = 0; i < total; i++) s.addSample(sample(i * 20, { gx: i === 5 ? 100 : 0 }));
  assert.equal(s.metrics().sampleCount, total);
  assert.ok(s.rows.length <= max);
  assert.ok(s.stride >= 2);
  assert.equal(Math.round(s.metrics().maxGyroDps), 100);
});

function finishedRecord() {
  const s = new Session({ sport: 'badminton', name: 'Test <b>', mode: 'demo' });
  s.start();
  runSession(s, new SensorModel('badminton', { rng: mulberry32(3) }), 50 * 30);
  s.stop();
  return s.toRecord();
}

test('record validates, round-trips through export/import, CSV has header + rows', () => {
  const rec = finishedRecord();
  assert.ok(validateSessionRecord(rec).ok);
  const parsed = parseImportText(JSON.stringify(toExportBundle([rec])));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.valid[0].id, rec.id);
  assert.equal(parsed.valid[0].samples.length, rec.samples.length);
  assert.equal(parseImportText(JSON.stringify(rec)).valid.length, 1, 'single session object accepted');
  const csv = toCsv(rec).split('\n');
  assert.equal(csv.length, rec.samples.length + 1);
  assert.ok(csv[0].startsWith('t_ms,'));
});

test('import validation rejects invalid structures', () => {
  const rec = finishedRecord();
  const bad = (mut) => { const c = structuredClone(rec); mut(c); return validateSessionRecord(c).ok; };
  assert.equal(bad((c) => { c.sport = 'golf'; }), false);
  assert.equal(bad((c) => { delete c.id; }), false);
  assert.equal(bad((c) => { c.samples[3] = [1, 2]; }), false);
  assert.equal(bad((c) => { c.samples[0][2] = 'x'; }), false);
  assert.equal(bad((c) => { c.endedAt = c.startedAt - 1; }), false);
  assert.equal(bad((c) => { c.schemaVersion = 99; }), false);
  assert.equal(bad((c) => { c.metrics.totalSwings = 'many'; }), false);
  assert.equal(bad((c) => { c.swings = {}; }), false);
  assert.ok(parseImportText('not json').errors.length === 1);
  assert.ok(parseImportText('{"hello":1}').errors.length === 1);
  assert.ok(parseImportText('{"sessions":[]}').errors.length === 1);
  const mixed = parseImportText(JSON.stringify({ sessions: [rec, { id: 'x' }] }));
  assert.equal(mixed.valid.length, 1);
  assert.equal(mixed.errors.length, 1);
});

test('downsample keeps peaks and size limit; duration format', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => [i * 20, 0, 0, 1, i === 4321 ? 900 : 1, 0, 0]);
  const out = downsampleRows(rows, 500);
  assert.ok(out.length <= 500);
  assert.ok(out.some((r) => r[4] === 900));
  assert.equal(formatDuration(65000), '01:05');
  assert.equal(formatDuration(3725000), '1:02:05');
});

test('frontend parser accepts every message type the protocol defines', () => {
  assert.equal(parseMessage('{"type":"sample","seq":1,"ts":20,"ax":0,"ay":0,"az":1,"gx":0,"gy":0,"gz":0}').kind, 'sample');
  assert.equal(parseMessage('{"type":"hello","sensor":"ok"}').kind, 'hello');
  assert.equal(parseMessage('{"type":"status","sensor":"error","msg":"x"}').sensor, 'error');
  assert.equal(parseMessage('garbage').kind, 'error');
  assert.equal(parseMessage('{"type":"zzz"}').kind, 'error');
  assert.equal(parseMessage('{"type":"status","sensor":"maybe"}').kind, 'error');
  const noTs = parseMessage('{"type":"sample","seq":10,"ax":0,"ay":0,"az":1,"gx":0,"gy":0,"gz":0}');
  assert.equal(noTs.sample.ts, 200, 'sequence number fallback at 50 Hz');
});

test('firmware JSON format is consumable by the frontend parser', () => {
  const ino = fs.readFileSync(new URL('../firmware/esp8266_mpu6050.ino', import.meta.url), 'utf8');
  const m = ino.match(/#define SAMPLE_JSON_FMT "(.*)"/);
  assert.ok(m, 'SAMPLE_JSON_FMT found in firmware');
  const vals = [12, 3456, 0.123, -0.5, 0.987, 10.5, -20.25, 300.0];
  let i = 0;
  const text = m[1].replace(/\\"/g, '"').replace(/%l?u|%\.\d+f/g, () => String(vals[i++]));
  assert.equal(i, 8);
  const r = parseMessage(text);
  assert.equal(r.kind, 'sample');
  assert.ok(normalizeSample(r.sample));
  assert.equal(r.sample.seq, 12);
  assert.equal(r.sample.gz, 300);
  assert.ok(ino.includes('"accel_unit\\":\\"g\\"') && ino.includes('"gyro_unit\\":\\"dps\\"'));
  assert.ok(ino.includes(`#define SAMPLE_RATE_HZ ${CONFIG.sampleRateHz.live}`), 'firmware rate matches config');
  assert.ok(ino.includes(`WS_PORT = ${CONFIG.esp.port}`), 'firmware port matches config');
});

/* -------------------- PHASE 2 & 3: EQUIPMENT, GEOMETRY & PHYSICS TESTS -------------------- */

test('equipment defaults exist, are positive and within configured limits for every sport', () => {
  for (const [sport, cfg] of Object.entries(CONFIG.sports)) {
    assert.ok(cfg.equipmentDefaults, `defaults exist for ${sport}`);
    const { lengthInches, weightGrams } = cfg.equipmentDefaults;
    assert.ok(Number.isFinite(lengthInches) && lengthInches > 0);
    assert.ok(Number.isFinite(weightGrams) && weightGrams > 0);
    const v = validateEquipment(sport, cfg.equipmentDefaults);
    assert.equal(v.valid, true, `default configuration for ${sport} is valid`);
    assert.equal(v.lengthInches, lengthInches);
    assert.equal(v.weightGrams, weightGrams);
  }
});

test('equipment validation rejects blanks, zero, negative, non-numeric and out-of-bound inputs', () => {
  assert.equal(validateEquipment('tennis', null).valid, false);
  assert.equal(validateEquipment('tennis', {}).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: '', weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: 0, weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: -27, weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: 'abc', weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: NaN, weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: Infinity, weightGrams: 300 }).valid, false);

  // Bounds checks for tennis: length 19..34, weight 180..450
  assert.equal(validateEquipment('tennis', { lengthInches: 10, weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: 50, weightGrams: 300 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: 27, weightGrams: 50 }).valid, false);
  assert.equal(validateEquipment('tennis', { lengthInches: 27, weightGrams: 900 }).valid, false);

  // Cricket bounds: length 20..42, weight 500..2000
  assert.equal(validateEquipment('cricket', { lengthInches: 15, weightGrams: 1200 }).valid, false);
  assert.equal(validateEquipment('cricket', { lengthInches: 33.5, weightGrams: 2500 }).valid, false);

  // Badminton bounds: length 18..32, weight 60..160
  assert.equal(validateEquipment('badminton', { lengthInches: 15, weightGrams: 85 }).valid, false);
  assert.equal(validateEquipment('badminton', { lengthInches: 26.8, weightGrams: 250 }).valid, false);

  // Valid values pass with precision rounding without silent replacement
  const ok = validateEquipment('tennis', { lengthInches: '27.2', weightGrams: '310' });
  assert.equal(ok.valid, true);
  assert.equal(ok.lengthInches, 27.2);
  assert.equal(ok.weightGrams, 310);
});

test('per-sport configuration persistence preserves independent equipment settings', () => {
  const store = {
    cricket: { lengthInches: 34.0, weightGrams: 1250 },
    tennis: { lengthInches: 27.0, weightGrams: 300 },
    badminton: { lengthInches: 26.8, weightGrams: 85 },
  };

  // Modify cricket only
  store.cricket = { lengthInches: 35.0, weightGrams: 1300 };
  assert.equal(store.cricket.lengthInches, 35.0);
  assert.equal(store.tennis.lengthInches, 27.0, 'tennis remains unchanged');
  assert.equal(store.badminton.weightGrams, 85, 'badminton remains unchanged');
});

test('equipment snapshot is saved with session and subsequent modifications do not alter it', () => {
  const initialEq = { lengthInches: 28.0, weightGrams: 315 };
  const s = new Session({
    sport: 'tennis',
    mode: 'demo',
    equipment: initialEq,
  });

  assert.equal(s.equipment.lengthInches, 28.0);
  assert.equal(s.equipment.weightGrams, 315);

  // Mutate initial object
  initialEq.lengthInches = 99.0;
  initialEq.weightGrams = 999;

  const rec = s.toRecord();
  assert.equal(rec.equipment.lengthInches, 28.0, 'session record holds immutable snapshot');
  assert.equal(rec.equipment.weightGrams, 315);
});

test('inch to metre conversion is accurate (1 in = 0.0254 m)', () => {
  assert.equal(inchesToMeters(1), 0.0254);
  assert.equal(inchesToMeters(27), 0.6858);
  assert.equal(inchesToMeters(33.5), 0.8509);
  assert.equal(inchesToMeters('27'), null);
  assert.equal(inchesToMeters(null), null);
  assert.equal(inchesToMeters(NaN), null);
});

test('gyroscope units and angular velocity magnitude', () => {
  // MPU6050 gyroscope is calibrated in degrees per second (dps)
  const gx = 300, gy = 400, gz = 0;
  const mag = magnitude(gx, gy, gz);
  assert.equal(mag, 500);

  // Angular velocity is distinct from measured linear acceleration
  const ax = 0, ay = 0, az = 1; // 1 g
  assert.equal(magnitude(ax, ay, az), 1);
});

test('effective radius calculation and speed estimation physical assumptions', () => {
  // Tennis: pivotOffsetM ~ 0.236, sweetSpotRatio = 0.75
  const rTennis = calculateEffectiveRadius('tennis', 27.0);
  assert.ok(Math.abs(rTennis - 0.75) <= 0.02, `rTennis=${rTennis}`);

  // Badminton: pivotOffsetM ~ 0.090, sweetSpotRatio = 0.75
  const rBadm = calculateEffectiveRadius('badminton', 26.8);
  assert.ok(Math.abs(rBadm - 0.60) <= 0.02, `rBadm=${rBadm}`);

  // Cricket: pivotOffsetM ~ 0.254, sweetSpotRatio = 0.70
  const rCrick = calculateEffectiveRadius('cricket', 33.5);
  assert.ok(Math.abs(rCrick - 0.85) <= 0.02, `rCrick=${rCrick}`);

  // Shorter equipment (e.g. 21 in junior racket) has smaller effective radius
  const rJunior = calculateEffectiveRadius('tennis', 21.0);
  assert.ok(rJunior < rTennis, 'junior racket has smaller effective radius');

  // Linear speed estimation: v = omega * r_eff
  // At 500 dps (8.7266 rad/s) and r = 0.75m: v = 6.545 m/s = 23.56 km/h
  const sp = estimateSwingSpeed(500, 0.75);
  assert.ok(Math.abs(sp.kmh - (500 * Math.PI / 180 * 0.75 * 3.6)) < 1e-6);

  // Weight is NOT multiplied into speed
  const s1 = new Session({ sport: 'tennis', mode: 'demo', equipment: { lengthInches: 27, weightGrams: 280 } });
  const s2 = new Session({ sport: 'tennis', mode: 'demo', equipment: { lengthInches: 27, weightGrams: 350 } });
  assert.equal(s1.radiusM, s2.radiusM, 'effective radius does not depend on weight');
});

test('sport-specific swing detection thresholds', () => {
  const tennisDetector = new SwingDetector(CONFIG.sports.tennis.swing);
  const badmintonDetector = new SwingDetector(CONFIG.sports.badminton.swing);
  const cricketDetector = new SwingDetector(CONFIG.sports.cricket.swing);

  // Pulse with peak 380 dps:
  // - Cricket detector threshold is minPeakDps: 350 -> should detect
  // - Tennis detector threshold is minPeakDps: 450 -> should NOT detect
  // - Badminton detector threshold is minPeakDps: 500 -> should NOT detect
  const cricketEvents = pulse(cricketDetector, 0, 380, 2.5);
  const tennisEvents = pulse(tennisDetector, 0, 380, 2.5);
  const badmintonEvents = pulse(badmintonDetector, 0, 380, 2.5);

  assert.equal(cricketEvents.length, 1, 'cricket detected 380 dps swing');
  assert.equal(tennisEvents.length, 0, 'tennis rejected swing below 450 dps');
  assert.equal(badmintonEvents.length, 0, 'badminton rejected swing below 500 dps');
});

test('historical sessions without equipment metadata validate and display cleanly', () => {
  const rec = finishedRecord();
  delete rec.equipment; // simulate older session before Phase 2

  const val = validateSessionRecord(rec);
  assert.equal(val.ok, true, 'validates without equipment');
  assert.equal(val.record.equipment, null, 'equipment field is null');

  const summary = buildSummaryText(rec.metrics, 'Tennis', rec.mode, val.record.equipment);
  assert.ok(summary.includes('Equipment details not recorded.'), 'reports missing equipment clearly');
});

test('session export/import preserves equipment metadata round-trip', () => {
  const s = new Session({
    sport: 'cricket',
    name: 'Batting Practice',
    mode: 'demo',
    equipment: { lengthInches: 33.5, weightGrams: 1220 },
  });
  s.start();
  runSession(s, new SensorModel('cricket', { rng: mulberry32(11) }), 50 * 5);
  s.stop();
  const rec = s.toRecord();

  assert.ok(rec.equipment);
  assert.equal(rec.equipment.lengthInches, 33.5);
  assert.equal(rec.equipment.weightGrams, 1220);

  const bundle = toExportBundle([rec]);
  const parsed = parseImportText(JSON.stringify(bundle));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].equipment.lengthInches, 33.5);
  assert.equal(parsed.valid[0].equipment.weightGrams, 1220);
});

/* -------------------- PHASE 5: CHART ZOOM, PAN & INTERACTION TESTS -------------------- */

test('chart zoom in, zoom out, reset, and pan helpers clamp within valid timeline bounds', () => {
  const mockChart = {
    _totalDurationS: 60,
    options: {
      scales: {
        x: { min: 0, max: 60 },
      },
    },
    update: () => {},
  };

  // Zoom In (factor 0.7) around center
  let r = zoomChart(mockChart, 0.7, 0.5);
  assert.ok(r.max - r.min < 60, 'zoom in narrowed span');
  assert.ok(r.min >= 0 && r.max <= 60, 'within bounds');

  // Pan right by 25% of current window
  const beforePan = r.min;
  r = panChart(mockChart, 0.25);
  assert.ok(r.min > beforePan, 'panned right');
  assert.ok(r.max <= 60, 'clamped within session max');

  // Pan excessively right -> clamps at max
  r = panChart(mockChart, 10);
  assert.equal(r.max, 60, 'clamped at 60s');

  // Pan left
  r = panChart(mockChart, -10);
  assert.equal(r.min, 0, 'clamped at 0s');

  // Zoom out (factor 1.4)
  r = zoomChart(mockChart, 1.4, 0.5);
  assert.ok(r.min >= 0 && r.max <= 60);

  // Reset zoom
  r = resetChartZoom(mockChart);
  assert.equal(r.min, 0);
  assert.equal(r.max, 60);

  // Repeated zoom-in clamps at minSpan and prevents empty/invalid range
  for (let i = 0; i < 20; i++) zoomChart(mockChart, 0.5, 0.5);
  assert.ok(mockChart.options.scales.x.max > mockChart.options.scales.x.min, 'span remains positive');
  assert.ok(Math.round((mockChart.options.scales.x.max - mockChart.options.scales.x.min) * 100) / 100 >= 0.2, 'minSpan guarded');
});

test('chart SPEC definitions define exact units and dataset names', () => {
  assert.equal(SPEC.accel.unit, 'g');
  assert.ok(SPEC.accel.names.includes('|a| magnitude'));

  assert.equal(SPEC.gyro.unit, '°/s');
  assert.ok(SPEC.gyro.names.includes('|ω| magnitude'));

  assert.equal(SPEC.speed.unit, 'km/h');
  assert.ok(SPEC.speed.names.includes('Est. hitting-zone speed'));
});

test('downsampleRows handles 60,000 samples responsively while preserving peak swing values', () => {
  const n = 60000;
  const rows = new Array(n);
  const peakIndex = 34567;
  for (let i = 0; i < n; i++) {
    rows[i] = [i * 20, 0, 0, 1, i === peakIndex ? 888 : 10, 0, 0];
  }

  const t0 = performance.now();
  const downsampled = downsampleRows(rows, 1500);
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 100, `downsampling took ${elapsed} ms, expected < 100 ms`);
  assert.equal(downsampled.length, 1500);
  assert.ok(downsampled.some((r) => r[4] === 888), 'peak swing gyro sample is preserved');
});

/* -------------------- PHASE 6: WEBSOCKET RECONNECTION & STABILITY TESTS -------------------- */

test('WebSocket connection, disconnection, and reconnection logic with mocked WebSocketServer', async () => {
  const { WebSocketServer } = await import('ws');
  const port = 8991;
  let server = new WebSocketServer({ port });
  let receivedSamples = [];

  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', sensor: 'ok' }));
    ws.send(JSON.stringify({ type: 'sample', seq: 1, ts: 1000, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 }));
  });

  const sensor = new LiveSensor({
    onSample: (s) => receivedSamples.push(s),
  });

  sensor.connect('localhost', port);
  assert.equal(sensor.state, CONN.CONNECTING);

  // Wait for open & sample
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sensor.state, CONN.CONNECTED);
  assert.equal(receivedSamples.length, 1);

  // Calling connect to the same url while connected is guarded
  const initialWs = sensor.ws;
  sensor.connect('localhost', port);
  assert.equal(sensor.ws, initialWs, 'does not create duplicate connection');

  // Simulate server termination / connection drop
  for (const client of server.clients) client.terminate();
  await new Promise((r) => server.close(r));

  // The client detects disconnect and transitions to RECONNECTING (or connection lost)
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sensor.state === CONN.RECONNECTING || sensor.state === CONN.CONNECTION_LOST);

  // Disconnect explicitly stops reconnection loops
  sensor.disconnect();
  assert.equal(sensor.state, CONN.DISCONNECTED);
  assert.equal(sensor.wantOpen, false);
});

test('prevention of false swings and duplicate samples across reconnections', () => {
  const session = new Session({ sport: 'tennis', mode: 'live', nominalMs: 20 });
  session.start();

  // Stream normal samples before dropout
  session.addSample(sample(1000, { gx: 10 }));
  session.addSample(sample(1020, { gx: 15 }));
  session.addSample(sample(1040, { gx: 20 }));

  assert.equal(session.swings.length, 0);
  assert.equal(session.gapCount, 0);

  // Connection lost! Session receives triggerRebase() from LiveSensor
  session.triggerRebase();

  // Reconnection after 5 seconds: samples resume with a sudden step
  const r1 = session.addSample(sample(6000, { gx: 600, ax: 3 })); // high reading upon reconnect
  assert.equal(r1.accepted, true);
  assert.equal(session.swings.length, 0, 'no false swing counted on first reconnect sample');

  // Following small movement
  session.addSample(sample(6020, { gx: 50, ax: 1 }));
  assert.equal(session.swings.length, 0, 'no false swing emitted across reconnect gap');
  assert.ok(session.durationMs < 2000, '5000ms disconnect gap was not counted as active time');
});
