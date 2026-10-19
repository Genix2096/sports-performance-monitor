import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG } from '../js/config.js';
import { magnitude, normalizeSample, SwingDetector, estimateSwingSpeed, consistencyScore, downsampleRows, formatDuration } from '../js/analytics.js';
import { Session } from '../js/session.js';
import { SensorModel, mulberry32 } from '../js/simulator.js';
import { validateSessionRecord, parseImportText, toExportBundle, toCsv } from '../js/schema.js';
import { parseMessage } from '../js/sensor.js';

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
