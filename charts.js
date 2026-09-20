/**
 * charts.js — Hand-rolled SVG chart primitives.
 *
 * No charting library. Every mark is emitted as SVG so the rendering logic is
 * as inspectable as the maths in ai-engine.js, and the page has no external
 * dependency to break.
 *
 * Palette: the categorical hues below are a validated colourblind-safe set
 * stepped for this dark surface (#121823) — checked for lightness band,
 * chroma floor, CVD separation between adjacent pairs, normal-vision
 * separation and >=3:1 contrast against the surface. Status colours are held
 * separately and never reused as a series hue; they always ship with a text
 * label, so state is never carried by colour alone.
 */

const PALETTE = {
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'],
  status: { good: '#199e70', warning: '#c98500', serious: '#d95926', critical: '#e66767' },
  grid: '#222d3d',
  axis: '#94a3b8',
  dim: '#64748b',
  surface: '#121823',
};

/* ------------------------------------------------------------------ */
/* Shared tooltip                                                      */
/* ------------------------------------------------------------------ */

let tooltipEl = null;

function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.style.cssText = `
      position:fixed; pointer-events:none; z-index:300; opacity:0;
      background:#18202d; border:1px solid #222d3d; border-radius:7px;
      padding:8px 11px; font-size:12px; line-height:1.5; color:#e7ecf3;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
      box-shadow:0 8px 24px #00000066; transition:opacity .1s; max-width:250px;`;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTip(evt, html) {
  const el = tooltip();
  el.innerHTML = html;
  el.style.opacity = '1';
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = el.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function hideTip() {
  if (tooltipEl) tooltipEl.style.opacity = '0';
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const svgNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Produces "nice" axis ticks covering [0, max]. */
function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

const fmtNum = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMoney = (v) => '$' + Math.round(v).toLocaleString('en-US');

/* ------------------------------------------------------------------ */
/* Line chart with forecast band                                       */
/* ------------------------------------------------------------------ */

/**
 * Renders history followed by a forecast with a prediction-interval band.
 *
 * @param {HTMLElement} host
 * @param {object} cfg
 *   history  {number[]}  observed values (drawn solid)
 *   forecast {number[]}  point forecast  (drawn dashed, continues the line)
 *   lower/upper {number[]} prediction interval, same length as forecast
 *   fitted   {number[]}  optional in-sample fit, drawn faintly
 *   yLabel   {string}
 */
function lineChart(host, cfg) {
  host.innerHTML = '';

  const W = 860;
  const H = cfg.height ?? 300;
  const M = { t: 14, r: 16, b: 28, l: 46 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;

  const history = cfg.history ?? [];
  const fc = cfg.forecast ?? [];
  const lower = cfg.lower ?? [];
  const upper = cfg.upper ?? [];
  const total = history.length + fc.length;
  if (!total) return;

  const maxVal = Math.max(...history, ...upper, ...fc, 1);
  const ticks = niceTicks(maxVal);
  const yMax = ticks[ticks.length - 1];

  const X = (i) => M.l + (i / (total - 1)) * pw;
  const Y = (v) => M.t + ph - (v / yMax) * ph;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'chart',
    role: 'img', 'aria-label': cfg.ariaLabel ?? 'Demand history and forecast',
  }, host);

  // --- Grid + y axis (recessive)
  for (const t of ticks) {
    el('line', { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: PALETTE.grid, 'stroke-width': 1 }, svg);
    el('text', {
      x: M.l - 8, y: Y(t) + 4, 'text-anchor': 'end',
      fill: PALETTE.dim, 'font-size': 10.5, 'font-family': 'ui-monospace, monospace',
    }, svg).textContent = fmtNum(t);
  }

  // --- Forecast region shading + divider
  if (fc.length) {
    const x0 = X(history.length - 1);
    el('rect', { x: x0, y: M.t, width: W - M.r - x0, height: ph, fill: '#ffffff05' }, svg);
    el('line', { x1: x0, x2: x0, y1: M.t, y2: M.t + ph, stroke: PALETTE.grid, 'stroke-width': 1, 'stroke-dasharray': '3 3' }, svg);
    el('text', { x: x0 + 6, y: M.t + 12, fill: PALETTE.dim, 'font-size': 10.5 }, svg).textContent = 'forecast';
  }

  // --- Prediction-interval band
  if (lower.length === fc.length && fc.length) {
    const pts = [];
    pts.push(`${X(history.length - 1)},${Y(history[history.length - 1])}`);
    upper.forEach((v, i) => pts.push(`${X(history.length + i)},${Y(v)}`));
    for (let i = lower.length - 1; i >= 0; i--) pts.push(`${X(history.length + i)},${Y(lower[i])}`);
    pts.push(`${X(history.length - 1)},${Y(history[history.length - 1])}`);
    el('polygon', { points: pts.join(' '), fill: PALETTE.series[1], opacity: 0.16 }, svg);
  }

  // --- In-sample fit (faint)
  if (cfg.fitted) {
    const d = cfg.fitted
      .map((v, i) => (v === null ? null : `${X(i)},${Y(v)}`))
      .filter(Boolean).join(' ');
    el('polyline', { points: d, fill: 'none', stroke: PALETTE.series[2], 'stroke-width': 1.5, opacity: 0.45 }, svg);
  }

  // --- History line
  el('polyline', {
    points: history.map((v, i) => `${X(i)},${Y(v)}`).join(' '),
    fill: 'none', stroke: PALETTE.series[0], 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, svg);

  // --- Forecast line (dashed, joined to the last actual)
  if (fc.length) {
    const pts = [`${X(history.length - 1)},${Y(history[history.length - 1])}`]
      .concat(fc.map((v, i) => `${X(history.length + i)},${Y(v)}`));
    el('polyline', {
      points: pts.join(' '), fill: 'none', stroke: PALETTE.series[1],
      'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linecap': 'round',
    }, svg);
  }

  // --- x-axis labels
  const labels = cfg.xLabels ?? [];
  if (labels.length) {
    labels.forEach(({ i, text }) => {
      el('text', {
        x: X(i), y: H - 8, 'text-anchor': 'middle',
        fill: PALETTE.dim, 'font-size': 10.5,
      }, svg).textContent = text;
    });
  }

  // --- Crosshair + tooltip layer
  const cross = el('line', { y1: M.t, y2: M.t + ph, stroke: PALETTE.axis, 'stroke-width': 1, opacity: 0 }, svg);
  const dot = el('circle', { r: 4.5, fill: PALETTE.series[0], stroke: PALETTE.surface, 'stroke-width': 2, opacity: 0 }, svg);

  const overlay = el('rect', { x: M.l, y: M.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair' }, svg);

  overlay.addEventListener('mousemove', (evt) => {
    const box = svg.getBoundingClientRect();
    const rel = ((evt.clientX - box.left) / box.width) * W;
    let i = Math.round(((rel - M.l) / pw) * (total - 1));
    i = Math.max(0, Math.min(total - 1, i));

    const isFc = i >= history.length;
    const v = isFc ? fc[i - history.length] : history[i];
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 0.35);
    dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(v));
    dot.setAttribute('fill', isFc ? PALETTE.series[1] : PALETTE.series[0]);
    dot.setAttribute('opacity', 1);

    const dayLabel = isFc ? `Day +${i - history.length + 1}` : `Day ${i - history.length + 1}`;
    let html = `<strong>${dayLabel}</strong><br>${isFc ? 'Forecast' : 'Actual'}: <strong>${fmtNum(v, isFc ? 1 : 0)}</strong> ${cfg.unit ?? 'units'}`;
    if (isFc) {
      const k = i - history.length;
      html += `<br><span style="color:#94a3b8">95% interval ${fmtNum(lower[k])} – ${fmtNum(upper[k])}</span>`;
    }
    showTip(evt, html);
  });

  overlay.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
    hideTip();
  });

  // --- Legend (>=2 series, so always present)
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.series[0]}"></span>Actual</span>
    ${fc.length ? `<span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.series[1]}"></span>Forecast</span>
    <span class="legend-item"><span class="legend-swatch band" style="background:${PALETTE.series[1]}"></span>95% interval</span>` : ''}
    ${cfg.fitted ? `<span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.series[2]};opacity:.6"></span>In-sample fit</span>` : ''}`;
  host.appendChild(legend);
}

/* ------------------------------------------------------------------ */
/* Horizontal bar chart (ABC / margin)                                 */
/* ------------------------------------------------------------------ */

/**
 * Single-axis horizontal bars with direct value labels. Deliberately NOT a
 * bar+cumulative-line Pareto combo: that needs two y-scales, and a dual-axis
 * chart lets the author imply any relationship they like by rescaling.
 * The cumulative share is shown as text on each row instead.
 */
function barChart(host, cfg) {
  host.innerHTML = '';
  const rows = cfg.rows;
  if (!rows.length) return;

  const rowH = 26;
  const W = 860;
  const M = { t: 6, r: 120, b: 22, l: 148 };
  const H = M.t + M.b + rows.length * rowH;
  const pw = W - M.l - M.r;

  const maxVal = Math.max(...rows.map((r) => r.value), 1);
  const ticks = niceTicks(maxVal, 4);
  const xMax = ticks[ticks.length - 1];
  const X = (v) => (v / xMax) * pw;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': cfg.ariaLabel ?? 'Bar chart' }, host);

  for (const t of ticks) {
    el('line', { x1: M.l + X(t), x2: M.l + X(t), y1: M.t, y2: M.t + rows.length * rowH, stroke: PALETTE.grid, 'stroke-width': 1 }, svg);
    el('text', { x: M.l + X(t), y: H - 7, 'text-anchor': 'middle', fill: PALETTE.dim, 'font-size': 10.5, 'font-family': 'ui-monospace, monospace' }, svg)
      .textContent = cfg.money ? fmtMoney(t) : fmtNum(t);
  }

  rows.forEach((r, i) => {
    const y = M.t + i * rowH;
    const barH = 13;
    const w = Math.max(2, X(r.value));

    el('text', { x: M.l - 10, y: y + barH + 1, 'text-anchor': 'end', fill: '#e7ecf3', 'font-size': 11.5 }, svg)
      .textContent = r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label;

    const bar = el('rect', {
      x: M.l, y: y + 5, width: w, height: barH, rx: 4,
      fill: r.color ?? PALETTE.series[0], style: 'cursor:pointer',
    }, svg);

    // Direct value label — identity is never colour-alone.
    el('text', { x: M.l + w + 8, y: y + barH + 1, fill: PALETTE.axis, 'font-size': 11, 'font-family': 'ui-monospace, monospace' }, svg)
      .textContent = r.valueLabel ?? (cfg.money ? fmtMoney(r.value) : fmtNum(r.value));

    bar.addEventListener('mousemove', (e) => showTip(e, r.tip ?? `<strong>${r.label}</strong><br>${cfg.money ? fmtMoney(r.value) : fmtNum(r.value)}`));
    bar.addEventListener('mouseleave', hideTip);
  });

  if (cfg.legend) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = cfg.legend
      .map((l) => `<span class="legend-item"><span class="legend-swatch" style="background:${l.color}"></span>${l.label}</span>`)
      .join('');
    host.appendChild(legend);
  }
}

/* ------------------------------------------------------------------ */
/* Scatter (risk matrix)                                               */
/* ------------------------------------------------------------------ */

function scatterChart(host, cfg) {
  host.innerHTML = '';
  const pts = cfg.points;
  if (!pts.length) return;

  const W = 860;
  const H = cfg.height ?? 300;
  const M = { t: 16, r: 18, b: 42, l: 52 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;

  const xMaxRaw = Math.max(...pts.map((p) => p.x), 1);
  const xTicks = niceTicks(xMaxRaw, 5);
  const xMax = xTicks[xTicks.length - 1];
  const yTicks = [0, 25, 50, 75, 100];

  const X = (v) => M.l + (v / xMax) * pw;
  const Y = (v) => M.t + ph - (v / 100) * ph;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': cfg.ariaLabel ?? 'Risk matrix' }, host);

  for (const t of yTicks) {
    el('line', { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: PALETTE.grid, 'stroke-width': 1 }, svg);
    el('text', { x: M.l - 8, y: Y(t) + 4, 'text-anchor': 'end', fill: PALETTE.dim, 'font-size': 10.5, 'font-family': 'ui-monospace, monospace' }, svg)
      .textContent = t + '%';
  }
  for (const t of xTicks) {
    el('text', { x: X(t), y: H - 22, 'text-anchor': 'middle', fill: PALETTE.dim, 'font-size': 10.5, 'font-family': 'ui-monospace, monospace' }, svg)
      .textContent = fmtNum(t);
  }

  el('text', { x: M.l + pw / 2, y: H - 5, 'text-anchor': 'middle', fill: PALETTE.axis, 'font-size': 11 }, svg)
    .textContent = cfg.xLabel ?? 'Days of cover';
  el('text', { x: 13, y: M.t + ph / 2, 'text-anchor': 'middle', fill: PALETTE.axis, 'font-size': 11, transform: `rotate(-90 13 ${M.t + ph / 2})` }, svg)
    .textContent = cfg.yLabel ?? 'Stockout probability';

  // Reference line: the lead-time horizon most items must survive.
  if (cfg.xRef) {
    el('line', { x1: X(cfg.xRef), x2: X(cfg.xRef), y1: M.t, y2: M.t + ph, stroke: PALETTE.status.warning, 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.55 }, svg);
  }

  pts.forEach((p) => {
    const c = el('circle', {
      cx: X(Math.min(p.x, xMax)), cy: Y(p.y), r: 6,
      fill: p.color, stroke: PALETTE.surface, 'stroke-width': 2,
      style: 'cursor:pointer',
    }, svg);
    c.addEventListener('mousemove', (e) => showTip(e, p.tip));
    c.addEventListener('mouseleave', hideTip);
  });

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.status.critical}"></span>Critical</span>
    <span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.status.serious}"></span>At risk</span>
    <span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.status.warning}"></span>Watch</span>
    <span class="legend-item"><span class="legend-swatch" style="background:${PALETTE.status.good}"></span>Healthy</span>`;
  host.appendChild(legend);
}

/* ------------------------------------------------------------------ */
/* Sparkline (table cell)                                              */
/* ------------------------------------------------------------------ */

function sparkline(values, color = PALETTE.series[0], w = 70, h = 20) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * (h - 3) - 1.5}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

const Charts = { PALETTE, lineChart, barChart, scatterChart, sparkline, fmtNum, fmtMoney, showTip, hideTip };
if (typeof window !== 'undefined') Object.assign(window, Charts, { Charts });
if (typeof module !== 'undefined' && module.exports) module.exports = Charts;
