/**
 * app.js — Application controller.
 *
 * Owns state, routing between views, rendering and the owner/customer role
 * split that the original Java Swing program implemented with separate
 * JFrames. Recomputes the full AI analysis whenever inventory changes, so
 * nothing on screen can drift from the underlying numbers.
 */

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const State = {
  items: [],
  analyses: [],
  serviceLevel: 0.95,
  cart: [],
  revenue: 0,
  owners: [{ username: 'admin', password: 'admin123' }],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
const money2 = (v) => '$' + v.toFixed(2);
const num = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const plural = (v, one, many) => `${v} ${v === 1 ? one : many ?? one + 's'}`;

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

function toast(message, isError = false) {
  const host = $('#toastHost');
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' error' : '');
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, 3200);
}

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Derives a single status from the analysis. Note the ordering: stockout
 * risk outranks expiry risk, because running out loses a sale permanently
 * while spoilage loses only the cost of goods.
 */
function statusOf(a) {
  if (a.policy.stockoutProb > 0.5) return { key: 'critical', label: 'Stockout risk', cls: 'red', color: PALETTE.status.critical };
  if (a.policy.shouldReorder) return { key: 'reorder', label: 'Reorder now', cls: 'amber', color: PALETTE.status.serious };
  if (a.expiry && a.expiry.expectedSpoilUnits >= 1) return { key: 'expiry', label: 'Expiry risk', cls: 'violet', color: PALETTE.status.warning };
  if (a.policy.daysOfCover > 30) return { key: 'overstock', label: 'Overstocked', cls: 'blue', color: PALETTE.status.warning };
  return { key: 'healthy', label: 'Healthy', cls: 'green', color: PALETTE.status.good };
}

function riskColor(score) {
  if (score >= 50) return PALETTE.status.critical;
  if (score >= 30) return PALETTE.status.serious;
  if (score >= 15) return PALETTE.status.warning;
  return PALETTE.status.good;
}

/* ------------------------------------------------------------------ */
/* Recompute                                                           */
/* ------------------------------------------------------------------ */

function recompute() {
  State.analyses = analyseInventory(State.items, { serviceLevel: State.serviceLevel });
}

function analysisFor(sku) {
  return State.analyses.find((a) => a.item.sku === sku);
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

function renderDashboard() {
  const A = State.analyses;

  const stockValue = A.reduce((s, a) => s + a.item.stockValue, 0);
  const reorderCount = A.filter((a) => a.policy.shouldReorder).length;
  const writeOff = A.reduce((s, a) => s + (a.expiry ? a.expiry.writeOffValue : 0), 0);
  const atRisk = A.filter((a) => a.policy.stockoutProb > 0.5).length;
  const profit90 = A.reduce((s, a) => s + a.item.profit(90), 0);

  const kpis = [
    { label: 'Inventory at cost', value: money(stockValue), note: `${A.length} active SKUs`, cls: '' },
    { label: 'Needs reorder', value: reorderCount, note: `of ${A.length} at ${pct(State.serviceLevel, 0)} service level`, cls: reorderCount ? 'warn' : 'good' },
    { label: 'Stockout risk > 50%', value: atRisk, note: 'before next delivery could land', cls: atRisk ? 'bad' : 'good' },
    { label: 'Forecast write-off', value: money(writeOff), note: 'perishables expected to expire unsold', cls: writeOff > 500 ? 'warn' : 'good' },
    { label: 'Gross profit, 90d', value: money(profit90), note: 'trailing realised margin', cls: 'info' },
  ];

  $('#kpiRow').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');

  // --- Priority actions
  const priority = A.filter((a) => a.riskScore > 8).slice(0, 6);
  $('#priorityActions').innerHTML = priority.length
    ? priority.map((a) => {
        const st = statusOf(a);
        const tone = a.riskScore >= 50 ? 'critical' : a.riskScore >= 25 ? 'warning' : 'info';
        let body;
        let action;
        if (st.key === 'critical' || st.key === 'reorder') {
          body = `${pct(a.policy.stockoutProb)} chance of running out within the ${a.item.leadTimeDays}-day lead time. <strong>${num(a.policy.daysOfCover, 1)} days</strong> of cover left.`;
          action = `Raise PO: ${num(a.policy.orderQty)} units → ${a.item.supplier} · ${money(a.policy.orderQty * a.item.unitCost)}`;
        } else if (st.key === 'expiry') {
          body = `<strong>${plural(num(a.expiry.expectedSpoilUnits), 'unit')}</strong> forecast to expire unsold in ${plural(a.expiry.days, 'day')} — ${money(a.expiry.writeOffValue)} at cost.`;
          action = a.expiry.suggestedDiscount > 1
            ? `Mark down ~${num(a.expiry.suggestedDiscount)}% to clear before expiry`
            : `Monitor — markdown not yet justified by margin`;
        } else {
          body = `${num(a.policy.daysOfCover, 0)} days of cover ties up ${money(a.item.stockValue)}. Demand is ${num(a.forecast.dailyMean, 1)}/day.`;
          action = `Pause reordering until cover falls below ${num(a.policy.reorderPoint)} units`;
        }
        return `<div class="insight ${tone}">
          <div class="insight-head">
            <span class="insight-title">${a.item.name}</span>
            <span class="badge ${st.cls}">${st.label}</span>
            <span class="badge grey">Class ${a.abc}</span>
            <span class="riskbar" title="Composite risk ${a.riskScore}/100"><span style="width:${a.riskScore}%;background:${riskColor(a.riskScore)}"></span></span>
          </div>
          <div class="insight-body">${body}</div>
          <div class="insight-action">${action}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Nothing needs attention — every SKU is within policy.</div>';

  // --- Aggregate demand
  const histLen = 60;
  const agg = new Array(histLen).fill(0);
  A.forEach((a) => {
    const tail = a.item.history.slice(-histLen);
    tail.forEach((v, i) => { agg[i] += v; });
  });
  // Aggregating the interval is NOT a matter of summing each SKU's band:
  // that would assume every SKU errs in the same direction on the same day.
  // Demand shocks are largely SKU-specific, so variances are pooled instead
  // (σ_agg = √Σσ_i²), which is why the aggregate band is proportionally much
  // tighter than any single item's — the familiar risk-pooling result.
  const aggFc = new Array(14).fill(0);
  const aggVar = new Array(14).fill(0);
  A.forEach((a) => {
    a.forecast.point.slice(0, 14).forEach((v, i) => { aggFc[i] += v; });
    a.forecast.mult.slice(0, 14).forEach((m, i) => { aggVar[i] += (a.forecast.sigma * m) ** 2; });
  });
  const zAgg = Stats.normalQuantile(0.975);
  const aggLo = aggFc.map((v, i) => Math.max(0, v - zAgg * Math.sqrt(aggVar[i])));
  const aggHi = aggFc.map((v, i) => v + zAgg * Math.sqrt(aggVar[i]));

  lineChart($('#aggregateChart'), {
    history: agg, forecast: aggFc, lower: aggLo, upper: aggHi,
    height: 260, unit: 'units',
    ariaLabel: 'Total daily demand across all SKUs, last 60 days with a 14-day forecast',
    xLabels: [{ i: 0, text: '−60d' }, { i: 30, text: '−30d' }, { i: histLen - 1, text: 'today' }, { i: histLen + 13, text: '+14d' }],
  });

  // --- ABC
  const abcColor = { A: PALETTE.series[0], B: PALETTE.series[1], C: PALETTE.series[2] };
  const abcRows = [...A].sort((a, b) => b.annualMargin - a.annualMargin).map((a) => ({
    label: a.item.name,
    value: a.annualMargin,
    color: abcColor[a.abc],
    // Class is direct-labelled on every bar, so the segmentation never
    // depends on colour alone.
    valueLabel: `${money(a.annualMargin)} · ${a.abc}`,
    tip: `<strong>${a.item.name}</strong><br>Class ${a.abc}<br>${money(a.annualMargin)} annualised margin<br>${num(a.item.unitsSold(90))} units sold in 90 days<br>Cumulative share ${pct(a.cumulativeShare ?? 0, 0)}`,
  }));
  barChart($('#abcChart'), {
    rows: abcRows, money: true,
    ariaLabel: 'Every SKU by annualised gross margin, coloured and labelled by ABC class',
    legend: [
      { label: 'Class A — top 80% of margin', color: abcColor.A },
      { label: 'Class B — next 15%', color: abcColor.B },
      { label: 'Class C — final 5%', color: abcColor.C },
    ],
  });

  // --- Risk matrix
  const meanLead = A.reduce((s, a) => s + a.item.leadTimeDays, 0) / A.length;
  scatterChart($('#riskMatrix'), {
    height: 280,
    xRef: meanLead,
    xLabel: 'Days of cover  (dashed line = average lead time)',
    yLabel: 'Stockout probability',
    ariaLabel: 'Each SKU plotted by days of cover against stockout probability',
    points: A.map((a) => {
      const st = statusOf(a);
      return {
        x: Math.min(a.policy.daysOfCover, 60),
        y: a.policy.stockoutProb * 100,
        color: st.color,
        tip: `<strong>${a.item.name}</strong><br>${num(a.policy.daysOfCover, 1)} days of cover<br>${pct(a.policy.stockoutProb)} stockout probability<br>Lead time ${a.item.leadTimeDays}d · Class ${a.abc}<br><span style="color:#94a3b8">${st.label}</span>`,
      };
    }),
  });
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

function renderInventory() {
  const q = $('#invSearch').value.trim().toLowerCase();
  const cat = $('#invCategory').value;
  const status = $('#invStatus').value;

  const rows = State.analyses.filter((a) => {
    if (q && !(`${a.item.name} ${a.item.sku}`.toLowerCase().includes(q))) return false;
    if (cat && a.item.category !== cat) return false;
    if (status) {
      const st = statusOf(a).key;
      if (status === 'reorder' && !(st === 'reorder' || st === 'critical')) return false;
      if (status === 'expiry' && st !== 'expiry') return false;
      if (status === 'healthy' && st !== 'healthy') return false;
    }
    return true;
  });

  const tbody = $('#inventoryTable tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty">No items match these filters.</div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((a) => {
    const st = statusOf(a);
    return `<tr>
      <td>
        <div class="item-name">${a.item.name}</div>
        <div class="item-sku">${a.item.sku}${a.item.perishable ? ` · exp ${a.item.expiryDate}` : ''}</div>
      </td>
      <td class="muted small">${a.item.category}</td>
      <td class="num">${num(a.item.quantity)}</td>
      <td class="num">${money2(a.item.price)}</td>
      <td class="num">${num(a.policy.daysOfCover, 1)}d</td>
      <td class="num">${pct(a.policy.stockoutProb, 0)}</td>
      <td><span class="badge grey">${a.abc}</span></td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
      <td style="white-space:nowrap">
        <button class="btn ghost small" data-restock="${a.item.sku}" type="button">Restock</button>
        <button class="btn ghost small" data-remove="${a.item.sku}" type="button">Remove</button>
      </td>
    </tr>`;
  }).join('');

  $$('[data-restock]', tbody).forEach((btn) => {
    btn.onclick = () => {
      const a = analysisFor(btn.dataset.restock);
      const suggested = Math.round(a.policy.orderQty);
      const input = prompt(`Restock ${a.item.name}\n\nRecommended order quantity: ${suggested} units\n(EOQ ${Math.round(a.policy.eoq)}, rounded to MOQ ${a.item.moq})\n\nUnits to add:`, suggested);
      if (input === null) return;
      const units = parseInt(input, 10);
      if (!Number.isFinite(units) || units <= 0) return toast('Quantity must be a positive number.', true);
      a.item.restock(units);
      refreshAll();
      toast(`Restocked ${a.item.name} by ${units} units.`);
    };
  });

  $$('[data-remove]', tbody).forEach((btn) => {
    btn.onclick = () => {
      const a = analysisFor(btn.dataset.remove);
      if (!confirm(`Remove ${a.item.name} from inventory?`)) return;
      State.items = State.items.filter((it) => it.sku !== a.item.sku);
      refreshAll();
      toast(`${a.item.name} removed.`);
    };
  });
}

/**
 * Adding an item exercises the same constructor path as the seeded catalogue.
 * A new SKU has no demand history, so it is seeded with a short flat series
 * at the stated expected daily rate — the forecaster needs two full seasons
 * before it can fit anything, and inventing that history explicitly is more
 * honest than letting the model fail silently.
 */
function addItemFlow() {
  const name = prompt('Item name:');
  if (!name) return;
  const category = prompt('Category:', 'Beverages');
  if (!category) return;
  const qty = parseInt(prompt('Opening quantity:', '100'), 10);
  const price = parseFloat(prompt('Selling price ($):', '5.00'));
  const cost = parseFloat(prompt('Unit cost ($):', '2.50'));
  const daily = parseFloat(prompt('Expected daily demand (units):', '20'));
  if (![qty, price, cost, daily].every(Number.isFinite)) return toast('All numeric fields are required.', true);
  if (price <= cost) toast('Warning: price is at or below unit cost.', true);

  const perishable = confirm('Is this item perishable?\n\nOK = yes, Cancel = no');
  let expiryDate = null;
  if (perishable) {
    const days = parseInt(prompt('Days until the current batch expires:', '14'), 10);
    if (!Number.isFinite(days)) return toast('Expiry days must be a number.', true);
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
    expiryDate = d.toISOString().slice(0, 10);
  }

  const rng = mulberry32(Math.floor(Math.random() * 1e9));
  const history = Array.from({ length: 60 }, () => Math.max(0, Math.round(daily * (1 + gaussian(rng) * 0.2))));

  const spec = {
    id: 2000 + State.items.length,
    sku: `NEW-${String(State.items.length + 1).padStart(4, '0')}`,
    name, category, quantity: qty, price, unitCost: cost,
    supplier: 'Manual entry', leadTimeDays: 7, leadTimeSigma: 2, moq: 50, history,
  };

  State.items.push(perishable
    ? new PerishableItem({ ...spec, shelfLifeDays: 30, expiryDate })
    : new NonPerishableItem(spec));

  refreshAll();
  toast(`${name} added with 60 days of seeded demand history.`);
}

/* ------------------------------------------------------------------ */
/* Forecasting view                                                    */
/* ------------------------------------------------------------------ */

function renderForecastView() {
  const sku = $('#fcItem').value;
  const horizon = parseInt($('#fcHorizon').value, 10);
  const a = analysisFor(sku);
  if (!a) return;

  const fc = forecast(a.item.history, horizon);
  const histWindow = a.item.history.slice(-70);
  const fittedWindow = fc.fitted.slice(-70);

  $('#fcTitle').textContent = `${a.item.name} · ${a.item.sku}`;
  $('#fcParams').textContent = `α=${fc.params.alpha}  β=${fc.params.beta}  γ=${fc.params.gamma}  ·  residual σ=${num(fc.sigma, 2)}`;

  lineChart($('#forecastChart'), {
    history: histWindow, fitted: fittedWindow,
    forecast: fc.point, lower: fc.lower, upper: fc.upper,
    height: 320, unit: 'units',
    ariaLabel: `${a.item.name} demand history with a ${horizon}-day forecast`,
    xLabels: [{ i: 0, text: '−70d' }, { i: 35, text: '−35d' }, { i: 69, text: 'today' }, { i: 69 + horizon, text: `+${horizon}d` }],
  });

  const cum = fc.cumulative;

  $('#fcStats').innerHTML = [
    { label: `Forecast, next ${horizon}d`, value: num(cum.point), note: `95% interval ${num(cum.lower)} – ${num(cum.upper)}`, cls: 'info' },
    { label: 'Daily mean', value: num(fc.dailyMean, 1), note: `σ = ${num(fc.sigma, 2)} units/day`, cls: '' },
    { label: 'Backtested MAPE', value: num(a.backtest.model.mape, 1) + '%', note: `${a.backtest.folds} rolling folds, 7-day horizon`, cls: a.backtest.model.mape < 25 ? 'good' : 'warn' },
    { label: 'Skill vs baseline', value: (a.backtest.skill >= 0 ? '+' : '') + num(a.backtest.skill, 3), note: a.backtest.skill > 0 ? 'beats seasonal-naive' : 'loses to seasonal-naive', cls: a.backtest.skill > 0 ? 'good' : 'bad' },
    { label: 'Stock cover', value: num(a.policy.daysOfCover, 1) + 'd', note: `${num(a.item.quantity)} units on hand`, cls: a.policy.daysOfCover < a.item.leadTimeDays ? 'bad' : 'good' },
    { label: 'Composite risk', value: a.riskScore + '/100', note: `class ${a.abc}`, cls: a.riskScore >= 50 ? 'bad' : a.riskScore >= 25 ? 'warn' : 'good' },
  ].map((k) => `<div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Replenishment                                                       */
/* ------------------------------------------------------------------ */

function renderReplenishment() {
  const A = State.analyses;
  const due = A.filter((a) => a.policy.shouldReorder);
  const spend = due.reduce((s, a) => s + a.policy.orderQty * a.item.unitCost, 0);

  $('#zNote').textContent = `z = ${num(Stats.normalQuantile(State.serviceLevel), 3)}`;
  $('#poSummary').textContent = due.length
    ? `${due.length} orders · ${money(spend)} committed`
    : 'nothing below its reorder point';

  const sorted = [...A].sort((a, b) => Number(b.policy.shouldReorder) - Number(a.policy.shouldReorder) || b.policy.stockoutProb - a.policy.stockoutProb);

  $('#replenTable tbody').innerHTML = sorted.map((a) => `
    <tr>
      <td>
        <div class="item-name">${a.item.name}</div>
        <div class="item-sku">${a.item.supplier}</div>
      </td>
      <td class="num">${num(a.item.quantity)}</td>
      <td class="num">${num(a.policy.dBar, 1)}</td>
      <td class="num">${a.item.leadTimeDays} ± ${a.item.leadTimeSigma}d</td>
      <td class="num">${num(a.policy.safetyStock)}</td>
      <td class="num">${num(a.policy.reorderPoint)}</td>
      <td class="num">${num(a.policy.eoq)}</td>
      <td class="num">${a.policy.shouldReorder ? num(a.policy.orderQty) : '—'}</td>
      <td>${a.policy.shouldReorder
        ? `<span class="badge ${a.policy.stockoutProb > 0.5 ? 'red' : 'amber'}">Order now</span>`
        : '<span class="badge green">Hold</span>'}</td>
    </tr>`).join('');
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

function renderExpiry() {
  const per = State.analyses.filter((a) => a.expiry);
  const totalWriteOff = per.reduce((s, a) => s + a.expiry.writeOffValue, 0);
  const totalUnits = per.reduce((s, a) => s + a.expiry.expectedSpoilUnits, 0);
  const atRisk = per.filter((a) => a.expiry.expectedSpoilUnits >= 1).length;
  const perishableValue = per.reduce((s, a) => s + a.item.stockValue, 0);

  $('#expiryKpis').innerHTML = [
    { label: 'Expected write-off', value: money(totalWriteOff), note: `${num(totalUnits)} units across ${per.length} perishable lines`, cls: totalWriteOff > 500 ? 'bad' : 'good' },
    { label: 'Batches at risk', value: atRisk, note: `of ${per.length} perishable SKUs`, cls: atRisk ? 'warn' : 'good' },
    { label: 'Perishable stock value', value: money(perishableValue), note: 'at cost', cls: '' },
    { label: 'Waste rate', value: pct(totalWriteOff / (perishableValue || 1), 1), note: 'of perishable value', cls: totalWriteOff / (perishableValue || 1) > 0.05 ? 'warn' : 'good' },
  ].map((k) => `<div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');

  const sorted = [...per].sort((a, b) => b.expiry.writeOffValue - a.expiry.writeOffValue);

  $('#expiryTable tbody').innerHTML = sorted.map((a) => {
    const e = a.expiry;
    const risky = e.expectedSpoilUnits >= 1;
    return `<tr>
      <td>
        <div class="item-name">${a.item.name}</div>
        <div class="item-sku">${a.item.sku} · expires ${a.item.expiryDate}</div>
      </td>
      <td class="num">${num(a.item.quantity)}</td>
      <td class="num">${e.days}</td>
      <td class="num">${num(e.cumulativeDemand)}</td>
      <td class="num">${num(e.expectedSpoilUnits)}</td>
      <td class="num">${money(e.writeOffValue)}</td>
      <td class="num">${e.suggestedDiscount > 1 ? num(e.suggestedDiscount) + '%' : '—'}</td>
      <td>${risky
        ? `<span class="badge ${e.expectedSpoilUnits > 0.25 * a.item.quantity ? 'red' : 'amber'}">${e.clearanceAdvised ? 'Mark down' : 'Watch'}</span>`
        : '<span class="badge green">Will sell through</span>'}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* Anomalies                                                           */
/* ------------------------------------------------------------------ */

function renderAnomalies() {
  const events = [];
  State.analyses.forEach((a) => a.anomalies.anomalies.forEach((ev) => events.push({ a, ev })));
  events.sort((x, y) => Math.abs(y.ev.z) - Math.abs(x.ev.z));

  const spikes = events.filter((e) => e.ev.direction === 'spike').length;
  const drops = events.length - spikes;
  const checked = State.analyses.reduce((s, a) => s + a.anomalies.checked, 0);

  $('#anomalyKpis').innerHTML = [
    { label: 'Events detected', value: events.length, note: `across ${new Set(events.map((e) => e.a.item.sku)).size} SKUs`, cls: events.length ? 'warn' : 'good' },
    { label: 'Demand spikes', value: spikes, note: 'sales well above the seasonal baseline', cls: 'info' },
    { label: 'Demand drops', value: drops, note: 'often a supply problem, not a demand one', cls: drops ? 'bad' : 'good' },
    { label: 'Observations scored', value: num(checked), note: `${pct(events.length / (checked || 1), 2)} flagged`, cls: '' },
  ].map((k) => `<div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');

  $('#anomalyList').innerHTML = events.length
    ? events.slice(0, 20).map(({ a, ev }) => {
        const spike = ev.direction === 'spike';
        return `<div class="insight ${spike ? 'info' : 'warning'}">
          <div class="insight-head">
            <span class="insight-title">${a.item.name}</span>
            <span class="badge ${spike ? 'blue' : 'amber'}">${spike ? 'Spike' : 'Drop'}</span>
            <span class="badge grey">day ${ev.day}</span>
            <span class="badge grey mono">z = ${ev.z.toFixed(1)}</span>
          </div>
          <div class="insight-body">
            Sold <strong>${num(ev.value)}</strong> units against <strong>${num(ev.expected, 1)}</strong> expected after removing trend and weekly seasonality —
            ${spike
              ? 'consistent with a promotion or an external demand shock.'
              : 'a drop this size on a healthy SKU usually means the item was unavailable, not unwanted.'}
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">No residual exceeded the |z| = 3 threshold.</div>';
}

/* ------------------------------------------------------------------ */
/* Accuracy                                                            */
/* ------------------------------------------------------------------ */

function renderAccuracy() {
  const A = State.analyses.filter((a) => Number.isFinite(a.backtest.skill));
  const meanMape = A.reduce((s, a) => s + a.backtest.model.mape, 0) / A.length;
  const meanSkill = A.reduce((s, a) => s + a.backtest.skill, 0) / A.length;
  const wins = A.filter((a) => a.backtest.skill > 0).length;
  const meanBias = A.reduce((s, a) => s + a.backtest.model.bias, 0) / A.length;

  $('#accuracyKpis').innerHTML = [
    { label: 'Mean MAPE', value: num(meanMape, 1) + '%', note: `${A.length} SKUs, 6 folds each`, cls: meanMape < 25 ? 'good' : 'warn' },
    { label: 'Mean skill score', value: (meanSkill >= 0 ? '+' : '') + num(meanSkill, 3), note: 'vs seasonal-naive baseline', cls: meanSkill > 0 ? 'good' : 'bad' },
    { label: 'Beats baseline', value: `${wins}/${A.length}`, note: 'SKUs where skill > 0', cls: wins > A.length * 0.7 ? 'good' : 'warn' },
    { label: 'Mean bias', value: num(meanBias, 2), note: meanBias > 0 ? 'under-forecasting on average' : 'over-forecasting on average', cls: Math.abs(meanBias) < 1 ? 'good' : 'warn' },
  ].map((k) => `<div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');

  const sorted = [...A].sort((a, b) => b.backtest.skill - a.backtest.skill);

  $('#accuracyTable tbody').innerHTML = sorted.map((a) => {
    const b = a.backtest;
    return `<tr>
      <td>
        <div class="item-name">${a.item.name}</div>
        <div class="item-sku">${a.item.sku}</div>
      </td>
      <td class="num">${num(b.model.mape, 1)}%</td>
      <td class="num">${num(b.model.mae, 2)}</td>
      <td class="num">${num(b.model.rmse, 2)}</td>
      <td class="num">${b.model.bias >= 0 ? '+' : ''}${num(b.model.bias, 2)}</td>
      <td class="num muted">${num(b.naive.mae, 2)}</td>
      <td class="num muted">${num(b.seasonalNaive.mae, 2)}</td>
      <td class="num">${b.skill >= 0 ? '+' : ''}${num(b.skill, 3)}</td>
      <td>${b.skill > 0.15 ? '<span class="badge green">Strong</span>'
          : b.skill > 0 ? '<span class="badge blue">Beats baseline</span>'
          : '<span class="badge red">Loses to baseline</span>'}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

const SUGGESTIONS = [
  'What should I order this week?',
  "What's at risk of running out?",
  'Forecast for oat milk',
  "What's expiring soon?",
  'Any anomalies in the sales data?',
  'How accurate is the model?',
  'Show me the ABC classification',
  'Tell me about ELC-5003',
];

function addMessage(html, role, meta = null) {
  const log = $('#chatLog');
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.innerHTML = html + (meta ? `<div class="msg-meta">${meta}</div>` : '');
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
}

function askAssistant(text) {
  if (!text.trim()) return;
  addMessage(text.replace(/</g, '&lt;'), 'user');
  $('#chatInput').value = '';

  // A short delay so the exchange reads as a conversation rather than a
  // synchronous function call — the work itself is instant.
  setTimeout(() => {
    const res = Assistant.respond(text, State.analyses);
    const meta = `intent: ${res.intent} · confidence: ${(res.confidence * 100).toFixed(0)}%` +
      (res.entity ? ` · entity: ${res.entity}` : '');
    addMessage(res.html, 'bot', meta);
  }, 180);
}

function initAssistant() {
  $('#suggestions').innerHTML = SUGGESTIONS
    .map((s) => `<button class="suggestion" type="button">${s}</button>`).join('');
  $$('#suggestions .suggestion').forEach((b) => {
    b.onclick = () => askAssistant(b.textContent);
  });

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    askAssistant($('#chatInput').value);
  };

  addMessage(
    `I'm reading the same analysis objects the dashboard renders — ${State.analyses.length} SKUs, 200 days of history each. Ask me about replenishment, stockout risk, forecasts, expiry, anomalies or model accuracy.`,
    'bot');
}

/* ------------------------------------------------------------------ */
/* Customer storefront                                                 */
/* ------------------------------------------------------------------ */

function renderShop() {
  const q = $('#shopSearch').value.trim().toLowerCase();
  const cat = $('#shopCategory').value;

  const items = State.items.filter((it) => {
    if (q && !it.name.toLowerCase().includes(q)) return false;
    if (cat && it.category !== cat) return false;
    return true;
  });

  $('#shopGrid').innerHTML = items.length ? items.map((it) => {
    const out = it.quantity === 0;
    const low = it.quantity > 0 && it.quantity < 20;
    return `<div class="product">
      <div class="product-cat">${it.category}</div>
      <div class="product-name">${it.name}</div>
      <div class="product-price">${money2(it.price)}</div>
      <div class="product-stock">
        ${out ? '<span class="badge red">Out of stock</span>'
            : low ? `<span class="badge amber">Only ${it.quantity} left</span>`
            : `<span class="badge green">In stock</span> <span class="dim">${num(it.quantity)} available</span>`}
      </div>
      ${it.perishable ? `<div class="small dim">Best before ${it.expiryDate}</div>` : ''}
      <div class="product-row">
        <input type="number" min="1" value="1" data-qty="${it.sku}" ${out ? 'disabled' : ''}>
        <button class="btn small" data-buy="${it.sku}" type="button" ${out ? 'disabled' : ''}>Buy</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No items match your search.</div>';

  $$('[data-buy]').forEach((btn) => {
    btn.onclick = () => {
      const sku = btn.dataset.buy;
      const item = State.items.find((i) => i.sku === sku);
      const units = parseInt($(`[data-qty="${sku}"]`).value, 10);

      // The domain model throws; the UI is what decides how to present it.
      try {
        const spend = item.purchase(units);
        State.revenue += spend;
        State.cart.push({ name: item.name, units, spend });
        recompute();
        renderShop();
        renderCart();
        toast(`Bought ${units} × ${item.name} — ${money2(spend)}`);
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          toast(`Only ${err.available} units of ${item.name} left.`, true);
        } else {
          toast(err.message, true);
        }
      }
    };
  });
}

function renderCart() {
  const card = $('#cartCard');
  if (!State.cart.length) {
    card.innerHTML = '<div class="empty">Nothing purchased yet.</div>';
    return;
  }
  card.innerHTML = State.cart.map((l) => `
    <div class="cart-line">
      <span>${l.units} × ${l.name}</span>
      <span class="mono">${money2(l.spend)}</span>
    </div>`).join('') +
    `<div class="cart-total"><span>Total</span><span class="mono">${money2(State.revenue)}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* Routing & init                                                      */
/* ------------------------------------------------------------------ */

const RENDERERS = {
  dashboard: renderDashboard,
  inventory: renderInventory,
  forecast: renderForecastView,
  replenishment: renderReplenishment,
  expiry: renderExpiry,
  anomalies: renderAnomalies,
  accuracy: renderAccuracy,
  assistant: () => {},
  shop: renderShop,
  cart: renderCart,
};

let currentView = 'dashboard';

function showView(name, scope) {
  currentView = name;
  $$('.view', scope).forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab', scope).forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  (RENDERERS[name] ?? (() => {}))();
}

/** Re-runs the analysis and repaints whatever view is on screen. */
function refreshAll() {
  recompute();
  populateSelectors();
  (RENDERERS[currentView] ?? (() => {}))();
}

function populateSelectors() {
  const cats = [...new Set(State.items.map((i) => i.category))].sort();

  const fill = (sel, keepValue = true) => {
    const prev = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      cats.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (keepValue && cats.includes(prev)) sel.value = prev;
  };
  fill($('#invCategory'));
  fill($('#shopCategory'));

  const fcSel = $('#fcItem');
  const prevSku = fcSel.value;
  fcSel.innerHTML = State.items
    .map((i) => `<option value="${i.sku}">${i.name} — ${i.sku}</option>`).join('');
  if (State.items.some((i) => i.sku === prevSku)) fcSel.value = prevSku;
}

function boot() {
  State.items = buildInventory();
  recompute();
  populateSelectors();
}

function wireEvents() {
  // --- Login
  $('#loginForm').onsubmit = (e) => {
    e.preventDefault();
    const u = $('#username').value.trim();
    const p = $('#password').value;
    const owner = State.owners.find((o) => o.username === u && o.password === p);
    if (!owner) {
      $('#loginError').textContent = 'Invalid credentials. Try admin / admin123.';
      return;
    }
    $('#loginError').textContent = '';
    $('#ownerName').textContent = u;
    $('#loginScreen').classList.add('hidden');
    $('#ownerApp').classList.add('active');
    showView('dashboard', $('#ownerApp'));
    initAssistant();
  };

  $('#customerBtn').onclick = () => {
    $('#loginScreen').classList.add('hidden');
    $('#customerApp').classList.add('active');
    showView('shop', $('#customerApp'));
  };

  const logout = () => {
    $('#ownerApp').classList.remove('active');
    $('#customerApp').classList.remove('active');
    $('#loginScreen').classList.remove('hidden');
  };
  $('#ownerLogout').onclick = logout;
  $('#customerLogout').onclick = logout;

  // --- Tabs
  $$('#ownerApp .tab').forEach((t) => {
    t.onclick = () => showView(t.dataset.view, $('#ownerApp'));
  });
  $$('#customerApp .tab').forEach((t) => {
    t.onclick = () => showView(t.dataset.view, $('#customerApp'));
  });

  // --- Filters
  $('#invSearch').oninput = renderInventory;
  $('#invCategory').onchange = renderInventory;
  $('#invStatus').onchange = renderInventory;
  $('#addItemBtn').onclick = addItemFlow;

  $('#fcItem').onchange = renderForecastView;
  $('#fcHorizon').onchange = renderForecastView;

  $('#serviceLevel').onchange = (e) => {
    State.serviceLevel = parseFloat(e.target.value);
    refreshAll();
  };

  $('#shopSearch').oninput = renderShop;
  $('#shopCategory').onchange = renderShop;
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  wireEvents();
});
