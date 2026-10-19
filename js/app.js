/**
 * Application controller: routing, views, session lifecycle. Business logic lives in
 * session.js / analytics.js; sensor transport in sensor.js / simulator.js; persistence in storage.js.
 */
import { CONFIG, SPORT_IDS } from './config.js';
import { Session } from './session.js';
import { DemoSource } from './simulator.js';
import { LiveSensor, CONN, CONN_LABEL } from './sensor.js';
import { magnitude, fmt, formatDuration, downsampleRows, buildSummaryText } from './analytics.js';
import { saveSession, listSessions, getSession, deleteSession, importRecords } from './storage.js';
import { parseImportText, toExportBundle, toCsv } from './schema.js';
import { createChart, updateLive, setReport } from './charts.js';

const $ = (id) => document.getElementById(id);
const EMOJI = { cricket: '🏏', badminton: '🏸', tennis: '🎾' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sportLabel = (id) => CONFIG.sports[id]?.label || id;

/* ------------------------------ settings ------------------------------ */
const SETTINGS_KEY = 'spm.settings.v1';
const settings = { sport: 'cricket', mode: 'demo', name: '', host: CONFIG.esp.host, port: CONFIG.esp.port };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* ignore corrupt settings */ }
if (!SPORT_IDS.includes(settings.sport)) settings.sport = 'cricket';
if (settings.mode !== 'demo' && settings.mode !== 'live') settings.mode = 'demo';
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
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

const live = new LiveSensor({
  onState: () => { updateChrome(); refreshConnectionUi(); },
  onSample: (s) => handleSample(s),
  onInvalid: () => { /* counted inside LiveSensor; shown in live note */ scheduleRender(); },
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
  if (live.wantOpen && sameTarget) return;
  live.connect(settings.host, settings.port);
}

function liveNoteFor(state) {
  switch (state) {
    case CONN.CONNECTED: return { kind: 'ok', text: 'ESP8266 connected and streaming real sensor data.' };
    case CONN.CONNECTING: return { kind: 'warn', text: live.detail || 'Connecting to the ESP8266…' };
    case CONN.SENSOR_UNAVAILABLE: return { kind: 'bad', text: `ESP8266 reachable but the MPU6050 is not responding. ${live.detail} Check wiring: VCC→3V3, GND→GND, SDA→D2, SCL→D1.` };
    case CONN.CONNECTION_LOST: return { kind: 'bad', text: `Connection lost. ${live.detail} Retrying automatically…` };
    default: return { kind: 'bad', text: live.detail && live.detail !== 'Not connected.' ? live.detail : 'ESP8266 not connected. Live Hardware Mode needs the ESP8266 — use “Test connection”, or choose Demo Mode.' };
  }
}

/* ------------------------------ sport selection ------------------------------ */
function setSport(id) {
  settings.sport = id;
  saveSettings();
  renderSports();
  updateLiveHeader();
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
  $('setup-name').value = settings.name || '';
  document.querySelector(`input[name=mode][value=${settings.mode}]`).checked = true;
  $('setup-host').value = settings.host;
  $('setup-port').value = settings.port;
  $('setup-error').hidden = true;
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
  err.hidden = true;
  if (active) {
    err.textContent = 'A session is already active. Stop it from the Live screen before starting another.';
    err.hidden = false;
    return;
  }
  settings.name = $('setup-name').value.trim();
  if (settings.mode === 'live') {
    const hp = readHostPort();
    if (hp.error) { err.textContent = hp.error; err.hidden = false; return; }
    settings.host = hp.host;
    settings.port = hp.port;
  }
  saveSettings();
  startSession();
  location.hash = '#live';
}

/* ------------------------------ SESSION LIFECYCLE ------------------------------ */
function startSession() {
  if (active) { toast('A session is already running.', 'warn'); return false; }
  active = new Session({ sport: settings.sport, name: settings.name, mode: settings.mode });
  active.start();
  liveRows = [];
  latest = null;
  lastSwing = null;
  banner('');
  if (active.mode === 'demo') {
    demoSource = new DemoSource(active.sport);
    demoSource.setSink(handleSample);
    demoSource.start();
  } else {
    ensureLiveConnection();
  }
  updateChrome();
  updateControls();
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
  if (r.swing) lastSwing = r.swing;
  scheduleRender();
}

function pauseSession() {
  if (!active || !active.pause()) return;
  if (demoSource) demoSource.pause();
  updateControls();
  renderLive();
}

function resumeSession() {
  if (!active || !active.resume()) return;
  if (demoSource) demoSource.resume();
  updateControls();
  renderLive();
}

async function stopSession() {
  if (!active || stopping) return;
  stopping = true;
  const s = active;
  try {
    s.stop();
    if (demoSource) { demoSource.stop(); demoSource = null; }
    if (s.mode === 'live') live.disconnect();
    active = null;
    liveRows = [];
    updateChrome();
    updateControls();
    const rec = s.toRecord();
    if (rec.metrics.sampleCount === 0) {
      toast('Session was empty (no sensor data received), so nothing was saved.', 'warn');
      renderLive();
      return;
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
  const m = rec.metrics;
  const c = m.consistency;
  const tile = (l, v, u = '') => `<div class="stat"><span class="stat-l">${l}</span><span class="stat-v">${v}</span><span class="stat-u">${u || '&nbsp;'}</span></div>`;
  const isUnsaved = unsaved.has(rec.id);
  const label = sportLabel(rec.sport);
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
      ${tile('Active duration', formatDuration(rec.activeDurationMs), 'paused time excluded')}
      ${tile('Total swings', m.totalSwings, `${fmt(m.swingsPerMinute, 1)} per minute`)}
      ${tile('Avg est. swing speed', fmt(m.avgSpeedKmh), 'km/h (estimate)')}
      ${tile('Max est. swing speed', fmt(m.maxSpeedKmh), 'km/h (estimate)')}
      ${tile('Avg angular velocity', fmt(m.avgGyroDps, 0), '°/s over active time')}
      ${tile('Max angular velocity', fmt(m.maxGyroDps, 0), '°/s')}
      ${tile('Max acceleration', fmt(m.maxAccelG, 2), 'g (magnitude)')}
      ${tile('Swing consistency', c.score === null ? 'Insufficient data' : `${c.score}/100`, c.score === null ? 'needs ≥ 3 swings' : `${c.status} · peak ω CV ${(c.cv * 100).toFixed(0)}%`)}
    </div>
    <section class="card summary"><h2 class="card-title">Performance summary</h2><p style="margin:0">${esc(buildSummaryText(m, label, rec.mode))}</p>
      <p class="muted small" style="margin:10px 0 0">Estimated swing speed = peak angular velocity × assumed effective radius (${rec.settings.radiusM} m). It is an estimate of the hitting-zone speed, not ball speed, impact force or shot accuracy.${rec.storedStride > 1 ? ` Graph data was thinned (every ${rec.storedStride}th sample stored); statistics use all samples.` : ''}</p></section>
    <div class="grid g2">
      <section class="card"><h2 class="card-title">Acceleration <small>(g) — full session</small></h2><div class="chart-wrap tall"><canvas id="rep-accel" role="img" aria-label="Session acceleration graph"></canvas></div></section>
      <section class="card"><h2 class="card-title">Angular velocity <small>(°/s) — full session</small></h2><div class="chart-wrap tall"><canvas id="rep-gyro" role="img" aria-label="Session angular velocity graph"></canvas></div></section>
    </div>
    <section class="card"><h2 class="card-title">Detected swings</h2>
      ${rec.swings.length ? `<div class="table-scroll"><table><thead><tr><th>#</th><th>Time (s)</th><th>Peak ω (°/s)</th><th>Peak |a| (g)</th><th>Duration (ms)</th><th>Est. speed (km/h)</th></tr></thead><tbody>${rec.swings.map((s, i) => `<tr><td>${i + 1}</td><td>${(s.t / 1000).toFixed(1)}</td><td>${s.peakDps.toFixed(0)}</td><td>${s.peakG.toFixed(2)}</td><td>${s.durationMs.toFixed(0)}</td><td>${s.speedKmh.toFixed(1)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No swings detected in this session.</p>'}
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
  if (window.Chart) {
    const rows = downsampleRows(rec.samples, CONFIG.charts.reportMaxPoints);
    const a = createChart($('rep-accel'), 'accel');
    const g = createChart($('rep-gyro'), 'gyro');
    setReport(a, rows, rec.swings);
    setReport(g, rows, rec.swings);
    reportCharts = [a, g];
  } else {
    banner('Chart.js failed to load; report graphs are unavailable.');
  }
}

async function removeSession(rec, fromReport) {
  const ok = await confirmDialog('Delete session?', `“${rec.name || sportLabel(rec.sport)}” from ${new Date(rec.startedAt).toLocaleString()} will be permanently deleted from this browser. Export it first if you want a backup.`, 'Delete');
  if (!ok) return;
  try {
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
  if (name !== 'report') destroyReportCharts();
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
    live.connect(hp.host, hp.port);
  });
  $('home-start').addEventListener('click', () => { location.hash = '#setup'; });
  $('home-check').addEventListener('click', () => {
    if (settings.mode === 'demo') toast('Demo Mode is selected, so the ESP8266 is not used. Switch to Live Hardware Mode in New Session to connect.', 'warn');
    live.connect(settings.host, settings.port);
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
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = ''; } });
  if (!window.Chart) banner('Chart.js failed to load. Start the app with "npm start" and open the printed address (do not open index.html directly).');
  if (settings.mode === 'live') live.connect(settings.host, settings.port);
  route();
}

init();
