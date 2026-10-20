/**
 * Chart.js wrappers. Chart.js is loaded globally (window.Chart) from /vendor/chart.umd.js.
 */
export const COLORS = { x: '#f87171', y: '#34d399', z: '#60a5fa', mag: '#fbbf24', swing: '#f472b6', speed: '#38bdf8' };

export const SPEC = {
  accel: { first: 1, title: 'Acceleration (g)', unit: 'g', names: ['Ax', 'Ay', 'Az', '|a| magnitude'], peakKey: 'peakG', peakName: 'Swing peak' },
  gyro: { first: 4, title: 'Angular velocity (°/s)', unit: '°/s', names: ['ωx', 'ωy', 'ωz', '|ω| magnitude'], peakKey: 'peakDps', peakName: 'Swing peak' },
  speed: { first: null, title: 'Estimated swing speed (km/h)', unit: 'km/h', names: ['Est. hitting-zone speed'], peakKey: 'speedKmh', peakName: 'Swing peak speed' },
};

export function createChart(canvas, kind, { radiusM = 0.75, isModal = false } = {}) {
  const spec = SPEC[kind] || SPEC.accel;
  let datasets = [];

  if (kind === 'speed') {
    datasets.push({
      label: spec.names[0],
      data: [],
      borderColor: COLORS.speed,
      backgroundColor: COLORS.speed,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0,
      parsing: false,
    });
    datasets.push({
      label: spec.peakName,
      data: [],
      showLine: false,
      borderColor: COLORS.swing,
      backgroundColor: COLORS.swing,
      pointStyle: 'triangle',
      pointRadius: isModal ? 8 : 6,
      parsing: false,
    });
  } else {
    const colors = [COLORS.x, COLORS.y, COLORS.z, COLORS.mag];
    datasets = spec.names.map((name, i) => ({
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
      pointRadius: isModal ? 8 : 6,
      parsing: false,
    });
  }

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
        legend: { position: 'bottom', labels: { color: '#c7d0e0', usePointStyle: true, boxWidth: 10, padding: 12 } },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(16, 24, 49, 0.95)',
          titleColor: '#e8edf8',
          bodyColor: '#c7d0e0',
          borderColor: '#26325a',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title(items) {
              if (!items || !items.length) return '';
              const x = items[0].parsed?.x ?? items[0].raw?.x;
              if (typeof x === 'number' && Number.isFinite(x)) {
                return `Time: ${x.toFixed(2)} s`;
              }
              return '';
            },
            label(context) {
              const name = context.dataset.label || '';
              const y = context.parsed?.y ?? context.raw?.y;
              if (typeof y !== 'number' || !Number.isFinite(y)) return name;
              const u = spec.unit || '';
              const dec = kind === 'accel' ? 2 : 1;
              return `${name}: ${y.toFixed(dec)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (s)', color: '#9aa7bd' },
          ticks: { color: '#9aa7bd', maxTicksLimit: isModal ? 16 : 10 },
          grid: { color: 'rgba(148,163,184,.12)' },
        },
        y: {
          title: { display: true, text: spec.title, color: '#9aa7bd' },
          ticks: { color: '#9aa7bd' },
          grid: { color: 'rgba(148,163,184,.12)' },
        },
      },
    },
  });

  chart._kind = kind;
  chart._radiusM = radiusM;
  chart._totalDurationS = 0;
  return chart;
}

export function fill(chart, rows, swings, radiusM = chart._radiusM || 0.75) {
  chart._radiusM = radiusM;
  const spec = SPEC[chart._kind];

  if (chart._kind === 'speed') {
    const [d0, dp] = chart.data.datasets;
    const a = [];
    const rM = radiusM > 0 ? radiusM : 0.75;
    for (const r of rows) {
      const x = r[0] / 1000;
      const omegaDps = Math.hypot(r[4], r[5], r[6]);
      const speedKmh = (omegaDps * Math.PI / 180) * rM * 3.6;
      a.push({ x, y: Math.round(speedKmh * 10) / 10 });
    }
    d0.data = a;
    dp.data = (swings || []).map((s) => ({ x: s.t / 1000, y: s.speedKmh }));
  } else {
    const [d0, d1, d2, d3, dp] = chart.data.datasets;
    const a = [[], [], [], []];
    const i = spec.first;
    for (const r of rows) {
      const x = r[0] / 1000;
      a[0].push({ x, y: r[i] });
      a[1].push({ x, y: r[i + 1] });
      a[2].push({ x, y: r[i + 2] });
      a[3].push({ x, y: Math.hypot(r[i], r[i + 1], r[i + 2]) });
    }
    d0.data = a[0];
    d1.data = a[1];
    d2.data = a[2];
    d3.data = a[3];
    dp.data = (swings || []).map((s) => ({ x: s.t / 1000, y: s[spec.peakKey] }));
  }
}

/** Rolling window: only rows with t >= latestT - windowMs are plotted. */
export function updateLive(chart, rows, swings, latestT, windowMs) {
  const min = Math.max(0, latestT - windowMs);
  fill(chart, rows, swings.filter((s) => s.t >= min));
  chart.options.scales.x.min = min / 1000;
  chart.options.scales.x.max = Math.max(windowMs, latestT) / 1000;
  chart.update('none');
}

export function setReport(chart, rows, swings, totalDurationS = null) {
  fill(chart, rows, swings);
  const maxT = totalDurationS ?? (rows.length ? rows[rows.length - 1][0] / 1000 : 0);
  chart._totalDurationS = Math.max(0.5, maxT);
  delete chart.options.scales.x.min;
  delete chart.options.scales.x.max;
  chart.update('none');
}

/**
 * Zoom chart in or out around a focus ratio (0..1 across visible window).
 * factor < 1 zooms in (e.g. 0.7); factor > 1 zooms out (e.g. 1.4).
 */
export function zoomChart(chart, factor, centerRatio = 0.5) {
  const total = chart._totalDurationS || 10;
  const curMin = chart.options.scales.x.min ?? 0;
  const curMax = chart.options.scales.x.max ?? total;
  const span = Math.max(0.05, curMax - curMin);
  const minSpan = Math.min(0.2, total / 2); // don't zoom in tighter than 0.2s or total/2

  const newSpan = Math.max(minSpan, Math.min(total, span * factor));
  const focus = curMin + span * centerRatio;
  let newMin = focus - newSpan * centerRatio;
  let newMax = newMin + newSpan;

  if (newMin < 0) {
    newMin = 0;
    newMax = Math.min(total, newSpan);
  } else if (newMax > total) {
    newMax = total;
    newMin = Math.max(0, total - newSpan);
  }

  const roundedMin = Math.round(newMin * 100) / 100;
  const roundedMax = Math.round(Math.max(roundedMin + minSpan, newMax) * 100) / 100;
  chart.options.scales.x.min = roundedMin;
  chart.options.scales.x.max = roundedMax;
  chart.update('none');
  return { min: chart.options.scales.x.min, max: chart.options.scales.x.max, total };
}

/**
 * Pan chart along the time axis.
 * deltaRatio > 0 pans right; deltaRatio < 0 pans left.
 */
export function panChart(chart, deltaRatio = 0.25) {
  const total = chart._totalDurationS || 10;
  const curMin = chart.options.scales.x.min ?? 0;
  const curMax = chart.options.scales.x.max ?? total;
  const span = curMax - curMin;
  const dt = span * deltaRatio;

  let newMin = curMin + dt;
  let newMax = curMax + dt;

  if (newMin < 0) {
    newMin = 0;
    newMax = span;
  } else if (newMax > total) {
    newMax = total;
    newMin = Math.max(0, total - span);
  }

  chart.options.scales.x.min = Math.round(newMin * 100) / 100;
  chart.options.scales.x.max = Math.round(newMax * 100) / 100;
  chart.update('none');
  return { min: chart.options.scales.x.min, max: chart.options.scales.x.max, total };
}

/** Reset zoom to complete session duration. */
export function resetChartZoom(chart) {
  const total = chart._totalDurationS || 10;
  chart.options.scales.x.min = 0;
  chart.options.scales.x.max = Math.round(total * 100) / 100;
  chart.update('none');
  return { min: 0, max: total, total };
}

/**
 * Attach mouse wheel and drag-to-pan handlers to the canvas.
 * Works seamlessly with desktop and mobile touch gestures.
 */
export function attachInteractiveControls(chart, canvas, onRangeChange = null) {
  let isDragging = false;
  let dragStartX = 0;
  let dragStartMin = 0;
  let dragStartMax = 0;

  const getRange = () => {
    const total = chart._totalDurationS || 10;
    return {
      min: chart.options.scales.x.min ?? 0,
      max: chart.options.scales.x.max ?? total,
      total,
    };
  };

  const notify = () => {
    if (onRangeChange) onRangeChange(getRange());
  };

  const onWheel = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    zoomChart(chart, factor, ratio);
    notify();
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isDragging = true;
    dragStartX = e.clientX;
    const r = getRange();
    dragStartMin = r.min;
    dragStartMax = r.max;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - dragStartX;
    const span = dragStartMax - dragStartMin;
    const dt = -(dx / rect.width) * span;

    const total = chart._totalDurationS || 10;
    let newMin = dragStartMin + dt;
    let newMax = dragStartMax + dt;

    if (newMin < 0) {
      newMin = 0;
      newMax = span;
    } else if (newMax > total) {
      newMax = total;
      newMin = Math.max(0, total - span);
    }

    chart.options.scales.x.min = Math.round(newMin * 100) / 100;
    chart.options.scales.x.max = Math.round(newMax * 100) / 100;
    chart.update('none');
    notify();
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grab';
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
  };
}
