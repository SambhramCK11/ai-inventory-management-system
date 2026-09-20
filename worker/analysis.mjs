/**
 * Analysis plumbing shared by the Worker and the local refresh script.
 *
 * Holds two things:
 *
 *   1. The projections that turn an Analysis object into the JSON shapes the
 *      API returns. These mirror ApiServer.java field for field, so the Worker
 *      and the Java backend are drop-in replacements for each other.
 *   2. Serialisation for analysis_cache — the heavy arrays are dropped before
 *      storing, because the aggregate endpoints never read them.
 */

import engine from '../web/assets/js/ai-engine.js';

const { classifyABC, analyseItem } = engine;

/** ABC entries keyed by SKU. Cheap — no forecasting, just sorting by margin. */
export function abcIndex(items) {
  return new Map(classifyABC(items).map((entry) => [entry.item.sku, entry]));
}

/**
 * Analyse one SKU against the catalogue it belongs to.
 *
 * ABC class is relative to the whole catalogue, so `items` is the full list
 * even though only `item` is analysed.
 */
export function analyseOne(item, items, opts = {}) {
  return analyseItem(item, abcIndex(items).get(item.sku), opts);
}

/**
 * Strip an Analysis down to what analysis_cache needs.
 *
 * forecast.fitted, forecast.mult and the backtest's actual/predicted vectors
 * are each a few hundred numbers used only for charting a single SKU, which is
 * served live. Dropping them takes a cached row from ~7 KB to well under 1 KB.
 */
export function forCache(analysis) {
  const { item, forecast, backtest, ...rest } = analysis;
  return {
    ...rest,
    forecast: {
      ...forecast,
      fitted: undefined,
      mult: undefined,
    },
    backtest: {
      ...backtest,
      model: { ...backtest.model, actual: undefined, predicted: undefined },
      naive: { ...backtest.naive, actual: undefined, predicted: undefined },
      seasonalNaive: {
        ...backtest.seasonalNaive,
        actual: undefined,
        predicted: undefined,
      },
    },
  };
}

/** Item JSON, matching ApiServer.itemJson(). */
export function itemJson(item) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    price: item.price,
    unitCost: item.unitCost,
    marginPerUnit: item.marginPerUnit,
    stockValue: item.stockValue,
    supplier: item.supplier,
    leadTimeDays: item.leadTimeDays,
    leadTimeSigma: item.leadTimeSigma,
    moq: item.moq,
    perishable: item.perishable,
    shelfLifeDays: item.shelfLifeDays,
    expiryDate: item.expiryDate,
    daysToExpiry: Number.isFinite(item.daysToExpiry()) ? item.daysToExpiry() : null,
    atRisk: item.isAtRisk(),
    unitsSold28: item.unitsSold(28),
    revenue28: item.revenue(28),
    profit28: item.profit(28),
  };
}

/** One row of GET /api/replenishment. */
export function replenishmentRow(sku, name, quantity, leadTimeDays, policy) {
  return {
    sku,
    name,
    onHand: quantity,
    dailyDemand: policy.dBar,
    leadTimeDays,
    safetyStock: policy.safetyStock,
    reorderPoint: policy.reorderPoint,
    eoq: policy.eoq,
    orderQty: policy.orderQty,
    stockoutProb: policy.stockoutProb,
    daysOfCover: policy.daysOfCover,
    shouldReorder: policy.shouldReorder,
  };
}

/** One row of GET /api/expiry. Only perishables have an expiry block. */
export function expiryRow(sku, name, quantity, expiryDate, expiry) {
  return {
    sku,
    name,
    quantity,
    expiryDate,
    daysLeft: expiry.days,
    forecastDemand: expiry.cumulativeDemand,
    expectedSpoilUnits: expiry.expectedSpoilUnits,
    writeOffValue: expiry.writeOffValue,
    spoilProbability: expiry.spoilProbability,
    // Absent from the day-zero early return in expiryRisk().
    suggestedDiscountPct: expiry.suggestedDiscount ?? null,
    clearanceAdvised: expiry.clearanceAdvised,
  };
}

/** One row of GET /api/accuracy. */
export function accuracyRow(sku, name, backtest) {
  return {
    sku,
    name,
    mape: backtest.model.mape,
    mae: backtest.model.mae,
    rmse: backtest.model.rmse,
    bias: backtest.model.bias,
    naiveMae: backtest.naive.mae,
    seasonalNaiveMae: backtest.seasonalNaive.mae,
    skill: backtest.skill,
    folds: backtest.folds,
  };
}

/** Rows of GET /api/anomalies — one per detected anomaly, not per SKU. */
export function anomalyRows(sku, name, anomalies) {
  return anomalies.anomalies.map((a) => ({
    sku,
    name,
    day: a.day,
    observed: a.value,
    expected: a.expected,
    z: a.z,
    direction: a.direction,
  }));
}
