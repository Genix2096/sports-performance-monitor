/**
 * Chart.js wrappers. Chart.js is loaded globally (window.Chart) from /vendor/chart.umd.js.
 */
export const COLORS = { x: '#f87171', y: '#34d399', z: '#60a5fa', mag: '#fbbf24', swing: '#f472b6' };

const SPEC = {
  accel: { first: 1, title: 'Acceleration (g)', names: ['Ax', 'Ay', 'Az', '|a| magnitude'], peakKey: 'peakG', peakName: 'Swing peak' },
  gyro: { first: 4, title: 'Angular velocity (°/s)', names: ['ωx', 'ωy', 'ωz', '|ω| magnitude'], peakKey: 'peakDps', peakName: 'Swing peak' },
};

export function createChart(canvas, kind) {
  const spec = SPEC[kind];
  const colors = [COLORS.x, COLORS.y, COLORS.z, COLORS.mag];
  const datasets = spec.names.map((name, i) => ({
    label: name,
    data: [],
    borderColor: colors[i],
    backgroundColor: colors[i],
    borderWidth: i === 3 ? 2.2 : 1.2,
    pointRadius: 0,
    tension: 0,
    parsing: false,
  }));
  datasets.push({
    label: spec.peakName,
    data: [],
    showLine: false,
    borderColor: COLORS.swing,
    backgroundColor: COLORS.swing,
    pointStyle: 'triangle',
    pointRadius: 6,
    parsing: false,
  });
  const chart = new window.Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      normalized: true,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c7d0e0', usePointStyle: true, boxWidth: 8 } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Time (s)', color: '#9aa7bd' }, ticks: { color: '#9aa7bd', maxTicksLimit: 10 }, grid: { color: 'rgba(148,163,184,.12)' } },
        y: { title: { display: true, text: spec.title, color: '#9aa7bd' }, ticks: { color: '#9aa7bd' }, grid: { color: 'rgba(148,163,184,.12)' } },
      },
    },
  });
  chart._kind = kind;
  return chart;
}

function fill(chart, rows, swings) {
  const spec = SPEC[chart._kind];
  const [d0, d1, d2, d3, dp] = chart.data.datasets;
  const a = [[], [], [], []];
  for (const r of rows) {
    const x = r[0] / 1000;
    const i = spec.first;
    a[0].push({ x, y: r[i] });
    a[1].push({ x, y: r[i + 1] });
    a[2].push({ x, y: r[i + 2] });
    a[3].push({ x, y: Math.hypot(r[i], r[i + 1], r[i + 2]) });
  }
  d0.data = a[0]; d1.data = a[1]; d2.data = a[2]; d3.data = a[3];
  dp.data = swings.map((s) => ({ x: s.t / 1000, y: s[spec.peakKey] }));
}

/** Rolling window: only rows with t >= latestT - windowMs are plotted. */
export function updateLive(chart, rows, swings, latestT, windowMs) {
  const min = Math.max(0, latestT - windowMs);
  fill(chart, rows, swings.filter((s) => s.t >= min));
  chart.options.scales.x.min = min / 1000;
  chart.options.scales.x.max = Math.max(windowMs, latestT) / 1000;
  chart.update('none');
}

export function setReport(chart, rows, swings) {
  fill(chart, rows, swings);
  delete chart.options.scales.x.min;
  delete chart.options.scales.x.max;
  chart.update('none');
}
