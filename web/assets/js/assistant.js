/**
 * assistant.js — Natural-language layer over the analysis objects.
 *
 * Deliberately NOT an LLM call. The assistant classifies the utterance into
 * one of ten intents (ai-engine.js: classifyIntent), pulls the matching
 * entity out of the live catalogue, and then renders an answer directly from
 * the analysis records. The consequence worth stating: it is incapable of
 * producing a number the dashboard does not also show, which is the property
 * you actually want from an operations assistant.
 *
 * Every reply carries the classified intent and its confidence, so the
 * routing decision is visible rather than hidden.
 */

const Assistant = (() => {
  const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
  const n = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  /** Renders a compact bullet list. */
  const list = (rows) => `<ul>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`;
  const plural = (v, one) => `${v} ${v === 1 ? one : one + 's'}`;

  /* ---------------------------------------------------------------- */
  /* Per-intent responders                                             */
  /* ---------------------------------------------------------------- */

  const responders = {
    reorder(analyses) {
      const due = analyses.filter((a) => a.policy.shouldReorder)
        .sort((a, b) => b.policy.stockoutProb - a.policy.stockoutProb);
      if (!due.length) return 'Nothing is below its reorder point right now. Every SKU has enough cover to survive its supplier lead time at the target service level.';

      const spend = due.reduce((s, a) => s + a.policy.orderQty * a.item.unitCost, 0);
      return `<strong>${due.length} of ${analyses.length} items are at or below their reorder point.</strong> Placing every recommended order costs about ${money(spend)}.` +
        list(due.slice(0, 6).map((a) =>
          `<strong>${a.item.name}</strong> — order ${n(a.policy.orderQty)} units (${a.item.leadTimeDays}-day lead time, ${n(a.item.quantity)} on hand vs reorder point ${n(a.policy.reorderPoint)})`));
    },

    stockout(analyses) {
      const risky = analyses.filter((a) => a.policy.stockoutProb > 0.2)
        .sort((a, b) => b.policy.stockoutProb - a.policy.stockoutProb);
      if (!risky.length) return 'No SKU has more than a 20% chance of running out before its next delivery could arrive.';

      return `<strong>${risky.length} items carry meaningful stockout risk</strong> over their replenishment lead time.` +
        list(risky.slice(0, 6).map((a) =>
          `<strong>${a.item.name}</strong> — ${pct(a.policy.stockoutProb)} probability, ${n(a.policy.daysOfCover, 1)} days of cover against a ${a.item.leadTimeDays}-day lead time. Expected shortfall ${n(a.policy.expectedShortage, 1)} units.`)) +
        `<br>Risk is computed against demand <em>and</em> lead-time variance: σ_DL = √(LT·σ_d² + d̄²·σ_LT²).`;
    },

    forecast(analyses, entity) {
      if (!entity) {
        const total = analyses.reduce((s, a) => s + a.forecast.point.reduce((x, y) => x + y, 0), 0);
        const top = [...analyses].sort((a, b) =>
          b.forecast.point.reduce((x, y) => x + y, 0) - a.forecast.point.reduce((x, y) => x + y, 0)).slice(0, 5);
        return `Across all ${analyses.length} SKUs the model expects <strong>${n(total)} units</strong> over the next 14 days.` +
          list(top.map((a) => `<strong>${a.item.name}</strong> — ${n(a.forecast.point.reduce((x, y) => x + y, 0))} units (${n(a.forecast.dailyMean, 1)}/day)`)) +
          `Name an item and I'll give you its interval too.`;
      }
      const a = entity;
      const c = a.forecast.cumulative;
      return `<strong>${a.item.name}</strong> — the 14-day forecast is <strong>${n(c.point)} units</strong>, with a 95% interval of ${n(c.lower)}–${n(c.upper)}.` +
        list([
          `Daily mean ${n(a.forecast.dailyMean, 1)} units, residual σ ${n(a.forecast.sigma, 1)}`,
          `Fitted smoothing constants α=${a.forecast.params.alpha}, β=${a.forecast.params.beta}, γ=${a.forecast.params.gamma}`,
          `Backtested MAPE ${n(a.backtest.model.mape, 1)}% over ${a.backtest.folds} rolling folds`,
        ]);
    },

    expiry(analyses) {
      const risky = analyses.filter((a) => a.expiry && a.expiry.expectedSpoilUnits >= 1)
        .sort((a, b) => b.expiry.writeOffValue - a.expiry.writeOffValue);
      if (!risky.length) return 'No perishable batch is forecast to spoil — every one should sell through before its expiry date.';

      const total = risky.reduce((s, a) => s + a.expiry.writeOffValue, 0);
      return `<strong>${money(total)} of stock is forecast to expire unsold.</strong>` +
        list(risky.slice(0, 6).map((a) =>
          `<strong>${a.item.name}</strong> — ${n(a.expiry.expectedSpoilUnits)} of ${n(a.item.quantity)} units, ${money(a.expiry.writeOffValue)} at cost, ${plural(a.expiry.days, 'day')} of shelf life left.` +
          (a.expiry.suggestedDiscount > 1 ? ` Clearing needs roughly a ${n(a.expiry.suggestedDiscount)}% markdown.` : ''))) +
        `<br>This is an expected value, not a threshold: cumulative demand over the remaining shelf life is itself uncertain, so the shortfall is integrated rather than compared.`;
    },

    lowstock(analyses) {
      const low = analyses.filter((a) => a.policy.daysOfCover < a.item.leadTimeDays)
        .sort((a, b) => a.policy.daysOfCover - b.policy.daysOfCover);
      if (!low.length) return 'Every item currently holds more cover than its supplier lead time.';
      return `<strong>${low.length} items hold less cover than their lead time</strong> — they will run out before a replacement order could land.` +
        list(low.map((a) => `<strong>${a.item.name}</strong> — ${n(a.policy.daysOfCover, 1)} days of cover vs a ${a.item.leadTimeDays}-day lead time`)) +
        `<br>A fixed threshold ("fewer than 5 units") would miss most of these: the right threshold depends on how fast the item sells and how long the supplier takes.`;
    },

    value(analyses) {
      const stockValue = analyses.reduce((s, a) => s + a.item.stockValue, 0);
      const rev90 = analyses.reduce((s, a) => s + a.item.revenue(90), 0);
      const profit90 = analyses.reduce((s, a) => s + a.item.profit(90), 0);
      const top = [...analyses].sort((a, b) => b.annualMargin - a.annualMargin).slice(0, 5);
      return `<strong>${money(stockValue)}</strong> of inventory at cost. Trailing 90 days: ${money(rev90)} revenue, ${money(profit90)} gross profit (${pct(profit90 / rev90)} margin).` +
        list(top.map((a) => `<strong>${a.item.name}</strong> — ${money(a.annualMargin)}/yr margin run-rate · class ${a.abc}`));
    },

    anomaly(analyses) {
      const all = [];
      for (const a of analyses) {
        for (const ev of a.anomalies.anomalies) all.push({ a, ev });
      }
      if (!all.length) return 'No anomalies above |z| = 3 in the deseasonalised residuals.';
      all.sort((x, y) => Math.abs(y.ev.z) - Math.abs(x.ev.z));
      return `<strong>${all.length} anomalous days</strong> across ${new Set(all.map((x) => x.a.item.sku)).size} SKUs.` +
        list(all.slice(0, 6).map(({ a, ev }) =>
          `<strong>${a.item.name}</strong> — day ${ev.day}, ${ev.direction} of ${n(ev.value)} units against ${n(ev.expected, 1)} expected (z = ${ev.z.toFixed(1)})`)) +
        `<br>Scored on residuals after trend and weekly seasonality are removed, using a MAD-based z so the outliers don't inflate their own yardstick.`;
    },

    abc(analyses) {
      const groups = { A: [], B: [], C: [] };
      analyses.forEach((a) => groups[a.abc].push(a));
      const marginOf = (g) => g.reduce((s, a) => s + a.annualMargin, 0);
      const total = marginOf(analyses);
      return `ABC segmentation by annualised gross margin:` +
        list(['A', 'B', 'C'].map((k) =>
          `<strong>Class ${k}</strong> — ${groups[k].length} items, ${money(marginOf(groups[k]))}/yr (${pct(marginOf(groups[k]) / total, 0)} of margin)`)) +
        `Class A: <strong>${groups.A.map((a) => a.item.name).join(', ')}</strong>. These justify tighter service levels and more frequent review; class C does not.`;
    },

    accuracy(analyses, entity) {
      if (entity) {
        const b = entity.backtest;
        return `<strong>${entity.item.name}</strong> backtest over ${b.folds} rolling folds, ${b.horizon}-day horizon:` +
          list([
            `MAPE ${n(b.model.mape, 1)}% · MAE ${n(b.model.mae, 2)} · RMSE ${n(b.model.rmse, 2)}`,
            `Bias ${n(b.model.bias, 2)} units ${b.model.bias > 0 ? '(under-forecasting)' : '(over-forecasting)'}`,
            `Seasonal-naive baseline MAE ${n(b.seasonalNaive.mae, 2)} → skill ${b.skill >= 0 ? '+' : ''}${n(b.skill, 3)}`,
          ]) +
          (b.skill > 0 ? 'The model beats the baseline here.' : 'The model <strong>loses</strong> to the baseline on this SKU — worth saying rather than hiding.');
      }
      const ok = analyses.filter((a) => Number.isFinite(a.backtest.skill));
      const meanMape = ok.reduce((s, a) => s + a.backtest.model.mape, 0) / ok.length;
      const meanSkill = ok.reduce((s, a) => s + a.backtest.skill, 0) / ok.length;
      const wins = ok.filter((a) => a.backtest.skill > 0).length;
      return `Rolling-origin backtest, 6 folds × 7-day horizon, refitted on history only at each cut:` +
        list([
          `Mean MAPE <strong>${n(meanMape, 1)}%</strong> across ${ok.length} SKUs`,
          `Mean skill vs seasonal-naive <strong>${meanSkill >= 0 ? '+' : ''}${n(meanSkill, 3)}</strong>`,
          `Beats the baseline on <strong>${wins} of ${ok.length}</strong> SKUs`,
        ]) +
        `The losses are real and left in. Promotional series are where the model struggles: a smoothing model has no promotion feature to lean on.`;
    },

    itemDetail(analyses, entity) {
      if (!entity) return 'Which item? Name it or give me a SKU — for example "status of oat milk" or "tell me about ELC-5003".';
      const a = entity;
      const rows = [
        `On hand <strong>${n(a.item.quantity)}</strong> units (${money(a.item.stockValue)} at cost) · class ${a.abc}`,
        `Demand ${n(a.forecast.dailyMean, 1)}/day → ${n(a.policy.daysOfCover, 1)} days of cover`,
        `Lead time ${a.item.leadTimeDays} ± ${a.item.leadTimeSigma} days from ${a.item.supplier}`,
        `Stockout probability <strong>${pct(a.policy.stockoutProb)}</strong> · reorder point ${n(a.policy.reorderPoint)}`,
        `Forecast MAPE ${n(a.backtest.model.mape, 1)}% · composite risk score ${a.riskScore}/100`,
      ];
      if (a.expiry) {
        rows.push(`Expires in ${plural(a.expiry.days, 'day')} · expected spoilage ${n(a.expiry.expectedSpoilUnits)} units (${money(a.expiry.writeOffValue)})`);
      }
      return `<strong>${a.item.name}</strong> <span class="dim">${a.item.sku}</span>` + list(rows) +
        (a.policy.shouldReorder ? `<strong>Action:</strong> below reorder point — order ${n(a.policy.orderQty)} units.` : 'No action needed right now.');
    },

    help() {
      return `I read the same analysis objects the dashboard renders, so I can't quote a number it doesn't show. Try:` +
        list([
          '"what should I order?" — replenishment recommendations',
          '"what\'s at risk of running out?" — stockout probabilities',
          '"forecast for oat milk" — demand forecast with intervals',
          '"what\'s expiring?" — expected spoilage and write-off value',
          '"any anomalies?" — unusual sales days',
          '"how accurate is the model?" — backtest results',
          '"tell me about ELC-5003" — full picture for one SKU',
        ]);
    },

    unknown() {
      return `I couldn't match that to anything I know how to answer. I handle replenishment, stockout risk, forecasts, expiry, anomalies, ABC classification, model accuracy and per-item detail. Ask "help" for examples.`;
    },
  };

  /* ---------------------------------------------------------------- */
  /* Entry point                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * @param {string} utterance
   * @param {object[]} analyses  analysis records from analyseInventory()
   * @returns {{html:string, intent:string, confidence:number, entity:?string}}
   */
  function respond(utterance, analyses) {
    const { intent, confidence } = classifyIntent(utterance);
    const items = analyses.map((a) => a.item);
    const match = extractItem(utterance, items);
    const entity = match ? analyses.find((a) => a.item.sku === match.item.sku) : null;

    // An item name with no clear intent is a request for that item's detail.
    let resolved = intent;
    if (intent === 'unknown' && entity) resolved = 'itemDetail';

    const fn = responders[resolved] ?? responders.unknown;
    const html = fn(analyses, entity);

    return {
      html,
      intent: resolved,
      confidence,
      entity: entity ? entity.item.sku : null,
    };
  }

  return { respond, responders };
})();

if (typeof window !== 'undefined') window.Assistant = Assistant;
if (typeof module !== 'undefined' && module.exports) module.exports = Assistant;
