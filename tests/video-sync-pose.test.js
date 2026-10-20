import test from 'node:test';
import assert from 'node:assert/strict';
import { SensorClockMap, RecordingTimeline, sensorTimeToVideo, videoToSensorTime, mapSwingsToVideo, sanitizePadding, replayWindow, estimateUncertainty, SYNC_STATUS } from '../js/sync.js';
import { calculateJointAngle, calculateLineTilt, calculateTorsoInclination, evaluateLighting, extractPoseIndicators, DISCLAIMER_TEXT } from '../js/pose-math.js';
import { MediaStore } from '../js/media-store.js';
import { VideoRecorder, REC_STATE, cameraSupport, describeCameraError, pickMimeType } from '../js/recorder.js';
import { validateSessionRecord, toExportBundle, parseImportText } from '../js/schema.js';
import { alignCanvasToVideo } from '../js/pose.js';

/* -------------------------------------------------------------------------- */
/*                              SYNC & CLOCK MAP                              */
/* -------------------------------------------------------------------------- */

test('SensorClockMap: lower-envelope offset filters network jitter spikes', () => {
  const map = new SensorClockMap({ windowMs: 2000 });
  
  // Baseline arrival: offset = arrivalPerf - sensorT = 1000 - 100 = 900 ms
  map.add(100, 1000, 0);
  assert.equal(map.sensorToPerf(100).perf, 1000);

  // Normal progression (20ms intervals)
  map.add(120, 1020, 0);
  map.add(140, 1040, 0);

  // Latency spike: packet delayed by 50ms (arrives at 1110 instead of 1060)
  map.add(160, 1110, 0);

  // Lower envelope should maintain estimated offset ~900ms, not 950ms
  const estimated = map.sensorToPerf(160);
  assert.ok(Math.abs(estimated.perf - 1060) < 5, `Expected ~1060ms, got ${estimated.perf}`);

  // Reverse mapping
  const backToSensor = map.perfToSensor(1060);
  assert.ok(Math.abs(backToSensor - 160) < 5, `Expected ~160ms, got ${backToSensor}`);
});

test('SensorClockMap: segment tracking re-anchors across sensor reboot/reconnection', () => {
  const map = new SensorClockMap();

  // Segment 0: sensor boots, streams up to 1000ms
  map.add(500, 2000, 0);
  map.add(1000, 2500, 0);
  assert.equal(map.sensorToPerf(500).perf, 2000);

  // Segment 1: ESP8266 reboots, sensor millis() resets to 0, arrives at perf=6000
  map.add(50, 6050, 1);
  map.add(100, 6100, 1);

  // Segment 0 and Segment 1 maintain independent clock references
  assert.equal(map.sensorToPerf(1000).perf, 2500);
  assert.equal(map.sensorToPerf(100).perf, 6100);
});

test('SensorClockMap: serialization round-trip via toJSON and fromJSON', () => {
  const original = new SensorClockMap({ windowMs: 1500 });
  original.add(100, 500, 0);
  original.add(200, 600, 0);
  original.add(50, 2000, 1);

  const json = original.toJSON();
  const restored = SensorClockMap.fromJSON(json);

  assert.equal(restored.sensorToPerf(200).perf, original.sensorToPerf(200).perf);
  assert.equal(restored.sensorToPerf(50).perf, original.sensorToPerf(50).perf);
});

test('RecordingTimeline: pause and resume time intervals', () => {
  const timeline = new RecordingTimeline();

  // Started recording at perf = 1000
  timeline.start(1000);
  assert.equal(timeline.durationS(2000), 1.0);

  // Paused at perf = 3000 (recorded 2s)
  timeline.pause(3000);
  assert.equal(timeline.durationS(4000), 2.0); // time while paused is not counted

  // Resumed at perf = 5000
  timeline.resume(5000);
  // Stopped at perf = 7000 (another 2s recorded)
  timeline.stop(7000);

  assert.equal(timeline.durationS(7000), 4.0);

  // Map perf timestamps to video seconds:
  // perf 2000 -> 1s into video
  assert.equal(timeline.perfToVideo(2000).videoS, 1.0);
  assert.equal(timeline.perfToVideo(2000).status, SYNC_STATUS.OK);

  // perf 4000 was during pause
  const pausedQuery = timeline.perfToVideo(4000);
  assert.equal(pausedQuery.status, SYNC_STATUS.GAP);
  assert.equal(pausedQuery.videoS, 2.0);

  // perf 6000 -> 2s (first segment) + 1s (into second segment) = 3s
  const resumedQuery = timeline.perfToVideo(6000);
  assert.equal(resumedQuery.status, SYNC_STATUS.OK);
  assert.equal(resumedQuery.videoS, 3.0);

  // Reverse mapping: video 3.0s -> perf 6000
  assert.equal(timeline.videoToPerf(3.0), 6000);
});

test('sensorTimeToVideo and calibration offset calculation', () => {
  const map = new SensorClockMap({ windowMs: 5000, toleranceMs: 500 });
  map.add(100, 1000, 0);
  map.add(600, 1500, 0); // sensor 600ms == perf 1500ms

  const timeline = new RecordingTimeline();
  timeline.start(500); // recording started at perf 500ms
  timeline.stop(3000);

  // Swing at sensor t = 600ms -> perf = 1500ms -> video = (1500 - 500)/1000 = 1.0s
  const res1 = sensorTimeToVideo(600, map, timeline, 0);
  assert.equal(res1.status, SYNC_STATUS.OK);
  assert.equal(res1.videoS, 1.0);

  // Calibration offset of +200ms
  const resCal = sensorTimeToVideo(600, map, timeline, 200);
  assert.equal(resCal.status, SYNC_STATUS.OK);
  assert.equal(resCal.videoS, 1.2);

  // Calibration offset of -500ms
  const resCalNeg = sensorTimeToVideo(600, map, timeline, -500);
  assert.equal(resCalNeg.status, SYNC_STATUS.OK);
  assert.equal(resCalNeg.videoS, 0.5);

  // Swing at sensor t = 100ms with -600ms calibration -> perf = 400ms -> before recording started (500ms)
  const resBefore = sensorTimeToVideo(100, map, timeline, -600);
  assert.equal(resBefore.status, SYNC_STATUS.BEFORE);
});

test('mapSwingsToVideo maps array of swings cleanly', () => {
  const map = new SensorClockMap({ windowMs: 10000, toleranceMs: 500 });
  map.add(500, 1500, 0);
  map.add(2500, 3500, 0);
  map.add(6000, 7000, 0);

  const timeline = new RecordingTimeline();
  timeline.start(1000); // 0s video
  timeline.stop(5000);  // 4s video duration

  const swings = [
    { t: 500, speedKmh: 45 },
    { t: 2500, speedKmh: 55 },
    { t: 6000, speedKmh: 40 },
  ];

  const mapped = mapSwingsToVideo(swings, map, timeline, 0);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].status, SYNC_STATUS.OK);
  assert.equal(mapped[0].videoS, 0.5);
  assert.equal(mapped[1].status, SYNC_STATUS.OK);
  assert.equal(mapped[1].videoS, 2.5);
  assert.equal(mapped[2].status, SYNC_STATUS.AFTER);
});

test('sanitizePadding and replayWindow boundaries', () => {
  const pad = sanitizePadding(-5, 'invalid', { defPre: 1.5, defPost: 1.5 });
  assert.equal(pad.preS, 1.5);
  assert.equal(pad.postS, 1.5);

  // Normal window inside video
  const win1 = replayWindow(5.0, 1.5, 2.0, 10.0);
  assert.equal(win1.startS, 3.5);
  assert.equal(win1.endS, 7.0);

  // Clamped at start
  const win2 = replayWindow(0.5, 1.5, 1.0, 10.0);
  assert.equal(win2.startS, 0);
  assert.equal(win2.endS, 1.5);

  // Clamped at end
  const win3 = replayWindow(9.5, 1.0, 2.0, 10.0);
  assert.equal(win3.startS, 8.5);
  assert.equal(win3.endS, 10.0);
});

test('estimateUncertainty honesty checks', () => {
  const unc = estimateUncertainty({
    jitterMs: 4,
    sampleIntervalMs: 20,
    fps: 30,
    startUncertaintyMs: 15,
    calibrated: false,
  });

  // sqrt(4^2 + 10^2 + 16.67^2 + 15^2) = ~25ms
  assert.ok(unc.plusMinusMs >= 20 && unc.plusMinusMs <= 40, `Expected ~25ms, got ${unc.plusMinusMs}`);
  assert.ok(typeof unc.note === 'string' && unc.note.length > 0);
});

/* -------------------------------------------------------------------------- */
/*                                  POSE MATH                                 */
/* -------------------------------------------------------------------------- */

test('calculateJointAngle computes correct 2D interior angles', () => {
  // Straight horizontal line: A(0, 0), B(1, 0), C(2, 0) -> 180 degrees
  const angle180 = calculateJointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 });
  assert.equal(angle180, 180);

  // Right angle: A(1, 1), B(1, 0), C(2, 0) -> 90 degrees
  const angle90 = calculateJointAngle({ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 0 });
  assert.equal(angle90, 90);

  // 45 degrees
  const angle45 = calculateJointAngle({ x: 2, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 0 });
  assert.ok(Math.abs(angle45 - 45) < 0.5);

  // Low visibility landmark returns null
  const invisible = calculateJointAngle({ x: 0, y: 0, visibility: 0.1 }, { x: 1, y: 0 }, { x: 2, y: 0 }, 0.5);
  assert.equal(invisible, null);

  // Degenerate zero-length vector returns null
  const degenerate = calculateJointAngle({ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 });
  assert.equal(degenerate, null);
});

test('calculateLineTilt and calculateTorsoInclination', () => {
  // Perfectly horizontal shoulders
  const tilt0 = calculateLineTilt({ x: 0.3, y: 0.4 }, { x: 0.7, y: 0.4 });
  assert.equal(tilt0, 0);

  // Upright torso (vertical spine)
  const lean0 = calculateTorsoInclination(
    { x: 0.4, y: 0.2 }, { x: 0.6, y: 0.2 }, // shoulders
    { x: 0.4, y: 0.6 }, { x: 0.6, y: 0.6 }, // hips
  );
  assert.equal(lean0, 0);

  // Torso leaning 45 degrees
  const lean45 = calculateTorsoInclination(
    { x: 0.8, y: 0.2 }, { x: 1.0, y: 0.2 }, // mid-shoulder at (0.9, 0.2)
    { x: 0.4, y: 0.6 }, { x: 0.6, y: 0.6 }, // mid-hip at (0.5, 0.6)
  );
  // dx = 0.4, dy = 0.4 -> 45 degrees
  assert.equal(lean45, 45);
});

test('evaluateLighting detects low-light frames', () => {
  // Dark frame: all 20s
  const dark = new Uint8ClampedArray(400).fill(20);
  const darkRes = evaluateLighting(dark, 45);
  assert.equal(darkRes.isLowLight, true);

  // Bright frame: all 180s
  const bright = new Uint8ClampedArray(400).fill(180);
  const brightRes = evaluateLighting(bright, 45);
  assert.equal(brightRes.isLowLight, false);
});

test('extractPoseIndicators generates indicators and disclaimer', () => {
  // Create 33 mock MediaPipe landmarks for an upright standing figure
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  
  // Left arm: shoulder(0.6, 0.3), elbow(0.7, 0.3), wrist(0.8, 0.3) -> 180 deg
  landmarks[11] = { x: 0.6, y: 0.3, visibility: 0.9 };
  landmarks[13] = { x: 0.7, y: 0.3, visibility: 0.9 };
  landmarks[15] = { x: 0.8, y: 0.3, visibility: 0.9 };

  // Right arm: 90 deg bend
  landmarks[12] = { x: 0.4, y: 0.3, visibility: 0.9 };
  landmarks[14] = { x: 0.3, y: 0.3, visibility: 0.9 };
  landmarks[16] = { x: 0.3, y: 0.4, visibility: 0.9 };

  const extracted = extractPoseIndicators(landmarks);
  assert.ok(extracted.available);
  assert.equal(extracted.indicators.leftElbowDeg, 180);
  assert.equal(extracted.indicators.rightElbowDeg, 90);
  assert.equal(extracted.disclaimer, DISCLAIMER_TEXT);
  assert.ok(extracted.overallConfidence > 0.8);
});

/* -------------------------------------------------------------------------- */
/*                                 MEDIA STORE                                */
/* -------------------------------------------------------------------------- */

test('MediaStore: stores, retrieves and revokes Blob URLs', () => {
  let createdCount = 0;
  let revokedCount = 0;

  const mockUrlApi = {
    createObjectURL: () => `blob:mock-${++createdCount}`,
    revokeObjectURL: () => { revokedCount++; },
  };

  const store = new MediaStore({ urlApi: mockUrlApi, maxItems: 2 });
  const blob1 = { size: 1024, type: 'video/webm' };
  const blob2 = { size: 2048, type: 'video/webm' };
  const blob3 = { size: 4096, type: 'video/webm' };

  store.put('s1', blob1, { durationS: 5 });
  assert.equal(store.has('s1'), true);
  assert.equal(store.get('s1').url, 'blob:mock-1');

  store.put('s2', blob2, { durationS: 10 });
  assert.equal(store.has('s2'), true);

  // Adding 3rd item should evict s1 (maxItems = 2)
  let evicted = null;
  store.onEvict = (e) => { evicted = e; };
  store.put('s3', blob3, { durationS: 15 });

  assert.equal(store.has('s1'), false);
  assert.equal(evicted.sessionId, 's1');
  assert.equal(revokedCount, 1);

  // Clean discard
  store.discard('s2');
  assert.equal(store.has('s2'), false);
  assert.equal(revokedCount, 2);

  store.discardAll();
  assert.equal(store.has('s3'), false);
  assert.equal(revokedCount, 3);
});

/* -------------------------------------------------------------------------- */
/*                               VIDEO RECORDER                               */
/* -------------------------------------------------------------------------- */

test('cameraSupport and describeCameraError', () => {
  // Insecure context
  const supInsecure = cameraSupport({ isSecureContext: false });
  assert.equal(supInsecure.getUserMedia, false);
  assert.ok(supInsecure.reason.includes('secure page'));

  // Error mappings
  const errDenied = describeCameraError({ name: 'NotAllowedError' });
  assert.ok(errDenied.message.includes('permission was denied'));

  const errNotFound = describeCameraError({ name: 'NotFoundError' });
  assert.ok(errNotFound.message.includes('No camera was found'));
});

test('VideoRecorder: state machine with mock MediaRecorder', async () => {
  class MockMediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = opts?.mimeType || 'video/webm';
      this.state = 'inactive';
      this.onstart = null;
      this.onpause = null;
      this.onresume = null;
      this.onstop = null;
      this.ondataavailable = null;
      this.onerror = null;
    }
    start() {
      this.state = 'recording';
      if (this.onstart) queueMicrotask(() => this.onstart());
    }
    pause() {
      this.state = 'paused';
      if (this.onpause) queueMicrotask(() => this.onpause());
    }
    resume() {
      this.state = 'recording';
      if (this.onresume) queueMicrotask(() => this.onresume());
    }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: { size: 1000 } });
      if (this.onstop) queueMicrotask(() => this.onstop());
    }
  }

  const mockEnv = {
    isSecureContext: true,
    MediaRecorder: MockMediaRecorder,
    Blob: class MockBlob {
      constructor(chunks, opts) {
        this.chunks = chunks;
        this.type = opts?.type || 'video/webm';
        this.size = 1000;
      }
    },
  };

  let mockPerf = 1000;
  const recorder = new VideoRecorder({
    env: mockEnv,
    now: () => mockPerf,
    timesliceMs: 500,
  });

  const mockStream = {
    getTracks: () => [{ stop: () => {}, readyState: 'live' }],
  };

  recorder.attachStream(mockStream, 'webcam');
  assert.equal(recorder.state, REC_STATE.PREVIEW);

  // Start recording
  recorder.startRecording(mockPerf);
  assert.equal(recorder.state, REC_STATE.RECORDING);

  // Pause
  mockPerf += 2000;
  recorder.pause();
  assert.equal(recorder.state, REC_STATE.PAUSED);

  // Resume
  mockPerf += 1000;
  recorder.resume();
  assert.equal(recorder.state, REC_STATE.RECORDING);

  // Stop
  mockPerf += 2000;
  const res = await recorder.stopRecording('test');
  assert.equal(recorder.state, REC_STATE.PREVIEW);
  assert.ok(res.blob);
  assert.equal(res.info.recorded, true);
});

/* -------------------------------------------------------------------------- */
/*                       SCHEMA & BACKWARD COMPATIBILITY                      */
/* -------------------------------------------------------------------------- */

import { Session } from '../js/session.js';

test('validateSessionRecord accepts optional video and sync metadata', () => {
  const s = new Session({ sport: 'cricket', name: 'Sync Test', mode: 'demo' });
  s.start();
  s.addSample({ seq: 1, ts: 20, ax: 0, ay: 0, az: 1, gx: 10, gy: 0, gz: 0 });
  s.addSample({ seq: 2, ts: 40, ax: 0, ay: 0, az: 1, gx: 500, gy: 0, gz: 0 });
  s.addSample({ seq: 3, ts: 60, ax: 0, ay: 0, az: 1, gx: 10, gy: 0, gz: 0 });
  s.stop();
  const baselineRec = s.toRecord();

  // Attach video, sync, and swing pose metadata
  baselineRec.video = {
    recorded: true,
    mimeType: 'video/webm',
    durationS: 10.0,
    calibrationOffsetMs: 20,
    uncertaintyMs: 35,
  };
  baselineRec.sync = {
    clock: { windowMs: 3000, pieces: [] },
  };
  if (baselineRec.swings.length > 0) {
    baselineRec.swings[0].videoS = 0.5;
    baselineRec.swings[0].pose = {
      available: true,
      overallConfidence: 0.85,
      indicators: {
        leftElbowDeg: 160,
        rightElbowDeg: 85,
        torsoInclinationDeg: 15,
        leftKneeDeg: 170,
        rightKneeDeg: 165,
        shoulderTiltDeg: 5,
      },
    };
  }

  // Validates with video & sync
  const valid = validateSessionRecord(baselineRec);
  assert.equal(valid.ok, true, valid.error);

  // Round-trips through export/import
  const bundle = toExportBundle([baselineRec]);
  const imported = parseImportText(JSON.stringify(bundle));
  assert.equal(imported.valid.length, 1);
  assert.equal(imported.valid[0].video.calibrationOffsetMs, 20);
  if (baselineRec.swings.length > 0) {
    assert.equal(imported.valid[0].swings[0].pose.indicators.leftElbowDeg, 160);
  }

  // Backward compatibility: validates without video or sync
  delete baselineRec.video;
  delete baselineRec.sync;
  assert.equal(validateSessionRecord(baselineRec).ok, true);
});

/* -------------------------------------------------------------------------- */
/*             REQUIREMENT B: CALIBRATION DIRECTION & RECONNECT SYNC          */
/* -------------------------------------------------------------------------- */

test('Sync Calibration: positive/negative direction and videoToSensorTime inverse consistency', () => {
  const map = new SensorClockMap({ windowMs: 10000, toleranceMs: 500 });
  // Map sensor 1000ms -> perf 2000ms
  map.add(1000, 2000, 0);

  const timeline = new RecordingTimeline();
  timeline.start(1000); // perf 1000ms = 0.0s video
  timeline.stop(5000);  // perf 5000ms = 4.0s video

  // Sensor timestamp t = 1000ms maps to perf 2000ms -> video = 1.0s with 0 offset
  const base = sensorTimeToVideo(1000, map, timeline, 0);
  assert.equal(base.videoS, 1.0);

  // Positive offset (+250ms) shifts video mapping LATER (1.0s + 0.25s = 1.25s)
  const posCal = sensorTimeToVideo(1000, map, timeline, 250);
  assert.equal(posCal.videoS, 1.25);
  assert.ok(posCal.videoS > base.videoS, 'Positive offset must shift video mapping later');

  // Negative offset (-250ms) shifts video mapping EARLIER (1.0s - 0.25s = 0.75s)
  const negCal = sensorTimeToVideo(1000, map, timeline, -250);
  assert.equal(negCal.videoS, 0.75);
  assert.ok(negCal.videoS < base.videoS, 'Negative offset must shift video mapping earlier');

  // Inverse: videoToSensorTime returns number (session t in ms)
  const invertedPos = videoToSensorTime(posCal.videoS, map, timeline, 250);
  assert.ok(Math.abs(invertedPos - 1000) < 1, `Expected sensorT ~1000, got ${invertedPos}`);

  const invertedNeg = videoToSensorTime(negCal.videoS, map, timeline, -250);
  assert.ok(Math.abs(invertedNeg - 1000) < 1, `Expected sensorT ~1000, got ${invertedNeg}`);

  // Dynamic update across multiple swings
  map.add(500, 1500, 0);
  map.add(2000, 3000, 0);
  const swings = [
    { t: 500, speedKmh: 40 },
    { t: 1000, speedKmh: 60 },
    { t: 2000, speedKmh: 80 },
  ];
  const mappedZero = mapSwingsToVideo(swings, map, timeline, 0);
  const mappedOffset = mapSwingsToVideo(swings, map, timeline, 100);
  for (let i = 0; i < swings.length; i++) {
    assert.ok(Math.abs((mappedOffset[i].videoS - mappedZero[i].videoS) - 0.1) < 0.001);
  }
});

test('Replay alignment and seeking: replayWindow boundary clamping and videoToSensorTime scrubbing', () => {
  const map = new SensorClockMap({ windowMs: 10000, toleranceMs: 500 });
  map.add(1000, 2000, 0);

  const timeline = new RecordingTimeline();
  timeline.start(1000);
  timeline.stop(11000); // 10s video

  // Swing at 0.5s into video (clamped at start with 1.5s pre-padding)
  const winStart = replayWindow(0.5, 1.5, 2.0, 10.0);
  assert.equal(winStart.startS, 0.0); // clamped to 0
  assert.equal(winStart.endS, 2.5);

  // Swing at 9.2s into video (clamped at end with 2.0s post-padding)
  const winEnd = replayWindow(9.2, 1.0, 2.0, 10.0);
  assert.equal(winEnd.startS, 8.2);
  assert.equal(winEnd.endS, 10.0); // clamped to 10.0

  // Seeking/scrubbing within the replay window:
  // Scrubbing to 1.0s video time translates to sensor timestamp for sensor graph highlighting
  const scrubTarget = videoToSensorTime(1.0, map, timeline, 0);
  assert.equal(scrubTarget, 1000);
});

test('Synchronization after reconnect: multi-segment clock map preserves video alignment', () => {
  const map = new SensorClockMap({ windowMs: 5000 });
  const timeline = new RecordingTimeline();
  timeline.start(1000); // perf = 1000ms (video 0s)

  // Segment 0: sensor streaming before disconnect
  // session t: 100..2000ms -> perf 1100..3000ms (video 0.1s to 2.0s)
  map.add(100, 1100, 0);
  map.add(2000, 3000, 0);

  // Disconnection and ESP8266 reboot occurs (perf 3000 to 5000)
  // Segment 1: sensor session t re-anchored: 2500..5000ms -> perf 5500..8000ms (video 4.5s to 7.0s)
  map.add(2500, 5500, 1);
  map.add(4000, 7000, 1);

  timeline.stop(9000); // 8s video duration

  // Swing from Segment 0
  const swingSeg0 = sensorTimeToVideo(2000, map, timeline, 0);
  assert.equal(swingSeg0.status, SYNC_STATUS.OK);
  assert.equal(swingSeg0.videoS, 2.0);

  // Swing from Segment 1 (after reconnect)
  const swingSeg1 = sensorTimeToVideo(4000, map, timeline, 0);
  assert.equal(swingSeg1.status, SYNC_STATUS.OK);
  assert.equal(swingSeg1.videoS, 6.0);

  // Applying calibration offset (+200ms) preserves alignment on both segments
  const swingSeg0Cal = sensorTimeToVideo(2000, map, timeline, 200);
  assert.equal(swingSeg0Cal.videoS, 2.2);

  const swingSeg1Cal = sensorTimeToVideo(4000, map, timeline, 200);
  assert.equal(swingSeg1Cal.videoS, 6.2);

  // Both round-trip via videoToSensorTime correctly
  const backSeg0 = videoToSensorTime(2.2, map, timeline, 200);
  assert.ok(Math.abs(backSeg0 - 2000) < 2);

  const backSeg1 = videoToSensorTime(6.2, map, timeline, 200);
  assert.ok(Math.abs(backSeg1 - 4000) < 2);
});

/* -------------------------------------------------------------------------- */
/*            REQUIREMENT C: CAMERA RELEASE & RESOURCE CLEANUP                */
/* -------------------------------------------------------------------------- */

test('VideoRecorder: stopAndRelease stops every media track, finalizes recording, and cleans up', async () => {
  let track1Stopped = false;
  let track2Stopped = false;
  const mockTrack1 = { stop: () => { track1Stopped = true; }, readyState: 'live', kind: 'video' };
  const mockTrack2 = { stop: () => { track2Stopped = true; }, readyState: 'live', kind: 'audio' };

  class MockMediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = opts?.mimeType || 'video/webm';
      this.state = 'inactive';
      this.onstart = null;
      this.onstop = null;
      this.ondataavailable = null;
    }
    start() {
      this.state = 'recording';
      if (this.onstart) queueMicrotask(() => this.onstart());
    }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: { size: 5000 } });
      if (this.onstop) queueMicrotask(() => this.onstop());
    }
  }

  const mockEnv = {
    isSecureContext: true,
    MediaRecorder: MockMediaRecorder,
    Blob: class MockBlob {
      constructor(chunks, opts) {
        this.chunks = chunks;
        this.type = opts?.type || 'video/webm';
        this.size = 5000;
      }
    },
  };

  const recorder = new VideoRecorder({
    env: mockEnv,
    now: () => 1000,
    timesliceMs: 500,
  });

  const mockStream = {
    getTracks: () => [mockTrack1, mockTrack2],
  };

  recorder.attachStream(mockStream, 'webcam');
  assert.equal(recorder.state, REC_STATE.PREVIEW);

  // Start recording
  recorder.startRecording(1000);
  assert.equal(recorder.state, REC_STATE.RECORDING);

  // Session ends: call stopAndRelease
  const result = await recorder.stopAndRelease('session_end');

  // Verifications:
  // 1. Both active media tracks were stopped
  assert.equal(track1Stopped, true, 'Track 1 must be stopped');
  assert.equal(track2Stopped, true, 'Track 2 must be stopped');

  // 2. State is REC_STATE.OFF
  assert.equal(recorder.state, REC_STATE.OFF);

  // 3. Stream and recorder references are cleared
  assert.equal(recorder.stream, null);
  assert.equal(recorder.recorder, null);

  // 4. Recorded Blob was finalized without data loss
  assert.ok(result.blob, 'Blob must be preserved');
  assert.equal(result.info.recorded, true);
  assert.equal(result.info.sizeBytes, 5000);

  // 5. Subsequent release calls are safe and idempotent
  await recorder.stopAndRelease('already_off');
  assert.equal(recorder.state, REC_STATE.OFF);
});

test('VideoRecorder: stopAndRelease handles preview-only session termination', async () => {
  let trackStopped = false;
  const mockTrack = { stop: () => { trackStopped = true; }, readyState: 'live', kind: 'video' };
  const mockStream = { getTracks: () => [mockTrack] };

  const recorder = new VideoRecorder({
    env: { isSecureContext: true },
    now: () => 1000,
  });

  recorder.attachStream(mockStream, 'webcam');
  assert.equal(recorder.state, REC_STATE.PREVIEW);

  // End session without ever recording
  const result = await recorder.stopAndRelease('session_stop');
  assert.equal(trackStopped, true);
  assert.equal(recorder.state, REC_STATE.OFF);
  assert.equal(recorder.stream, null);
  assert.equal(result, null);
});

test('Preserve session reports and exportable recordings after webcam release', async () => {
  const store = new MediaStore();
  const sessionId = 'session_test_release_123';
  const mockBlob = { size: 12345, type: 'video/webm' };

  // Store video in MediaStore
  store.put(sessionId, mockBlob, { durationS: 15.0 });
  assert.equal(store.has(sessionId), true);

  // Webcam is released completely
  const mockTrack = { stop: () => {}, readyState: 'live' };
  const recorder = new VideoRecorder({ env: { isSecureContext: true } });
  recorder.attachStream({ getTracks: () => [mockTrack] }, 'webcam');
  await recorder.stopAndRelease('session_end');
  assert.equal(recorder.state, REC_STATE.OFF);

  // MediaStore still retains the video Blob for report replay and export
  assert.equal(store.has(sessionId), true);
  const entry = store.get(sessionId);
  assert.equal(entry.blob.size, 12345);
  assert.equal(entry.info.durationS, 15.0);
});

/* -------------------------------------------------------------------------- */
/*              REQUIREMENT A: POSE CANVAS ALIGNMENT GEOMETRY                 */
/* -------------------------------------------------------------------------- */

test('alignCanvasToVideo: calculates exact letterbox and pillarbox geometry', () => {
  // Case 1: 16:9 video in 4:3 container (Letterbox: horizontal black bars top and bottom)
  const mockVideoLetterbox = {
    videoWidth: 1920,
    videoHeight: 1080, // ratio = 16/9 = 1.7778
    clientWidth: 800,
    clientHeight: 600, // element ratio = 800/600 = 1.3333
  };
  const mockCanvas1 = {
    width: 0,
    height: 0,
    style: {},
  };

  const res1 = alignCanvasToVideo(mockVideoLetterbox, mockCanvas1);
  assert.ok(res1);
  // Expected renderWidth = 800, renderHeight = 800 / (16/9) = 450
  // offsetY = (600 - 450) / 2 = 75
  assert.equal(res1.width, 800);
  assert.equal(res1.height, 450);
  assert.equal(res1.x, 0);
  assert.equal(res1.y, 75);
  assert.equal(mockCanvas1.style.left, '0px');
  assert.equal(mockCanvas1.style.top, '75px');
  assert.equal(mockCanvas1.style.width, '800px');
  assert.equal(mockCanvas1.style.height, '450px');
  assert.equal(mockCanvas1.width, 1920);
  assert.equal(mockCanvas1.height, 1080);

  // Case 2: 4:3 video in 16:9 container (Pillarbox: vertical black bars left and right)
  const mockVideoPillarbox = {
    videoWidth: 640,
    videoHeight: 480, // ratio = 4/3 = 1.3333
    clientWidth: 1600,
    clientHeight: 900, // element ratio = 1600/900 = 1.7778
  };
  const mockCanvas2 = {
    width: 0,
    height: 0,
    style: {},
  };

  const res2 = alignCanvasToVideo(mockVideoPillarbox, mockCanvas2);
  assert.ok(res2);
  // Expected renderHeight = 900, renderWidth = 900 * (4/3) = 1200
  // offsetX = (1600 - 1200) / 2 = 200
  assert.equal(res2.width, 1200);
  assert.equal(res2.height, 900);
  assert.equal(res2.x, 200);
  assert.equal(res2.y, 0);
  assert.equal(mockCanvas2.style.left, '200px');
  assert.equal(mockCanvas2.style.top, '0px');
  assert.equal(mockCanvas2.style.width, '1200px');
  assert.equal(mockCanvas2.style.height, '900px');
  assert.equal(mockCanvas2.width, 640);
  assert.equal(mockCanvas2.height, 480);
});
