/**
 * Application controller: routing, views, session lifecycle. Business logic lives in
 * session.js / analytics.js; sensor transport in sensor.js / simulator.js; persistence in storage.js.
 */
import { CONFIG, SPORT_IDS } from './config.js';
import { Session } from './session.js';
import { DemoSource } from './simulator.js';
import { LiveSensor, CONN, CONN_LABEL } from './sensor.js';
import { magnitude, fmt, formatDuration, downsampleRows, buildSummaryText, validateEquipment } from './analytics.js';
import { saveSession, listSessions, getSession, deleteSession, importRecords } from './storage.js';
import { parseImportText, toExportBundle, toCsv } from './schema.js';
import { createChart, updateLive, setReport, SPEC, zoomChart, panChart, resetChartZoom, attachInteractiveControls } from './charts.js';
import { VideoRecorder, REC_STATE, createSyntheticCamera, cameraSupport } from './recorder.js';
import { MediaStore } from './media-store.js';
import { SensorClockMap, sensorTimeToVideo, videoToSensorTime, mapSwingsToVideo, sanitizePadding, replayWindow, estimateUncertainty } from './sync.js';
import { PoseTracker, POSE_STATE, alignCanvasToVideo } from './pose.js';

const $ = (id) => document.getElementById(id);
const EMOJI = { cricket: '🏏', badminton: '🏸', tennis: '🎾' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sportLabel = (id) => CONFIG.sports[id]?.label || id;

/* ------------------------------ settings & equipment ------------------------------ */
const SETTINGS_KEY = 'spm.settings.v1';
const EQUIPMENT_KEY = 'spm.equipment.v1';

const settings = {
  sport: 'cricket',
  mode: 'demo',
  name: '',
  host: CONFIG.esp.host,
  port: CONFIG.esp.port,
  cameraMode: 'webcam', // webcam | synthetic | none
  poseEnabled: true,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* ignore corrupt settings */ }
if (!SPORT_IDS.includes(settings.sport)) settings.sport = 'cricket';
if (settings.mode !== 'demo' && settings.mode !== 'live') settings.mode = 'demo';
if (!['webcam', 'synthetic', 'none'].includes(settings.cameraMode)) settings.cameraMode = 'webcam';
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
}

const equipmentStore = {};
for (const id of SPORT_IDS) {
  equipmentStore[id] = { ...CONFIG.sports[id].equipmentDefaults };
}
try {
  const savedEq = JSON.parse(localStorage.getItem(EQUIPMENT_KEY) || '{}');
  for (const id of SPORT_IDS) {
    if (savedEq[id] && typeof savedEq[id] === 'object') {
      const v = validateEquipment(id, savedEq[id]);
      if (v.valid) equipmentStore[id] = { lengthInches: v.lengthInches, weightGrams: v.weightGrams };
    }
  }
} catch { /* storage may be blocked */ }
function saveEquipmentStore() {
  try { localStorage.setItem(EQUIPMENT_KEY, JSON.stringify(equipmentStore)); } catch { /* storage may be blocked */ }
}

/* ------------------------------ state ------------------------------ */
let active = null; // the single active Session (or null)
let demoSource = null;
let liveRows = []; // rolling window for the live graphs only
let latest = null; // latest accepted row
let lastSwing = null;
let stopping = false;
let currentView = '';
let routeToken = 0;
const unsaved = new Map(); // records that failed to save (kept in memory so they can still be exported)
const charts = { accel: null, gyro: null };
let reportCharts = [];
let modalChart = null;
let modalRemoveControls = null;
let modalActiveRec = null;

// Video, Pose & Synchronization state
const mediaStore = new MediaStore({
  maxItems: CONFIG.video?.maxInMemory || 3,
  onEvict: (entry) => toast(`Video for session ${entry.sessionId.slice(-6)} was released from memory to preserve browser RAM.`, 'warn'),
});
let recorder = null;
let poseTracker = null;
let clockMap = new SensorClockMap({ windowMs: CONFIG.sync?.clockWindowMs || 3000 });
let syntheticCam = null;
let sessionOriginPerf = 0;
let calibrationOffsetMs = 0;
let liveSwings = [];
let activeLiveReplayIndex = -1;
let liveReplayTimer = null;
let poseLoopId = null;
let poseLoopActive = false;
let lastLivePose = null;
let poseOverlayVisible = true;
let replayPoseOverlayVisible = true;
let activeReportRec = null;
let activeReportSwingIdx = -1;
let reportReplayTimer = null;

const live = new LiveSensor({
  onState: () => { updateChrome(); refreshConnectionUi(); },
  onSample: (s) => handleSample(s),
  onInvalid: () => { /* counted inside LiveSensor; shown in live note */ scheduleRender(); },
  onDisconnect: () => { if (active) active.triggerRebase(); },
});

/* ------------------------------ UI helpers ------------------------------ */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}

function banner(msg, kind = 'error') {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.className = `banner ${kind === 'info' ? 'info' : ''}`;
  b.hidden = false;
}

function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pad = (n) => String(n).padStart(2, '0');
function fileBase(rec) {
  const d = new Date(rec.startedAt);
  return `${rec.sport}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${rec.id.slice(-6)}`;
}
const exportJson = (recs, name) => download(`${name}.json`, JSON.stringify(toExportBundle(recs)), 'application/json');

function connClass(state) {
  return { connected: 'badge-ok', connecting: 'badge-warn', sensor_unavailable: 'badge-bad', connection_lost: 'badge-bad', disconnected: 'badge-off' }[state] || 'badge-off';
}

/* ------------------------------ header / status ------------------------------ */
function currentMode() { return active ? active.mode : settings.mode; }

function updateChrome() {
  const mode = currentMode();
  const mb = $('mode-badge');
  mb.textContent = mode === 'demo' ? 'Demo Mode (simulated)' : 'Live Hardware';
  mb.className = `badge ${mode === 'demo' ? 'badge-demo' : 'badge-live'}`;
  const cb = $('conn-badge');
  cb.textContent = `ESP8266: ${CONN_LABEL[live.state]}`;
  cb.className = `badge ${connClass(live.state)}`;
  $('nav-live-dot').hidden = !active;
}

function refreshConnectionUi() {
  if (currentView === 'home') renderHomeStatus();
  if (currentView === 'setup') renderSetupLive();
  if (currentView === 'live') renderLiveNote();
}

function ensureLiveConnection() {
  const sameTarget = live.host === settings.host && live.port === settings.port;
  if (live.wantOpen && sameTarget && (live.state === CONN.CONNECTED || live.state === CONN.CONNECTING)) return;
  live.connect(settings.host, settings.port);
}

function liveNoteFor(state) {
  switch (state) {
    case CONN.CONNECTED: return { kind: 'ok', text: 'ESP8266 connected and streaming real sensor data.' };
    case CONN.CONNECTING: return { kind: 'warn', text: live.detail || 'Connecting to the ESP8266…' };
    case CONN.RECONNECTING: return { kind: 'warn', text: live.detail || 'Connection lost. Reconnecting…' };
    case CONN.SENSOR_UNAVAILABLE: return { kind: 'bad', text: `ESP8266 reachable but the MPU6050 is not responding. ${live.detail} Check wiring: VCC→3V3, GND→GND, SDA→D2, SCL→D1.` };
    case CONN.CONNECTION_LOST: return { kind: 'bad', text: `Connection lost. ${live.detail} Retrying automatically…` };
    default: return { kind: 'bad', text: live.detail && live.detail !== 'Not connected.' ? live.detail : 'ESP8266 not connected. Live Hardware Mode needs the ESP8266 — use “Test connection”, or choose Demo Mode.' };
  }
}

/* ------------------------------ sport selection & equipment ------------------------------ */
function setSport(id) {
  settings.sport = id;
  saveSettings();
  renderSports();
  renderSetupEquipment();
  updateLiveHeader();
}

function renderSetupEquipment() {
  const sport = settings.sport;
  const cfg = CONFIG.sports[sport];
  if (!cfg) return;
  const cur = equipmentStore[sport] || cfg.equipmentDefaults;
  const lenEl = $('setup-equip-length');
  const wtEl = $('setup-equip-weight');
  if (lenEl) lenEl.value = cur.lengthInches;
  if (wtEl) wtEl.value = cur.weightGrams;
  const lenLbl = $('equip-len-label');
  const wtLbl = $('equip-weight-label');
  if (lenLbl) lenLbl.innerHTML = `${cfg.label} ${cfg.equipment} length <small>(inches)</small>`;
  if (wtLbl) wtLbl.innerHTML = `${cfg.label} ${cfg.equipment} weight <small>(grams)</small>`;
  const err = $('equip-validation-error');
  if (err) err.hidden = true;
}

function renderSports() {
  const home = $('home-sports');
  home.innerHTML = SPORT_IDS.map((id) => {
    const c = CONFIG.sports[id];
    return `<button type="button" class="sport-card" data-sport="${id}" aria-pressed="${settings.sport === id}"><span class="emoji" aria-hidden="true">${EMOJI[id]}</span><span><strong>${c.label}</strong><br><small>Sensor on ${c.equipment}</small></span></button>`;
  }).join('');
  $('setup-sports').innerHTML = SPORT_IDS.map((id) => `<label class="rcard"><input type="radio" name="sport" value="${id}" ${settings.sport === id ? 'checked' : ''}><span><strong>${EMOJI[id]} ${CONFIG.sports[id].label}</strong><small>Sensor on ${CONFIG.sports[id].equipment}</small></span></label>`).join('');
}

/* ------------------------------ HOME ------------------------------ */
function renderHomeStatus() {
  const demo = settings.mode === 'demo';
  $('home-mode').textContent = demo ? 'Demo Mode' : 'Live Hardware Mode';
  $('home-mode-note').textContent = demo ? 'Simulated sensor data. Works without any hardware.' : 'Uses real MPU6050 readings from the ESP8266.';
  $('home-conn').innerHTML = `<span class="badge ${connClass(live.state)}">${CONN_LABEL[live.state]}</span>`;
  $('home-conn-note').textContent = `${settings.host}:${settings.port}${demo ? ' (not used in Demo Mode)' : ''}`;
}

async function renderHome(token) {
  renderHomeStatus();
  const box = $('home-recent');
  try {
    const list = await listSessions();
    if (token !== routeToken) return;
    if (!list.length) { box.innerHTML = 'No sessions yet. Start a Demo Mode session to see activity here.'; return; }
    const swings = list.reduce((a, s) => a + s.metrics.totalSwings, 0);
    const best = Math.max(...list.map((s) => s.metrics.maxSpeedKmh ?? 0));
    box.innerHTML = `<p style="margin:0 0 8px"><strong>${list.length}</strong> session${list.length === 1 ? '' : 's'} · <strong>${swings}</strong> swings${best ? ` · best est. <strong>${fmt(best)}</strong> km/h` : ''}</p>` +
      list.slice(0, 3).map((s) => `<div><a href="#report/${encodeURIComponent(s.id)}">${EMOJI[s.sport]} ${esc(s.name || sportLabel(s.sport))}</a> <span class="small">· ${s.metrics.totalSwings} swings · ${new Date(s.startedAt).toLocaleDateString()}</span></div>`).join('');
  } catch (e) {
    box.textContent = `History unavailable: ${e.message}`;
  }
}

/* ------------------------------ SETUP ------------------------------ */
function renderSetup() {
  renderSports();
  renderSetupEquipment();
  $('setup-name').value = settings.name || '';
  document.querySelector(`input[name=mode][value=${settings.mode}]`).checked = true;
  $('setup-host').value = settings.host;
  $('setup-port').value = settings.port;
  $('setup-error').hidden = true;

  const camSelect = $('setup-camera-mode');
  if (camSelect) camSelect.value = settings.cameraMode;
  const poseCheck = $('setup-pose-enable');
  if (poseCheck) poseCheck.checked = settings.poseEnabled;
  const note = $('setup-cam-support-note');
  if (note) {
    const sup = cameraSupport();
    note.textContent = sup.getUserMedia ? '✓ Camera access supported in this browser.' : `Notice: ${sup.reason}`;
  }

  renderSetupLive();
}

function renderSetupLive() {
  const live_ = settings.mode === 'live';
  $('live-settings').hidden = !live_;
  if (!live_) return;
  const n = liveNoteFor(live.state);
  const el = $('setup-live-status');
  el.textContent = n.text;
  el.className = `notice notice-${n.kind === 'ok' ? 'ok' : n.kind === 'warn' ? 'warn' : 'bad'}`;
}

function readHostPort() {
  const host = $('setup-host').value.trim().replace(/^wss?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  const port = Number($('setup-port').value);
  if (!/^[A-Za-z0-9.\-]+$/.test(host)) return { error: 'Enter the ESP8266 IP address (e.g. 192.168.1.50).' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Enter a valid port number (1–65535).' };
  return { host, port };
}

function startFromSetup(ev) {
  ev.preventDefault();
  const err = $('setup-error');
  const equipErr = $('equip-validation-error');
  err.hidden = true;
  if (equipErr) equipErr.hidden = true;

  if (active) {
    err.textContent = 'A session is already active. Stop it from the Live screen before starting another.';
    err.hidden = false;
    return;
  }

  // Validate equipment configuration
  const lenRaw = $('setup-equip-length').value;
  const wtRaw = $('setup-equip-weight').value;
  const eqValidation = validateEquipment(settings.sport, { lengthInches: lenRaw, weightGrams: wtRaw });
  if (!eqValidation.valid) {
    equipErr.textContent = eqValidation.error;
    equipErr.hidden = false;
    $('setup-equip-length').focus();
    return;
  }

  // Persist valid equipment configuration per sport
  equipmentStore[settings.sport] = { lengthInches: eqValidation.lengthInches, weightGrams: eqValidation.weightGrams };
  saveEquipmentStore();

  settings.name = $('setup-name').value.trim();
  const camMode = $('setup-camera-mode')?.value || 'webcam';
  const poseOn = $('setup-pose-enable') ? $('setup-pose-enable').checked : true;
  settings.cameraMode = camMode;
  settings.poseEnabled = poseOn;

  if (settings.mode === 'live') {
    const hp = readHostPort();
    if (hp.error) { err.textContent = hp.error; err.hidden = false; return; }
    settings.host = hp.host;
    settings.port = hp.port;
  }
  saveSettings();
  startSession({ lengthInches: eqValidation.lengthInches, weightGrams: eqValidation.weightGrams });
  location.hash = '#live';
}

/* ------------------------------ SESSION LIFECYCLE ------------------------------ */
function ensureVideoAndPose() {
  if (!recorder) {
    recorder = new VideoRecorder({
      video: CONFIG.video,
      maxBytes: CONFIG.video?.maxBytes,
      maxDurationS: CONFIG.video?.maxDurationS,
      timesliceMs: CONFIG.video?.timesliceMs,
      videoBitsPerSecond: CONFIG.video?.videoBitsPerSecond,
      onChange: () => updateCameraUi(),
    });
  }
  if (!poseTracker) {
    poseTracker = new PoseTracker({ config: CONFIG.pose });
  }

  recorder.resetForSession();

  const camMode = settings.cameraMode;
  if (camMode === 'synthetic') {
    if (syntheticCam) { syntheticCam.stop(); syntheticCam = null; }
    syntheticCam = createSyntheticCamera({
      getMotion: () => latest ? { t: latest[0], gyroMag: magnitude(latest[4], latest[5], latest[6]), accelMag: magnitude(latest[1], latest[2], latest[3]) } : null,
    });
    if (syntheticCam) {
      recorder.attachStream(syntheticCam.stream, 'synthetic');
      const v = $('live-webcam-video');
      if (v) { v.srcObject = syntheticCam.stream; v.play().catch(() => {}); }
      recorder.startRecording(sessionOriginPerf);
    }
  } else if (camMode === 'webcam') {
    recorder.openCamera().then((ok) => {
      if (ok && recorder.stream) {
        const v = $('live-webcam-video');
        if (v) { v.srcObject = recorder.stream; v.play().catch(() => {}); }
        recorder.startRecording(sessionOriginPerf);
      }
      updateCameraUi();
    });
  } else {
    recorder.closeCamera(true);
  }

  if (settings.poseEnabled) {
    poseTracker.init().then((ok) => {
      if (ok) startPoseLoop();
      updateCameraUi();
    });
  } else {
    stopPoseLoop();
  }
}

function startSession(equipmentSnapshot = null) {
  if (active) { toast('A session is already running.', 'warn'); return false; }
  const eq = equipmentSnapshot || { ...equipmentStore[settings.sport] };
  active = new Session({ sport: settings.sport, name: settings.name, mode: settings.mode, equipment: eq });
  active.start();
  liveRows = [];
  latest = null;
  lastSwing = null;
  liveSwings = [];
  activeLiveReplayIndex = -1;
  lastLivePose = null;
  sessionOriginPerf = performance.now();
  clockMap = new SensorClockMap({
    windowMs: CONFIG.sync?.clockWindowMs || 3000,
    toleranceMs: CONFIG.sync?.edgeToleranceMs || 100,
  });
  banner('');

  ensureVideoAndPose();

  if (active.mode === 'demo') {
    demoSource = new DemoSource(active.sport);
    demoSource.setSink(handleSample);
    demoSource.start();
  } else {
    ensureLiveConnection();
  }
  updateChrome();
  updateControls();
  updateCameraUi();
  updateLiveSwingTimeline();
  scheduleRender();
  return true;
}

function handleSample(raw) {
  if (!active || active.state !== 'running') return;
  const r = active.addSample(raw);
  if (!r.accepted) return;
  latest = r.row;
  liveRows.push(r.row);
  if (liveRows.length > 1500) liveRows = liveRows.slice(-700);

  const sampleArrivalPerf = performance.now() - sessionOriginPerf;
  clockMap.add(r.row[0], sampleArrivalPerf, r.segment);

  if (r.swing) {
    lastSwing = r.swing;
    const vm = sensorTimeToVideo(r.swing.t, clockMap, recorder?.timeline, calibrationOffsetMs, sampleArrivalPerf);
    r.swing.videoS = vm.videoS;
    r.swing.pose = lastLivePose ? { ...lastLivePose } : null;
    liveSwings.push(r.swing);
    updateLiveSwingTimeline();
  }

  if (active && CONFIG.limits?.maxDurationSeconds && active.durationMs >= CONFIG.limits.maxDurationSeconds * 1000) {
    toast('Maximum session duration reached; stopping session.', 'warn');
    stopSession();
    return;
  }

  scheduleRender();
}

function pauseSession() {
  if (!active || !active.pause()) return;
  if (demoSource) demoSource.pause();
  if (recorder && recorder.isRecording) recorder.pause();
  stopPoseLoop();
  updateControls();
  updateCameraUi();
  renderLive();
}

function resumeSession() {
  if (!active || !active.resume()) return;
  if (demoSource) demoSource.resume();
  if (recorder && recorder.state === REC_STATE.PAUSED) recorder.resume();
  if (settings.poseEnabled && poseTracker && poseTracker.state === POSE_STATE.READY) startPoseLoop();
  updateControls();
  updateCameraUi();
  renderLive();
}

async function stopSession() {
  if (!active || stopping) return;
  stopping = true;
  const s = active;
  try {
    stopPoseLoop();
    stopReplayPose();
    let videoResult = null;
    if (recorder) {
      videoResult = await recorder.stopAndRelease('session_stop');
    }
    if (syntheticCam) {
      syntheticCam.stop();
      syntheticCam = null;
    }
    const liveVideo = $('live-webcam-video');
    if (liveVideo) {
      liveVideo.pause();
      liveVideo.srcObject = null;
    }

    s.stop();
    if (demoSource) { demoSource.stop(); demoSource = null; }
    if (s.mode === 'live') live.disconnect();
    active = null;
    liveRows = [];
    updateChrome();
    updateControls();
    updateCameraUi();

    const rec = s.toRecord();
    if (rec.metrics.sampleCount === 0) {
      toast('Session was empty (no sensor data received), so nothing was saved.', 'warn');
      renderLive();
      return;
    }

    // Attach video & sync metadata if recording occurred
    if (videoResult && videoResult.blob) {
      mediaStore.put(rec.id, videoResult.blob, videoResult.info);
      rec.video = { ...videoResult.info, calibrationOffsetMs };
      rec.sync = { clock: clockMap.toJSON() };
      // Map all swings to video using the complete recording timeline
      const mapped = mapSwingsToVideo(rec.swings, clockMap, recorder.timeline, calibrationOffsetMs);
      rec.swings = rec.swings.map((sw, idx) => ({
        ...sw,
        videoS: mapped[idx].videoS,
        syncStatus: mapped[idx].status,
      }));
    }

    try {
      await saveSession(rec);
      toast('Session saved.');
    } catch (e) {
      unsaved.set(rec.id, rec);
      banner(`Could not save the session to browser storage: ${e.message} The report is shown below — export it as JSON to keep it.`);
    }
    location.hash = `#report/${encodeURIComponent(rec.id)}`;
  } finally {
    stopping = false;
  }
}

function resetSimulator() {
  if (!active || active.mode !== 'demo' || !demoSource) return;
  demoSource.reset(active.sport);
  toast('Simulator restarted (new simulated motion pattern).');
}

/* ------------------------------ CAMERA & POSE UI HELPERS ------------------------------ */
function updateCameraUi() {
  const badgeCam = $('badge-cam-state');
  const badgePose = $('badge-pose-state');
  const badgeSize = $('badge-video-size');
  const placeholder = $('cam-placeholder');
  const btnToggle = $('btn-cam-toggle');

  if (!recorder) return;
  const st = recorder.state;
  if (badgeCam) {
    if (st === REC_STATE.RECORDING) {
      badgeCam.textContent = '● Video: Recording';
      badgeCam.className = 'badge badge-bad';
    } else if (st === REC_STATE.PAUSED) {
      badgeCam.textContent = '⏸ Video: Paused';
      badgeCam.className = 'badge badge-warn';
    } else if (st === REC_STATE.PREVIEW) {
      badgeCam.textContent = 'Camera: Preview';
      badgeCam.className = 'badge badge-ok';
    } else if (st === REC_STATE.ERROR) {
      badgeCam.textContent = 'Camera: Error';
      badgeCam.className = 'badge badge-bad';
    } else {
      badgeCam.textContent = 'Camera: Off';
      badgeCam.className = 'badge badge-off';
    }
  }

  if (badgePose) {
    const pst = poseTracker ? poseTracker.state : POSE_STATE.UNINITIALIZED;
    if (pst === POSE_STATE.READY) {
      badgePose.textContent = poseLoopActive ? 'Pose: Active' : 'Pose: Ready';
      badgePose.className = 'badge badge-ok';
    } else if (pst === POSE_STATE.LOADING) {
      badgePose.textContent = 'Pose: Loading…';
      badgePose.className = 'badge badge-warn';
    } else if (pst === POSE_STATE.ERROR) {
      badgePose.textContent = 'Pose: Unavailable';
      badgePose.className = 'badge badge-bad';
    } else {
      badgePose.textContent = 'Pose: Off';
      badgePose.className = 'badge badge-off';
    }
  }

  if (badgeSize) {
    if (recorder.bytes > 0) {
      badgeSize.hidden = false;
      const mb = (recorder.bytes / 1048576).toFixed(1);
      badgeSize.textContent = `${mb} MB (RAM)`;
    } else {
      badgeSize.hidden = true;
    }
  }

  if (placeholder) {
    placeholder.hidden = recorder.hasStream;
  }

  if (btnToggle) {
    btnToggle.textContent = recorder.hasStream ? 'Disable Camera' : 'Enable Camera';
  }

  const warnBox = $('cam-warning-box');
  if (warnBox) {
    const err = recorder.error?.message || recorder.warning || (poseTracker?.state === POSE_STATE.ERROR ? poseTracker.errorMsg : '');
    if (err) {
      warnBox.textContent = err;
      warnBox.hidden = false;
    } else if (poseTracker?.isLowLight) {
      warnBox.textContent = 'Notice: Low lighting detected in camera view. Pose tracking accuracy may be reduced.';
      warnBox.hidden = false;
    } else {
      warnBox.hidden = true;
    }
  }
}

function startPoseLoop() {
  if (poseLoopActive) return;
  poseLoopActive = true;
  updateCameraUi();

  const video = $('live-webcam-video');
  const canvas = $('live-pose-canvas');
  if (!video || !canvas || !poseTracker) return;
  const ctx = canvas.getContext('2d');

  let lastInference = 0;
  const targetInterval = 1000 / (CONFIG.pose?.liveFps || 10);

  const loop = () => {
    if (!poseLoopActive) return;
    const now = performance.now();
    if (now - lastInference >= targetInterval && video.readyState >= 2) {
      lastInference = now;
      alignCanvasToVideo(video, canvas);

      const res = poseTracker.processFrame(video, now - sessionOriginPerf);
      if (res && res.detected && res.landmarks) {
        lastLivePose = res.indicators;
        if (poseOverlayVisible) {
          poseTracker.drawOverlay(ctx, res.landmarks, canvas.width, canvas.height);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        updatePoseIndicatorsDisplay(res.indicators);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (res && !res.detected) {
          updatePoseIndicatorsDisplay(null);
        }
      }
      updateCameraUi();
    }
    poseLoopId = requestAnimationFrame(loop);
  };
  poseLoopId = requestAnimationFrame(loop);
}

function stopPoseLoop() {
  poseLoopActive = false;
  if (poseLoopId) {
    cancelAnimationFrame(poseLoopId);
    poseLoopId = null;
  }
  const canvas = $('live-pose-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }
  updateCameraUi();
}

function updatePoseIndicatorsDisplay(ind) {
  const confBadge = $('pose-conf-badge');
  const fmtAngle = (deg) => deg !== null && Number.isFinite(deg) ? `${deg.toFixed(0)}°` : '—';

  if (!ind || !ind.available || !ind.indicators) {
    $('ind-le').textContent = '—';
    $('ind-re').textContent = '—';
    $('ind-torso').textContent = '—';
    $('ind-lk').textContent = '—';
    $('ind-rk').textContent = '—';
    $('ind-st').textContent = '—';
    if (confBadge) {
      confBadge.textContent = 'Confidence: low/occluded';
      confBadge.className = 'badge badge-warn';
    }
    return;
  }

  const i = ind.indicators;
  $('ind-le').textContent = fmtAngle(i.leftElbowDeg);
  $('ind-re').textContent = fmtAngle(i.rightElbowDeg);
  $('ind-torso').textContent = fmtAngle(i.torsoInclinationDeg);
  $('ind-lk').textContent = fmtAngle(i.leftKneeDeg);
  $('ind-rk').textContent = fmtAngle(i.rightKneeDeg);
  $('ind-st').textContent = fmtAngle(i.shoulderTiltDeg);

  if (confBadge) {
    const pct = Math.round(ind.overallConfidence * 100);
    confBadge.textContent = `Confidence: ${pct}%`;
    confBadge.className = `badge ${pct >= 70 ? 'badge-ok' : pct >= 40 ? 'badge-warn' : 'badge-bad'}`;
  }
}

/* ------------------------------ REPLAY POSE OVERLAY ------------------------------ */
function renderReplayPoseFrame(video, canvas, onIndicators = null) {
  if (!video || !canvas || video.readyState < 2) return;
  alignCanvasToVideo(video, canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (!replayPoseOverlayVisible) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  if (!poseTracker) {
    poseTracker = new PoseTracker({ config: CONFIG.pose });
  }

  if (poseTracker.state === POSE_STATE.READY) {
    const res = poseTracker.processFrame(video, performance.now());
    if (res && res.detected && res.landmarks) {
      poseTracker.drawOverlay(ctx, res.landmarks, canvas.width, canvas.height);
      if (onIndicators) onIndicators(res.indicators);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (onIndicators) onIndicators(null);
    }
  } else if (poseTracker.state === POSE_STATE.UNINITIALIZED) {
    poseTracker.init().then((ok) => {
      if (ok && video.readyState >= 2) {
        renderReplayPoseFrame(video, canvas, onIndicators);
      }
    });
  }
}

function attachReplayPoseLoop(video, canvas, onIndicators = null) {
  if (!video || !canvas) return () => {};

  let frameCbId = null;
  let isDestroyed = false;

  const cancelCb = () => {
    if (frameCbId !== null) {
      if ('cancelVideoFrameCallback' in video) {
        try { video.cancelVideoFrameCallback(frameCbId); } catch {}
      } else {
        try { cancelAnimationFrame(frameCbId); } catch {}
      }
      frameCbId = null;
    }
  };

  const onNextFrame = () => {
    if (isDestroyed) return;
    renderReplayPoseFrame(video, canvas, onIndicators);
    if (!video.paused && !video.ended) {
      if ('requestVideoFrameCallback' in video) {
        frameCbId = video.requestVideoFrameCallback(onNextFrame);
      } else {
        frameCbId = requestAnimationFrame(onNextFrame);
      }
    }
  };

  const onPlay = () => {
    cancelCb();
    if ('requestVideoFrameCallback' in video) {
      frameCbId = video.requestVideoFrameCallback(onNextFrame);
    } else {
      frameCbId = requestAnimationFrame(onNextFrame);
    }
  };

  const onPauseOrSeek = () => {
    cancelCb();
    renderReplayPoseFrame(video, canvas, onIndicators);
  };

  const onResize = () => {
    alignCanvasToVideo(video, canvas);
    renderReplayPoseFrame(video, canvas, onIndicators);
  };

  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPauseOrSeek);
  video.addEventListener('seeked', onPauseOrSeek);
  video.addEventListener('timeupdate', onPauseOrSeek);
  video.addEventListener('loadeddata', onPauseOrSeek);
  window.addEventListener('resize', onResize);

  if (video.readyState >= 2) {
    alignCanvasToVideo(video, canvas);
    renderReplayPoseFrame(video, canvas, onIndicators);
  }

  return () => {
    isDestroyed = true;
    cancelCb();
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPauseOrSeek);
    video.removeEventListener('seeked', onPauseOrSeek);
    video.removeEventListener('timeupdate', onPauseOrSeek);
    video.removeEventListener('loadeddata', onPauseOrSeek);
    window.removeEventListener('resize', onResize);
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };
}

function ensureReplayPose(video, canvas, onIndicators) {
  if (!video || !canvas) return;
  if (video._replayPoseCleanup) {
    alignCanvasToVideo(video, canvas);
    renderReplayPoseFrame(video, canvas, onIndicators);
    return;
  }
  if (!poseTracker) {
    poseTracker = new PoseTracker({ config: CONFIG.pose });
  }
  if (poseTracker.state === POSE_STATE.UNINITIALIZED) {
    poseTracker.init().then(() => {
      if (video.readyState >= 2) {
        alignCanvasToVideo(video, canvas);
        renderReplayPoseFrame(video, canvas, onIndicators);
      }
    });
  }
  video._replayPoseCleanup = attachReplayPoseLoop(video, canvas, onIndicators);
}

function stopReplayPose(video = null) {
  if (video && video._replayPoseCleanup) {
    video._replayPoseCleanup();
    video._replayPoseCleanup = null;
  }
  if (!video) {
    const v1 = $('replay-video');
    if (v1 && v1._replayPoseCleanup) {
      v1._replayPoseCleanup();
      v1._replayPoseCleanup = null;
    }
    const v2 = $('rep-replay-video');
    if (v2 && v2._replayPoseCleanup) {
      v2._replayPoseCleanup();
      v2._replayPoseCleanup = null;
    }
  }
}

function updateReportPoseIndicators(ind) {
  const confBadge = $('rep-pose-conf');
  const fmtAngle = (deg) => deg !== null && Number.isFinite(deg) ? `${deg.toFixed(0)}°` : '—';
  if (!ind || !ind.available || !ind.indicators) {
    const elLe = $('rep-ind-le'); if (elLe) elLe.textContent = '—';
    const elRe = $('rep-ind-re'); if (elRe) elRe.textContent = '—';
    const elT = $('rep-ind-torso'); if (elT) elT.textContent = '—';
    const elLk = $('rep-ind-lk'); if (elLk) elLk.textContent = '—';
    const elRk = $('rep-ind-rk'); if (elRk) elRk.textContent = '—';
    const elSt = $('rep-ind-st'); if (elSt) elSt.textContent = '—';
    if (confBadge) {
      confBadge.textContent = 'Confidence: low/occluded';
      confBadge.className = 'badge badge-warn';
    }
    return;
  }
  const i = ind.indicators;
  const elLe = $('rep-ind-le'); if (elLe) elLe.textContent = fmtAngle(i.leftElbowDeg);
  const elRe = $('rep-ind-re'); if (elRe) elRe.textContent = fmtAngle(i.rightElbowDeg);
  const elT = $('rep-ind-torso'); if (elT) elT.textContent = fmtAngle(i.torsoInclinationDeg);
  const elLk = $('rep-ind-lk'); if (elLk) elLk.textContent = fmtAngle(i.leftKneeDeg);
  const elRk = $('rep-ind-rk'); if (elRk) elRk.textContent = fmtAngle(i.rightKneeDeg);
  const elSt = $('rep-ind-st'); if (elSt) elSt.textContent = fmtAngle(i.shoulderTiltDeg);
  if (confBadge) {
    const pct = Math.round((ind.overallConfidence || 0) * 100);
    confBadge.textContent = `Confidence: ${pct}%`;
    confBadge.className = `badge ${pct >= 70 ? 'badge-ok' : pct >= 40 ? 'badge-warn' : 'badge-bad'}`;
  }
}

/* ------------------------------ SWING TIMELINE & REPLAY ------------------------------ */
function updateLiveSwingTimeline() {
  const chipsBox = $('swing-chips');
  const track = $('swing-timeline-track');
  if (!chipsBox || !track) return;

  if (!liveSwings.length) {
    chipsBox.innerHTML = '<span class="muted small">No swings detected yet. Swing the equipment to see synchronized events here.</span>';
    track.innerHTML = '';
    return;
  }

  const totalDuration = Math.max(1000, active ? active.durationMs : 1000);

  // Markers on timeline
  track.innerHTML = liveSwings.map((s, i) => {
    const pct = Math.min(100, Math.max(0, (s.t / totalDuration) * 100));
    return `<div class="timeline-swing-marker ${activeLiveReplayIndex === i ? 'active' : ''}" style="left: ${pct}%;" data-idx="${i}" title="Swing #${i + 1} at ${(s.t / 1000).toFixed(1)}s (${fmt(s.speedKmh)} km/h)"></div>`;
  }).join('');

  // Chips
  chipsBox.innerHTML = liveSwings.map((s, i) => {
    const activeClass = activeLiveReplayIndex === i ? 'active' : '';
    const vTime = s.videoS !== null && s.videoS !== undefined ? `${s.videoS.toFixed(1)}s` : 'no video';
    return `<button type="button" class="swing-chip ${activeClass}" data-idx="${i}">
      <span>#${i + 1}</span>
      <span class="chip-speed">${fmt(s.speedKmh)} km/h</span>
      <small class="muted">t=${(s.t / 1000).toFixed(1)}s (📹 ${vTime})</small>
    </button>`;
  }).join('');
}

function selectLiveSwing(idx) {
  if (idx < 0 || idx >= liveSwings.length) return;
  activeLiveReplayIndex = idx;
  updateLiveSwingTimeline();

  const s = liveSwings[idx];
  const wrap = $('swing-replay-wrap');
  if (!wrap) return;
  wrap.hidden = false;

  $('replay-swing-title').textContent = `Swing #${idx + 1} Details & Replay`;
  const statsBox = $('replay-stats');
  if (statsBox) {
    statsBox.innerHTML = `
      <div class="stat"><span class="stat-l">Estimated Speed</span><span class="stat-v">${fmt(s.speedKmh)}</span><span class="stat-u">km/h</span></div>
      <div class="stat"><span class="stat-l">Peak Rotation</span><span class="stat-v">${fmt(s.peakDps, 0)}</span><span class="stat-u">°/s</span></div>
      <div class="stat"><span class="stat-l">Peak Accel</span><span class="stat-v">${fmt(s.peakG, 2)}</span><span class="stat-u">g</span></div>
      <div class="stat"><span class="stat-l">Duration</span><span class="stat-v">${fmt(s.durationMs, 0)}</span><span class="stat-u">ms</span></div>
    `;
  }

  // Synchronize interactive live graphs: center chart view around this swing
  if (charts.accel && active) {
    const windowMs = CONFIG.charts.windowSeconds * 1000;
    const centerT = s.t;
    const minS = Math.max(0, (centerT - windowMs / 2) / 1000);
    const maxS = minS + CONFIG.charts.windowSeconds;
    charts.accel.options.scales.x.min = minS;
    charts.accel.options.scales.x.max = maxS;
    charts.gyro.options.scales.x.min = minS;
    charts.gyro.options.scales.x.max = maxS;
    charts.accel.update('none');
    charts.gyro.update('none');
  }

  // Replay video clip if recording or recorded
  const video = $('replay-video');
  const canvas = $('replay-pose-canvas');
  if (!video) return;

  if (s.pose && s.pose.indicators) {
    updatePoseIndicatorsDisplay(s.pose);
  }

  if (canvas) {
    ensureReplayPose(video, canvas, updatePoseIndicatorsDisplay);
  }

  const preS = Number($('sync-pad-pre')?.value) || 1.5;
  const postS = Number($('sync-pad-post')?.value) || 1.5;

  let streamOrBlobUrl = '';
  if (mediaStore.has(active?.id)) {
    streamOrBlobUrl = mediaStore.get(active.id).url;
  }

  // Recalculate video timestamp with current calibrationOffsetMs
  const vm = sensorTimeToVideo(s.t, clockMap, recorder?.timeline, calibrationOffsetMs, active ? active.durationMs : null);
  const targetVideoS = vm.videoS;

  const calVal = $('cal-offset-val');
  if (calVal) calVal.textContent = `${calibrationOffsetMs >= 0 ? '+' : ''}${calibrationOffsetMs} ms`;
  const uncEl = $('sync-uncertainty-badge');
  if (uncEl) {
    const unc = estimateUncertainty({
      jitterMs: clockMap.typicalJitterMs() || 5,
      sampleIntervalMs: active ? active.nominalMs : 20,
      fps: 30,
      startUncertaintyMs: recorder?.startUncertaintyMs || 0,
      calibrated: calibrationOffsetMs !== 0,
    });
    uncEl.textContent = `Uncertainty: ±${unc.plusMinusMs} ms`;
    uncEl.title = unc.note;
  }

  if (targetVideoS !== null && streamOrBlobUrl) {
    if (video.src !== streamOrBlobUrl) video.src = streamOrBlobUrl;
    const win = replayWindow(targetVideoS, preS, postS, video.duration || Infinity);
    if (win) {
      video.currentTime = win.startS;
      video.play().catch(() => {});
      if (liveReplayTimer) clearTimeout(liveReplayTimer);
      const playDurationMs = (win.endS - win.startS) * 1000;
      liveReplayTimer = setTimeout(() => {
        video.pause();
        video.currentTime = targetVideoS;
      }, playDurationMs);
    }
  }
}

/* ------------------------------ LIVE VIEW ------------------------------ */
function updateControls() {
  const st = active ? active.state : 'none';
  $('btn-start').hidden = st !== 'none';
  $('btn-pause').hidden = st !== 'running';
  $('btn-resume').hidden = st !== 'paused';
  $('btn-stop').disabled = !(st === 'running' || st === 'paused');
  $('btn-reset-sim').hidden = !(active && active.mode === 'demo');
  $('live-empty').hidden = st !== 'none';
  $('live-body').hidden = st === 'none';
}

function updateLiveHeader() {
  const s = active;
  const sport = s ? s.sport : settings.sport;
  const mode = s ? s.mode : settings.mode;
  const name = s ? s.name : settings.name;
  $('live-sub').textContent = `${EMOJI[sport]} ${sportLabel(sport)}${name ? ` · ${name}` : ''}`;
  const src = $('live-source');
  src.textContent = mode === 'demo' ? 'DEMO — simulated data' : 'LIVE HARDWARE';
  src.className = `badge ${mode === 'demo' ? 'badge-demo' : 'badge-live'}`;
  const st = $('live-state');
  const label = !s ? 'No session' : s.state === 'running' ? '● Recording' : s.state === 'paused' ? '⏸ Paused' : 'Stopped';
  st.textContent = label;
  st.className = `badge ${s && s.state === 'running' ? 'badge-bad' : s && s.state === 'paused' ? 'badge-warn' : 'badge-off'}`;
}

function renderLiveNote() {
  const el = $('live-note');
  const mode = currentMode();
  if (mode === 'demo') {
    el.hidden = !active;
    el.className = 'notice notice-warn';
    el.textContent = 'Demo Mode: all readings below are SIMULATED, not physical measurements.';
    return;
  }
  const n = liveNoteFor(live.state);
  el.hidden = false;
  el.className = `notice notice-${n.kind === 'ok' ? 'ok' : n.kind === 'warn' ? 'warn' : 'bad'}`;
  let t = n.text;
  if (active && active.invalidCount) t += ` (${active.invalidCount} malformed sample${active.invalidCount === 1 ? '' : 's'} ignored)`;
  el.textContent = t;
}

function ensureCharts() {
  if (!window.Chart) { banner('Chart.js failed to load (is /vendor/chart.umd.js reachable?). Graphs are unavailable.'); return false; }
  if (!charts.accel) {
    charts.accel = createChart($('chart-accel'), 'accel');
    charts.gyro = createChart($('chart-gyro'), 'gyro');
  }
  return true;
}

let renderPending = false;
let lastRender = 0;
function scheduleRender() {
  if (renderPending || currentView !== 'live') return;
  renderPending = true;
  const wait = Math.max(0, 1000 / CONFIG.charts.renderFps - (performance.now() - lastRender));
  setTimeout(() => requestAnimationFrame(renderLive), wait);
}

function renderLive() {
  renderPending = false;
  lastRender = performance.now();
  if (currentView !== 'live') return;
  updateLiveHeader();
  renderLiveNote();
  const s = active;
  const m = s ? s.metrics() : null;
  $('st-duration').textContent = formatDuration(s ? s.durationMs : 0);
  $('st-swings').textContent = m ? m.totalSwings : 0;
  $('st-avg').textContent = fmt(m?.avgSpeedKmh);
  $('st-max').textContent = fmt(m?.maxSpeedKmh);
  $('st-maxa').textContent = fmt(m?.maxAccelG, 2);
  $('st-last').textContent = lastSwing ? fmt(lastSwing.speedKmh) : '—';
  $('st-last-u').innerHTML = lastSwing ? `km/h · peak ${fmt(lastSwing.peakDps, 0)} °/s` : '&nbsp;';
  const r = latest;
  const set = (id, v, d) => { $(id).textContent = r ? fmt(v, d) : '—'; };
  set('v-ax', r?.[1], 2); set('v-ay', r?.[2], 2); set('v-az', r?.[3], 2);
  set('v-am', r && magnitude(r[1], r[2], r[3]), 2);
  set('v-gx', r?.[4], 0); set('v-gy', r?.[5], 0); set('v-gz', r?.[6], 0);
  set('v-gm', r && magnitude(r[4], r[5], r[6]), 0);
  if (s && ensureCharts()) {
    const windowMs = CONFIG.charts.windowSeconds * 1000;
    const tNow = s.durationMs;
    const rows = liveRows.filter((x) => x[0] >= tNow - windowMs);
    updateLive(charts.accel, rows, s.swings, tNow, windowMs);
    updateLive(charts.gyro, rows, s.swings, tNow, windowMs);
  }
}

function showLive() {
  $('win-s').textContent = CONFIG.charts.windowSeconds;
  updateControls();
  renderLive();
  if (charts.accel) { charts.accel.resize(); charts.gyro.resize(); }
}

/* ------------------------------ REPORT ------------------------------ */
function destroyReportCharts() {
  reportCharts.forEach((c) => c.destroy());
  reportCharts = [];
}

async function renderReport(id, token) {
  const box = $('report-content');
  destroyReportCharts();
  box.innerHTML = '<div class="card empty"><p class="muted">Loading report…</p></div>';
  let rec = unsaved.get(id) || null;
  let storageError = '';
  if (!rec) {
    try { rec = await getSession(id); } catch (e) { storageError = e.message; }
  }
  if (token !== routeToken) return;
  if (!rec) {
    box.innerHTML = `<div class="card empty"><h1 id="report-title">Report not found</h1><p class="muted">${esc(storageError || 'This session does not exist (it may have been deleted).')}</p><a class="btn btn-ghost" href="#history">Open history</a> <a class="btn btn-ghost" href="#home">Dashboard</a></div>`;
    return;
  }
  activeReportRec = rec;
  const m = rec.metrics;
  const c = m.consistency;
  const tile = (l, v, u = '') => `<div class="stat"><span class="stat-l">${l}</span><span class="stat-v">${v}</span><span class="stat-u">${u || '&nbsp;'}</span></div>`;
  const isUnsaved = unsaved.has(rec.id);
  const label = sportLabel(rec.sport);
  const mediaEntry = mediaStore.get(rec.id);
  const hasVideoInMemory = !!mediaEntry && !!mediaEntry.url;
  const hadVideoRecorded = !!rec.video?.recorded;

  let videoSectionHtml = '';
  if (hasVideoInMemory) {
    const ext = rec.video?.mimeType?.includes('mp4') ? 'mp4' : 'webm';
    videoSectionHtml = `
      <section class="card" style="margin-bottom: 16px;">
        <div class="cam-card-header">
          <div>
            <h2 class="card-title" style="margin:0;">Synchronized Video &amp; Pose Replay</h2>
            <p class="muted small">Replay recorded swings aligned with sensor graphs. Video is kept in browser memory only.</p>
          </div>
          <div class="actions">
            <button id="rep-pose-toggle" class="btn btn-ghost btn-sm" type="button">Toggle Pose Overlay</button>
            <button id="rep-dl-video" class="btn btn-primary btn-sm" type="button">Download Video (.${ext})</button>
          </div>
        </div>
        <div class="replay-player-row">
          <div class="replay-video-box">
            <video id="rep-replay-video" playsinline controls src="${mediaEntry.url}"></video>
            <canvas id="rep-replay-pose-canvas"></canvas>
          </div>
          <div class="replay-info-box">
            <h3 id="rep-selected-title" style="font-size:1.05rem; margin-bottom: 8px;">Selected Swing Pose &amp; Timing</h3>
            <div id="rep-pose-box" class="pose-indicators-card" style="margin-bottom: 10px;">
              <div class="indicators-header">
                <span class="stat-l">Pose Indicators at Peak</span>
                <span id="rep-pose-conf" class="badge badge-off">Select a swing below</span>
              </div>
              <div class="grid-indicators">
                <div class="ind-item"><span class="ind-l">Left Elbow</span><b id="rep-ind-le">—</b></div>
                <div class="ind-item"><span class="ind-l">Right Elbow</span><b id="rep-ind-re">—</b></div>
                <div class="ind-item"><span class="ind-l">Torso Lean</span><b id="rep-ind-torso">—</b></div>
                <div class="ind-item"><span class="ind-l">Left Knee</span><b id="rep-ind-lk">—</b></div>
                <div class="ind-item"><span class="ind-l">Right Knee</span><b id="rep-ind-rk">—</b></div>
                <div class="ind-item"><span class="ind-l">Shoulder Tilt</span><b id="rep-ind-st">—</b></div>
              </div>
              <p class="muted" style="font-size: 11px; margin: 8px 0 0; line-height: 1.3;">
                2D optical estimates (not 3D biomechanics or medical advice). Angles reflect camera-plane projection.
              </p>
            </div>
            <div class="calibration-row">
              <label class="field" style="width: 100%;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span class="small"><b>Sync Calibration:</b> <b id="rep-cal-val">${(rec.video?.calibrationOffsetMs || 0) >= 0 ? '+' : ''}${rec.video?.calibrationOffsetMs || 0} ms</b></span>
                  <span id="rep-unc-badge" class="muted small" title="Estimated bound based on 50 Hz sensor sampling and 30 fps video. Precision is an estimate unless measured against a reference.">Precision: ±${rec.video?.uncertaintyMs || 35} ms</span>
                </div>
                <input id="rep-cal-slider" type="range" min="-500" max="500" step="10" value="${rec.video?.calibrationOffsetMs || 0}" aria-label="Sync calibration offset in milliseconds">
                <p class="muted small sync-help-text" style="font-size: 11px; margin: 4px 0 0; line-height: 1.35;">
                  <strong>Offset direction:</strong> <b>+ms</b> shifts video playback later (if visual swing lags the sensor peak); <b>−ms</b> shifts earlier. <em>Precision</em> is an estimate based on sample/frame periods.
                </p>
              </label>
            </div>
          </div>
        </div>
        <p class="muted small" style="margin: 10px 0 0;">
          Privacy: Videos are stored only in this browser tab's RAM and disappear when you refresh or close the tab. Click <strong>Download Video</strong> to save a permanent copy.
        </p>
      </section>
    `;
  } else if (hadVideoRecorded) {
    videoSectionHtml = `
      <section class="card" style="margin-bottom: 16px;">
        <h2 class="card-title">Synchronized Video</h2>
        <p class="notice notice-info">
          Video was recorded for this session (${rec.video.durationS?.toFixed(1) || '—'} s). For privacy and browser memory safety, video is not stored in IndexedDB. If you downloaded the video previously, attach it to restore synchronized replay.
        </p>
        <div class="actions" style="margin-top: 10px;">
          <button id="rep-attach-video-btn" class="btn btn-ghost btn-sm" type="button">Attach Downloaded Video File (.webm/.mp4)</button>
        </div>
      </section>
    `;
  }

  box.innerHTML = `
    <div class="report-head">
      <div>
        <h1 id="report-title" class="page-title">${EMOJI[rec.sport]} Session Report — ${esc(label)}</h1>
        <p class="muted">${esc(rec.name || 'Untitled session')} · ${new Date(rec.startedAt).toLocaleString()}</p>
      </div>
      <div><span class="badge ${rec.mode === 'demo' ? 'badge-demo' : 'badge-live'}">${rec.mode === 'demo' ? 'DEMO — simulated data' : 'LIVE HARDWARE data'}</span></div>
    </div>
    ${isUnsaved ? '<p class="notice notice-bad">This session is NOT saved to browser storage. <button id="rep-retry" class="btn btn-ghost btn-sm" type="button">Retry save</button> or export it below.</p>' : ''}
    ${rec.mode === 'demo' ? '<p class="notice notice-warn">These results come from simulated sensor data and do not describe a real physical swing.</p>' : ''}
    <div class="report-grid">
      ${tile('Sport', esc(label))}
      ${rec.equipment && Number.isFinite(rec.equipment.lengthInches) && Number.isFinite(rec.equipment.weightGrams)
        ? tile('Equipment', `${rec.equipment.lengthInches}" · ${rec.equipment.weightGrams} g`, `${CONFIG.sports[rec.sport]?.equipment || 'equipment'} (below grip)`)
        : tile('Equipment', 'Not recorded', 'older session format')}
      ${tile('Active duration', formatDuration(rec.activeDurationMs), 'paused time excluded')}
      ${tile('Total swings', m.totalSwings, `${fmt(m.swingsPerMinute, 1)} per minute`)}
      ${tile('Avg est. swing speed', fmt(m.avgSpeedKmh), 'km/h (estimate)')}
      ${tile('Max est. swing speed', fmt(m.maxSpeedKmh), 'km/h (estimate)')}
      ${tile('Avg angular velocity', fmt(m.avgGyroDps, 0), '°/s over active time')}
      ${tile('Max angular velocity', fmt(m.maxGyroDps, 0), '°/s')}
      ${tile('Max acceleration', fmt(m.maxAccelG, 2), 'g (magnitude)')}
      ${tile('Swing consistency', c.score === null ? 'Insufficient data' : `${c.score}/100`, c.score === null ? 'needs ≥ 3 swings' : `${c.status} · peak ω CV ${(c.cv * 100).toFixed(0)}%`)}
    </div>

    ${videoSectionHtml}

    <section class="card summary"><h2 class="card-title">Performance summary</h2><p style="margin:0">${esc(buildSummaryText(m, label, rec.mode, rec.equipment))}</p>
      <p class="muted small" style="margin:10px 0 0">Estimated swing speed = peak angular velocity × effective radius (${rec.settings.radiusM} m). Calculated from equipment dimensions and rotation geometry (sensor mounted below grip). It is an estimate of hitting-zone speed, NOT ball speed or impact force.${rec.storedStride > 1 ? ` Graph data was thinned (every ${rec.storedStride}th sample stored); statistics use all samples.` : ''}</p></section>
    <div class="grid g3">
      <section class="card chart-card-interactive" data-kind="accel" role="button" tabindex="0" aria-label="Click to expand acceleration graph">
        <div class="chart-head-actions">
          <h2 class="card-title" style="margin:0">Acceleration <small>(g) — full session</small></h2>
          <span class="btn-expand-badge" title="Expand graph">Expand ⛶</span>
        </div>
        <div class="chart-wrap tall"><canvas id="rep-accel" role="img" aria-label="Session acceleration graph"></canvas></div>
      </section>
      <section class="card chart-card-interactive" data-kind="gyro" role="button" tabindex="0" aria-label="Click to expand angular velocity graph">
        <div class="chart-head-actions">
          <h2 class="card-title" style="margin:0">Angular velocity <small>(°/s) — full session</small></h2>
          <span class="btn-expand-badge" title="Expand graph">Expand ⛶</span>
        </div>
        <div class="chart-wrap tall"><canvas id="rep-gyro" role="img" aria-label="Session angular velocity graph"></canvas></div>
      </section>
      <section class="card chart-card-interactive" data-kind="speed" role="button" tabindex="0" aria-label="Click to expand estimated speed graph">
        <div class="chart-head-actions">
          <h2 class="card-title" style="margin:0">Estimated Speed <small>(km/h) — full session</small></h2>
          <span class="btn-expand-badge" title="Expand graph">Expand ⛶</span>
        </div>
        <div class="chart-wrap tall"><canvas id="rep-speed" role="img" aria-label="Session estimated speed graph"></canvas></div>
      </section>
    </div>
    <section class="card"><h2 class="card-title">Detected swings</h2>
      ${rec.swings.length ? `<div class="table-scroll"><table><thead><tr><th>#</th><th>Sensor Time (s)</th>${hadVideoRecorded || hasVideoInMemory ? '<th>Video (s)</th>' : ''}<th>Peak ω (°/s)</th><th>Peak |a| (g)</th><th>Duration (ms)</th><th>Est. speed (km/h)</th>${hasVideoInMemory ? '<th>Replay</th>' : ''}</tr></thead><tbody>${rec.swings.map((s, i) => {
        const baseVideoS = s.videoS !== null && s.videoS !== undefined ? s.videoS : null;
        const vText = baseVideoS !== null ? `${Math.max(0, baseVideoS + ((rec.video?.calibrationOffsetMs || 0) / 1000)).toFixed(2)}s` : '—';
        return `<tr>
          <td>${i + 1}</td>
          <td>${(s.t / 1000).toFixed(2)}</td>
          ${hadVideoRecorded || hasVideoInMemory ? `<td class="rep-video-cell" data-base-video-s="${baseVideoS !== null ? baseVideoS : ''}">${vText}</td>` : ''}
          <td>${s.peakDps.toFixed(0)}</td>
          <td>${s.peakG.toFixed(2)}</td>
          <td>${s.durationMs.toFixed(0)}</td>
          <td>${s.speedKmh.toFixed(1)}</td>
          ${hasVideoInMemory ? `<td><button type="button" class="btn btn-ghost btn-sm btn-rep-swing" data-idx="${i}">▶ Replay</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">No swings detected in this session.</p>'}
    </section>
    <div class="actions" style="margin-top:16px">
      <a class="btn btn-primary" href="#home">Back to dashboard</a>
      <a class="btn btn-ghost" href="#history">Session history</a>
      <button id="rep-json" class="btn btn-ghost" type="button">Export JSON</button>
      <button id="rep-csv" class="btn btn-ghost" type="button">Export CSV</button>
      ${isUnsaved ? '' : '<button id="rep-del" class="btn btn-danger" type="button">Delete session</button>'}
    </div>`;

  $('rep-json').addEventListener('click', () => exportJson([rec], fileBase(rec)));
  $('rep-csv').addEventListener('click', () => download(`${fileBase(rec)}.csv`, toCsv(rec), 'text/csv'));
  $('rep-del')?.addEventListener('click', () => removeSession(rec, true));
  $('rep-retry')?.addEventListener('click', async () => {
    try { await saveSession(rec); unsaved.delete(rec.id); banner(''); toast('Session saved.'); renderReport(rec.id, routeToken); } catch (e) { toast(`Save failed: ${e.message}`, 'bad'); }
  });

  if (hasVideoInMemory) {
    const ext = rec.video?.mimeType?.includes('mp4') ? 'mp4' : 'webm';
    const repVid = $('rep-replay-video');
    const repCanvas = $('rep-replay-pose-canvas');

    if (repVid && repCanvas) {
      ensureReplayPose(repVid, repCanvas, updateReportPoseIndicators);
    }

    $('rep-pose-toggle')?.addEventListener('click', () => {
      replayPoseOverlayVisible = !replayPoseOverlayVisible;
      toast(replayPoseOverlayVisible ? 'Pose overlay enabled on replay.' : 'Pose overlay hidden.');
      if (repVid && repCanvas) {
        renderReplayPoseFrame(repVid, repCanvas, updateReportPoseIndicators);
      }
    });

    $('rep-dl-video')?.addEventListener('click', () => {
      download(`${fileBase(rec)}.${ext}`, mediaEntry.blob, mediaEntry.blob.type || 'video/webm');
      mediaStore.markDownloaded(rec.id);
    });

    const repSlider = $('rep-cal-slider');
    repSlider?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      rec.video.calibrationOffsetMs = val;
      const vEl = $('rep-cal-val');
      if (vEl) vEl.textContent = `${val >= 0 ? '+' : ''}${val} ms`;

      box.querySelectorAll('.rep-video-cell').forEach((cell) => {
        const base = Number(cell.dataset.baseVideoS);
        if (Number.isFinite(base)) {
          cell.textContent = `${Math.max(0, base + val / 1000).toFixed(2)}s`;
        }
      });

      if (activeReportSwingIdx >= 0 && rec.swings[activeReportSwingIdx]) {
        const sw = rec.swings[activeReportSwingIdx];
        const base = sw.videoS ?? (sw.t / 1000);
        const target = Math.max(0, base + val / 1000);
        if (repVid && repVid.readyState >= 2) {
          repVid.currentTime = target;
        }
      }
    });

    box.querySelectorAll('.btn-rep-swing').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        replayReportSwing(rec, idx);
      });
    });
  }

  $('rep-attach-video-btn')?.addEventListener('click', () => {
    const fi = $('video-attach-file');
    if (fi) {
      fi._attachSessionId = rec.id;
      fi.click();
    }
  });

  box.querySelectorAll('.chart-card-interactive').forEach((card) => {
    const open = () => openExpandedChart(card.dataset.kind, rec);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  if (window.Chart) {
    const totalSec = (rec.activeDurationMs || 0) / 1000;
    const rows = downsampleRows(rec.samples, CONFIG.charts.reportMaxPoints);
    const a = createChart($('rep-accel'), 'accel');
    const g = createChart($('rep-gyro'), 'gyro');
    const s = createChart($('rep-speed'), 'speed', { radiusM: rec.settings.radiusM });
    setReport(a, rows, rec.swings, totalSec);
    setReport(g, rows, rec.swings, totalSec);
    setReport(s, rows, rec.swings, totalSec);
    reportCharts = [a, g, s];
  } else {
    banner('Chart.js failed to load; report graphs are unavailable.');
  }
}

function updateModalRangeLabel() {
  if (!modalChart) return;
  const min = modalChart.options.scales.x.min ?? 0;
  const max = modalChart.options.scales.x.max ?? (modalChart._totalDurationS || 0);
  const total = modalChart._totalDurationS || 0;
  const el = $('modal-chart-range');
  if (el) el.textContent = `Visible: ${min.toFixed(2)} s – ${max.toFixed(2)} s (Total: ${total.toFixed(1)} s)`;
}

function replayReportSwing(rec, idx) {
  if (!rec || !rec.swings || idx < 0 || idx >= rec.swings.length) return;
  activeReportSwingIdx = idx;
  const s = rec.swings[idx];
  const video = $('rep-replay-video');
  const canvas = $('rep-replay-pose-canvas');
  const title = $('rep-selected-title');
  if (title) title.textContent = `Swing #${idx + 1} at ${(s.t / 1000).toFixed(2)}s (${fmt(s.speedKmh)} km/h)`;

  if (s.pose && s.pose.indicators) {
    updateReportPoseIndicators(s.pose);
  } else {
    updateReportPoseIndicators(null);
  }

  if (!video) return;
  if (canvas) {
    ensureReplayPose(video, canvas, updateReportPoseIndicators);
  }

  const calOffset = rec.video?.calibrationOffsetMs || 0;
  const baseVideoS = s.videoS ?? (s.t / 1000);
  const targetVideoS = Math.max(0, baseVideoS + (calOffset / 1000));

  const preS = 1.5;
  const postS = 1.5;
  const win = replayWindow(targetVideoS, preS, postS, video.duration || Infinity);
  if (win && Number.isFinite(win.startS)) {
    video.currentTime = win.startS;
    video.play().catch(() => {});
    if (reportReplayTimer) clearTimeout(reportReplayTimer);
    const playMs = (win.endS - win.startS) * 1000;
    reportReplayTimer = setTimeout(() => {
      video.pause();
      video.currentTime = targetVideoS;
    }, playMs);
  }
}

function openExpandedChart(kind, rec) {
  if (!window.Chart || !rec) return;
  modalActiveRec = rec;
  const dialog = $('chart-modal');
  const spec = SPEC[kind] || SPEC.accel;
  const titleEl = $('modal-chart-title');
  const subEl = $('modal-chart-sub');
  if (titleEl) titleEl.textContent = `${EMOJI[rec.sport]} ${sportLabel(rec.sport)} — ${spec.title}`;
  if (subEl) subEl.textContent = `${rec.name || 'Untitled session'} · ${new Date(rec.startedAt).toLocaleString()} · Drag along timeline to pan, scroll wheel or pinch to zoom`;

  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
  if (modalRemoveControls) {
    modalRemoveControls();
    modalRemoveControls = null;
  }

  const canvas = $('modal-chart-canvas');
  modalChart = createChart(canvas, kind, { radiusM: rec.settings.radiusM, isModal: true });
  const totalSec = (rec.activeDurationMs || 0) / 1000;
  const modalMaxPoints = Math.min(5000, Math.max(CONFIG.charts.reportMaxPoints, rec.samples.length));
  const rows = downsampleRows(rec.samples, modalMaxPoints);
  setReport(modalChart, rows, rec.swings, totalSec);

  modalRemoveControls = attachInteractiveControls(modalChart, canvas, updateModalRangeLabel);
  updateModalRangeLabel();

  dialog.showModal();
  $('btn-zoom-reset')?.focus();
}

function closeExpandedChart() {
  const dialog = $('chart-modal');
  if (dialog && dialog.open) dialog.close();
  if (modalRemoveControls) {
    modalRemoveControls();
    modalRemoveControls = null;
  }
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
  modalActiveRec = null;
}

async function removeSession(rec, fromReport) {
  const ok = await confirmDialog('Delete session?', `“${rec.name || sportLabel(rec.sport)}” from ${new Date(rec.startedAt).toLocaleString()} will be permanently deleted from this browser. Export it first if you want a backup.`, 'Delete');
  if (!ok) return;
  try {
    mediaStore.discard(rec.id);
    await deleteSession(rec.id);
    unsaved.delete(rec.id);
    toast('Session deleted.');
    if (fromReport) location.hash = '#history';
    else renderHistory(routeToken);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'bad');
  }
}

/* ------------------------------ HISTORY ------------------------------ */
async function renderHistory(token) {
  const box = $('history-list');
  box.innerHTML = '<div class="card empty"><p class="muted">Loading sessions…</p></div>';
  let list;
  try {
    list = await listSessions();
  } catch (e) {
    if (token === routeToken) box.innerHTML = `<div class="card empty"><h2>History unavailable</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  if (token !== routeToken) return;
  if (!list.length) {
    box.innerHTML = '<div class="card empty"><h2>No sessions yet</h2><p class="muted">Completed sessions appear here. You can also import a previously exported JSON file.</p><a class="btn btn-primary" href="#setup">Start a session</a></div>';
    return;
  }
  box.innerHTML = list.map((s) => `
    <article class="card hitem" data-id="${esc(s.id)}">
      <span class="emoji" aria-hidden="true">${EMOJI[s.sport]}</span>
      <div>
        <h3>${esc(s.name || sportLabel(s.sport))} <span class="badge ${s.mode === 'demo' ? 'badge-demo' : 'badge-live'}">${s.mode === 'demo' ? 'Demo' : 'Live'}</span></h3>
        <div class="hmeta">${sportLabel(s.sport)} · ${new Date(s.startedAt).toLocaleString()}</div>
        <div class="hstats">
          <span>Duration <b>${formatDuration(s.activeDurationMs)}</b></span>
          <span>Swings <b>${s.metrics.totalSwings}</b></span>
          <span>Avg speed <b>${fmt(s.metrics.avgSpeedKmh)}</b> km/h</span>
          <span>Max speed <b>${fmt(s.metrics.maxSpeedKmh)}</b> km/h</span>
          <span>Equipment <b>${s.equipment ? `${s.equipment.lengthInches}" · ${s.equipment.weightGrams}g` : '—'}</b></span>
          <span>Consistency <b>${s.metrics.consistency.score === null ? 'n/a' : s.metrics.consistency.score}</b></span>
        </div>
      </div>
      <div class="hactions">
        <a class="btn btn-primary btn-sm" href="#report/${encodeURIComponent(s.id)}">Open report</a>
        <button class="btn btn-ghost btn-sm" type="button" data-act="export">Export</button>
        <button class="btn btn-danger btn-sm" type="button" data-act="delete">Delete</button>
      </div>
    </article>`).join('');
  box._list = list;
}

async function onHistoryClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const meta = ($('history-list')._list || []).find((s) => s.id === id);
  if (!meta) return;
  if (btn.dataset.act === 'delete') return removeSession(meta, false);
  try {
    const rec = await getSession(id);
    if (!rec) throw new Error('Session not found');
    exportJson([rec], fileBase(rec));
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'bad');
  }
}

async function exportAll() {
  try {
    const list = await listSessions();
    if (!list.length) { toast('Nothing to export yet.', 'warn'); return; }
    const recs = [];
    for (const m of list) { const r = await getSession(m.id); if (r) recs.push(r); }
    exportJson(recs, `sports-monitor-backup-${new Date().toISOString().slice(0, 10)}`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'bad');
  }
}

async function onImportFile(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > CONFIG.limits.maxImportBytes) { toast('File is too large to import.', 'bad'); return; }
  try {
    const { valid, errors } = parseImportText(await file.text());
    if (!valid.length) { toast(`Import failed: ${errors[0] || 'no valid sessions'}`, 'bad'); return; }
    const { added, skipped } = await importRecords(valid);
    const parts = [`Imported ${added} session${added === 1 ? '' : 's'}`];
    if (skipped) parts.push(`${skipped} skipped (ID already exists)`);
    if (errors.length) parts.push(`${errors.length} invalid (${errors[0]})`);
    toast(parts.join(' · '), errors.length || skipped ? 'warn' : '');
    if (currentView === 'history') renderHistory(routeToken);
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'bad');
  }
}

/* ------------------------------ ROUTER ------------------------------ */
const VIEWS = ['home', 'setup', 'live', 'report', 'history'];
function route() {
  const [name0, arg] = (location.hash.slice(1) || 'home').split('/');
  const name = VIEWS.includes(name0) ? name0 : 'home';
  const token = ++routeToken;
  currentView = name;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (name !== 'report') {
    destroyReportCharts();
    closeExpandedChart();
  }
  if (name !== 'live' && active && !stopping) {
    stopSession();
  }
  if (!(active && active.mode === 'live') && live.wantOpen && name !== 'setup' && name !== 'home') live.disconnect();
  updateChrome();
  window.scrollTo(0, 0);
  if (name === 'home') renderHome(token);
  else if (name === 'setup') renderSetup();
  else if (name === 'live') showLive();
  else if (name === 'report') renderReport(decodeURIComponent(arg || ''), token);
  else if (name === 'history') renderHistory(token);
}

/* ------------------------------ wiring (once) ------------------------------ */
function init() {
  renderSports();
  $('home-sports').addEventListener('click', (e) => { const b = e.target.closest('[data-sport]'); if (b) setSport(b.dataset.sport); });
  $('setup-sports').addEventListener('change', (e) => { if (e.target.name === 'sport') setSport(e.target.value); });
  $('setup-form').addEventListener('submit', startFromSetup);
  $('setup-name').addEventListener('input', (e) => { settings.name = e.target.value; saveSettings(); });
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', (e) => {
    settings.mode = e.target.value;
    saveSettings();
    updateChrome();
    renderSetupLive();
  }));
  $('setup-test').addEventListener('click', () => {
    const hp = readHostPort();
    const err = $('setup-error');
    if (hp.error) { err.textContent = hp.error; err.hidden = false; return; }
    err.hidden = true;
    settings.host = hp.host;
    settings.port = hp.port;
    saveSettings();
    live.connect(hp.host, hp.port, true);
  });
  $('home-start').addEventListener('click', () => { location.hash = '#setup'; });
  $('home-check').addEventListener('click', () => {
    if (settings.mode === 'demo') toast('Demo Mode is selected, so the ESP8266 is not used. Switch to Live Hardware Mode in New Session to connect.', 'warn');
    live.connect(settings.host, settings.port, true);
  });
  $('btn-start').addEventListener('click', () => startSession());
  $('btn-pause').addEventListener('click', pauseSession);
  $('btn-resume').addEventListener('click', resumeSession);
  $('btn-stop').addEventListener('click', stopSession);
  $('btn-reset-sim').addEventListener('click', resetSimulator);
  $('history-list').addEventListener('click', onHistoryClick);
  $('hist-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', onImportFile);
  $('hist-export-all').addEventListener('click', exportAll);

  // Modal zoom and pan controls
  $('btn-zoom-in')?.addEventListener('click', () => { if (modalChart) { zoomChart(modalChart, 0.7); updateModalRangeLabel(); } });
  $('btn-zoom-out')?.addEventListener('click', () => { if (modalChart) { zoomChart(modalChart, 1.4); updateModalRangeLabel(); } });
  $('btn-pan-left')?.addEventListener('click', () => { if (modalChart) { panChart(modalChart, -0.25); updateModalRangeLabel(); } });
  $('btn-pan-right')?.addEventListener('click', () => { if (modalChart) { panChart(modalChart, 0.25); updateModalRangeLabel(); } });
  $('btn-zoom-reset')?.addEventListener('click', () => { if (modalChart) { resetChartZoom(modalChart); updateModalRangeLabel(); } });
  $('btn-modal-close')?.addEventListener('click', closeExpandedChart);

  let backdropDown = false;
  $('chart-modal')?.addEventListener('pointerdown', (e) => {
    backdropDown = (e.target === $('chart-modal'));
  });
  $('chart-modal')?.addEventListener('click', (e) => {
    if (e.target === $('chart-modal') && backdropDown) {
      closeExpandedChart();
    }
  });
  $('chart-modal')?.addEventListener('close', () => {
    closeExpandedChart();
  });

  // Live camera, pose and timeline replay controls
  $('btn-cam-enable')?.addEventListener('click', async () => {
    if (!recorder) recorder = new VideoRecorder({ video: CONFIG.video, onChange: () => updateCameraUi() });
    const ok = await recorder.openCamera();
    if (ok && recorder.stream) {
      const v = $('live-webcam-video');
      if (v) { v.srcObject = recorder.stream; v.play().catch(() => {}); }
      if (active && (active.state === 'running' || active.state === 'paused')) {
        recorder.startRecording(sessionOriginPerf);
        if (active.state === 'paused') recorder.pause();
      }
    }
    updateCameraUi();
  });

  $('btn-cam-synth')?.addEventListener('click', () => {
    if (!recorder) recorder = new VideoRecorder({ video: CONFIG.video, onChange: () => updateCameraUi() });
    if (syntheticCam) { syntheticCam.stop(); syntheticCam = null; }
    syntheticCam = createSyntheticCamera({
      getMotion: () => latest ? { t: latest[0], gyroMag: magnitude(latest[4], latest[5], latest[6]), accelMag: magnitude(latest[1], latest[2], latest[3]) } : null,
    });
    if (syntheticCam) {
      recorder.attachStream(syntheticCam.stream, 'synthetic');
      const v = $('live-webcam-video');
      if (v) { v.srcObject = syntheticCam.stream; v.play().catch(() => {}); }
      if (active && (active.state === 'running' || active.state === 'paused')) {
        recorder.startRecording(sessionOriginPerf);
        if (active.state === 'paused') recorder.pause();
      }
    }
    updateCameraUi();
  });

  $('btn-cam-toggle')?.addEventListener('click', async () => {
    if (!recorder) return;
    if (recorder.hasStream) {
      recorder.closeCamera(true);
      if (syntheticCam) { syntheticCam.stop(); syntheticCam = null; }
      const v = $('live-webcam-video');
      if (v) v.srcObject = null;
    } else {
      const ok = await recorder.openCamera();
      if (ok && recorder.stream) {
        const v = $('live-webcam-video');
        if (v) { v.srcObject = recorder.stream; v.play().catch(() => {}); }
        if (active && active.state === 'running') recorder.startRecording(sessionOriginPerf);
      }
    }
    updateCameraUi();
  });

  $('btn-pose-toggle')?.addEventListener('click', () => {
    poseOverlayVisible = !poseOverlayVisible;
    toast(poseOverlayVisible ? 'Pose overlay enabled.' : 'Pose overlay hidden.');
    if (!poseOverlayVisible) {
      const canvas = $('live-pose-canvas');
      const ctx = canvas?.getContext('2d');
      ctx?.clearRect(0, 0, canvas?.width || 0, canvas?.height || 0);
    }
  });

  $('btn-replay-swing')?.addEventListener('click', () => {
    if (activeLiveReplayIndex >= 0) selectLiveSwing(activeLiveReplayIndex);
  });

  $('btn-replay-pose-toggle')?.addEventListener('click', () => {
    replayPoseOverlayVisible = !replayPoseOverlayVisible;
    toast(replayPoseOverlayVisible ? 'Pose overlay enabled on replay.' : 'Pose overlay hidden.');
    const v = $('replay-video');
    const c = $('replay-pose-canvas');
    if (v && c) renderReplayPoseFrame(v, c, updatePoseIndicatorsDisplay);
  });

  $('btn-close-replay')?.addEventListener('click', () => {
    const wrap = $('swing-replay-wrap');
    if (wrap) wrap.hidden = true;
    activeLiveReplayIndex = -1;
    stopReplayPose($('replay-video'));
    updateLiveSwingTimeline();
  });

  $('swing-timeline-bar')?.addEventListener('click', (e) => {
    if (!liveSwings.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const totalDuration = Math.max(1000, active ? active.durationMs : 1000);
    const targetT = pct * totalDuration;

    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < liveSwings.length; i++) {
      const diff = Math.abs(liveSwings[i].t - targetT);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    selectLiveSwing(closestIdx);
  });

  $('swing-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.swing-chip');
    if (chip && chip.dataset.idx !== undefined) {
      selectLiveSwing(Number(chip.dataset.idx));
    }
  });

  $('cal-offset-slider')?.addEventListener('input', (e) => {
    calibrationOffsetMs = Number(e.target.value);
    const valEl = $('cal-offset-val');
    if (valEl) valEl.textContent = `${calibrationOffsetMs >= 0 ? '+' : ''}${calibrationOffsetMs} ms`;
    if (activeLiveReplayIndex >= 0 && liveSwings[activeLiveReplayIndex]) {
      const s = liveSwings[activeLiveReplayIndex];
      const vm = sensorTimeToVideo(s.t, clockMap, recorder?.timeline, calibrationOffsetMs, active ? active.durationMs : null);
      if (vm.videoS !== null) {
        const video = $('replay-video');
        if (video && video.readyState >= 2) {
          video.currentTime = vm.videoS;
        }
      }
    }
  });

  const attachInput = $('video-attach-file');
  attachInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const sessionId = attachInput._attachSessionId || activeReportRec?.id;
    if (!sessionId) { toast('No active session to attach video to.', 'warn'); return; }
    try {
      mediaStore.put(sessionId, file, {
        mimeType: file.type || 'video/webm',
        durationS: null,
        recorded: true,
      });
      toast('Video attached for this session.');
      if (currentView === 'report' && activeReportRec?.id === sessionId) {
        renderReport(sessionId, routeToken);
      }
    } catch (err) {
      toast(`Failed to attach video: ${err.message}`, 'bad');
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (active) { e.preventDefault(); e.returnValue = ''; }
    mediaStore.discardAll();
    stopReplayPose();
    stopPoseLoop();
    recorder?.closeCamera(true, true);
    recorder?.dispose();
    poseTracker?.dispose();
  });
  if (!window.Chart) banner('Chart.js failed to load. Start the app with "npm start" and open the printed address (do not open index.html directly).');
  if (settings.mode === 'live') live.connect(settings.host, settings.port);
  route();
}

init();
