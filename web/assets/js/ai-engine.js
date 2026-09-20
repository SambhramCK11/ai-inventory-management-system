/**
 * ai-engine.js — The AI/ML layer of the Inventory Management System.
 *
 * Everything here is implemented from first principles (no ML library, no
 * network calls) so the maths is inspectable and the results are
 * reproducible. Six capabilities:
 *
 *   1. forecast()            Holt-Winters triple exponential smoothing with
 *                            a grid-searched (alpha, beta, gamma) and
 *                            prediction intervals from residual variance.
 *   2. backtest()            Rolling-origin evaluation vs two baselines
 *                            (naive, seasonal naive). Reports MAPE / MAE /
 *                            RMSE / bias and skill score.
 *   3. inventoryPolicy()     Safety stock, reorder point, EOQ and stockout
 *                            probability under demand AND lead-time
 *                            uncertainty.
 *   4. expiryRisk()          Expected spoilage units and write-off value for
 *                            perishables, from the forecast and shelf life.
 *   5. detectAnomalies()     Robust (MAD-based) z-scores on STL-style
 *                            deseasonalised residuals.
 *   6. classifyABC()         Pareto/ABC segmentation by annual margin.
 *
 * Plus a small intent-classification NLU used by the assistant.
 */

/* ================================================================== */
/* Statistical primitives                                              */
/* ================================================================== */

const Stats = {
  mean(xs) {
    if (!xs.length) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  },

  /** Sample standard deviation (n-1 denominator). */
  std(xs) {
    if (xs.length < 2) return 0;
    const m = Stats.mean(xs);
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(v);
  },

  median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },

  /** Median absolute deviation, scaled to be a consistent sigma estimator. */
  mad(xs) {
    const med = Stats.median(xs);
    return 1.4826 * Stats.median(xs.map((x) => Math.abs(x - med)));
  },

  /**
   * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation.
   * Max absolute error ~1.5e-7 — far tighter than the data warrants.
   */
  normalCdf(z) {
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  },

  /**
   * Inverse standard normal CDF (Acklam's rational approximation).
   * Used to turn a target service level into a safety factor z.
   */
  normalQuantile(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
               1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
               6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
               -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
               3.754408661907416e0];
    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    let q;
    let r;
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > pHigh) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
              ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  },
};

/* ================================================================== */
/* 1. Forecasting — Holt-Winters (additive trend, multiplicative-free) */
/* ================================================================== */

const SEASON = 7; // weekly seasonality

/**
 * Additive Holt-Winters triple exponential smoothing.
 *
 *   level_t    = alpha (y_t - season_{t-m}) + (1-alpha)(level_{t-1} + trend_{t-1})
 *   trend_t    = beta  (level_t - level_{t-1}) + (1-beta) trend_{t-1}
 *   season_t   = gamma (y_t - level_t)        + (1-gamma) season_{t-m}
 *   yhat_{t+h} = level_t + h*trend_t + season_{t+h-m}
 *
 * Returns fitted values, in-sample residuals and the final state, so the
 * same state can be rolled forward for any horizon.
 */
function holtWinters(series, alpha, beta, gamma, m = SEASON) {
  const n = series.length;
  if (n < 2 * m) throw new RangeError('Need at least two full seasons of history');

  // --- Seasonal initialisation: average of each period position over the
  //     first two seasons, centred so seasonal factors sum to zero.
  const season = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    season[i] = (series[i] + series[i + m]) / 2;
  }
  const seasonMean = Stats.mean(season);
  for (let i = 0; i < m; i++) season[i] -= seasonMean;

  // --- Level and trend initialisation from the first two seasons.
  const firstSeason = Stats.mean(series.slice(0, m));
  const secondSeason = Stats.mean(series.slice(m, 2 * m));
  let level = firstSeason;
  let trend = (secondSeason - firstSeason) / m;

  const seasonals = [...season];
  const fitted = new Array(n).fill(null);
  const residuals = [];

  for (let t = 0; t < n; t++) {
    const s = seasonals[t % m];
    const prediction = level + trend + s;
    if (t >= m) {
      fitted[t] = prediction;
      residuals.push(series[t] - prediction);
    }

    const prevLevel = level;
    level = alpha * (series[t] - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonals[t % m] = gamma * (series[t] - level) + (1 - gamma) * s;
  }

  return { level, trend, seasonals, fitted, residuals, m, n };
}

/** Projects a fitted Holt-Winters state h steps ahead. */
function project(state, horizon) {
  const out = [];
  for (let h = 1; h <= horizon; h++) {
    const s = state.seasonals[(state.n + h - 1) % state.m];
    out.push(Math.max(0, state.level + h * state.trend + s));
  }
  return out;
}

/**
 * h-step-ahead forecast error variance multiplier for additive Holt-Winters,
 * i.e. ETS(A,A,A). The naive approach — widening the band by sqrt(h), as if
 * errors accumulated like a random walk — badly overstates uncertainty for a
 * smoothing model, because the model corrects toward the level at every step
 * rather than drifting freely.
 *
 * The correct variance (Hyndman et al., "Forecasting with Exponential
 * Smoothing", ch. 6) is:
 *
 *   Var(h) = sigma^2 * [ 1 + SUM_{j=1}^{h-1} c_j^2 ]
 *   c_j    = alpha*(1 + j*beta) + gamma*(1 - alpha)*1{ j mod m == 0 }
 *
 * Returns the multiplier sqrt(1 + sum c_j^2) for each h in 1..horizon, so the
 * caller can scale the residual sigma.
 */
function varianceMultipliers(horizon, alpha, beta, gamma, m = SEASON) {
  const out = [];
  let acc = 0;
  for (let h = 1; h <= horizon; h++) {
    if (h > 1) {
      const j = h - 1;
      const c = alpha * (1 + j * beta) + (j % m === 0 ? gamma * (1 - alpha) : 0);
      acc += c * c;
    }
    out.push(Math.sqrt(1 + acc));
  }
  return out;
}

/**
 * Grid-searches (alpha, beta, gamma) by minimising in-sample SSE, then
 * forecasts `horizon` days ahead with prediction intervals derived from the
 * ETS h-step error variance above.
 */
function forecast(series, horizon = 14, confidence = 0.95) {
  const grid = [0.05, 0.15, 0.3, 0.45, 0.6, 0.8];
  let best = null;

  for (const alpha of grid) {
    for (const beta of [0.01, 0.05, 0.15, 0.3]) {
      for (const gamma of [0.05, 0.2, 0.4, 0.6]) {
        let state;
        try {
          state = holtWinters(series, alpha, beta, gamma);
        } catch (e) {
          continue;
        }
        const sse = state.residuals.reduce((a, r) => a + r * r, 0);
        if (!Number.isFinite(sse)) continue;
        if (!best || sse < best.sse) best = { sse, alpha, beta, gamma, state };
      }
    }
  }

  if (!best) throw new RangeError('Could not fit a forecast to this series');

  const sigma = Stats.std(best.state.residuals);
  const z = Stats.normalQuantile(1 - (1 - confidence) / 2);
  const point = project(best.state, horizon);
  const mult = varianceMultipliers(horizon, best.alpha, best.beta, best.gamma);

  const lower = point.map((v, i) => Math.max(0, v - z * sigma * mult[i]));
  const upper = point.map((v, i) => v + z * sigma * mult[i]);

  // Interval on the CUMULATIVE total over the horizon. Successive h-step
  // errors share the same shocks, so treating them as independent understates
  // the true variance; this is a documented approximation, not an identity.
  const cumVar = mult.reduce((a, mh) => a + (sigma * mh) ** 2, 0);
  const cumSigma = Math.sqrt(cumVar);
  const cumPoint = point.reduce((a, b) => a + b, 0);

  return {
    point,
    lower,
    upper,
    sigma,
    mult,
    cumulative: {
      point: cumPoint,
      lower: Math.max(0, cumPoint - z * cumSigma),
      upper: cumPoint + z * cumSigma,
      sigma: cumSigma,
    },
    confidence,
    params: { alpha: best.alpha, beta: best.beta, gamma: best.gamma },
    fitted: best.state.fitted,
    /** Daily demand mean and sd, used downstream by the inventory policy. */
    dailyMean: Stats.mean(point),
    dailySigma: sigma,
  };
}

/* ================================================================== */
/* 2. Backtesting — rolling origin evaluation                          */
/* ================================================================== */

/** Mean absolute percentage error, skipping zero actuals (undefined there). */
function mape(actual, predicted) {
  const terms = [];
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) continue;
    terms.push(Math.abs((actual[i] - predicted[i]) / actual[i]));
  }
  return terms.length ? (Stats.mean(terms) * 100) : NaN;
}

function mae(actual, predicted) {
  return Stats.mean(actual.map((a, i) => Math.abs(a - predicted[i])));
}

function rmse(actual, predicted) {
  return Math.sqrt(Stats.mean(actual.map((a, i) => (a - predicted[i]) ** 2)));
}

/** Mean error — positive means the model under-forecasts. */
function bias(actual, predicted) {
  return Stats.mean(actual.map((a, i) => a - predicted[i]));
}

/**
 * Rolling-origin backtest. The series is cut at successively later origins;
 * at each cut the model is refitted on history only and asked for the next
 * `horizon` days, which are then compared with the held-out actuals.
 *
 * Two baselines are evaluated on identical folds:
 *   - naive:          yhat = last observed value
 *   - seasonal naive: yhat = value from the same weekday last week
 *
 * Skill score = 1 - MAE_model / MAE_seasonalNaive. Positive means the model
 * beats the baseline a practitioner would otherwise use.
 */
function backtest(series, horizon = 7, folds = 6) {
  const results = { model: [], naive: [], seasonalNaive: [] };
  const minTrain = 2 * SEASON + 21;
  const step = Math.max(1, Math.floor((series.length - minTrain - horizon) / folds));

  let origin = series.length - horizon - (folds - 1) * step;
  if (origin < minTrain) origin = minTrain;

  const folded = [];
  for (let f = 0; f < folds; f++) {
    const cut = origin + f * step;
    if (cut + horizon > series.length) break;

    const train = series.slice(0, cut);
    const actual = series.slice(cut, cut + horizon);

    let fc;
    try {
      fc = forecast(train, horizon);
    } catch (e) {
      continue;
    }

    const naivePred = new Array(horizon).fill(train[train.length - 1]);
    const snaivePred = [];
    for (let h = 0; h < horizon; h++) {
      snaivePred.push(train[train.length - SEASON + (h % SEASON)]);
    }

    results.model.push({ actual, predicted: fc.point });
    results.naive.push({ actual, predicted: naivePred });
    results.seasonalNaive.push({ actual, predicted: snaivePred });
    folded.push({ cut, actual, predicted: fc.point });
  }

  const flatten = (rows) => ({
    actual: rows.flatMap((r) => r.actual),
    predicted: rows.flatMap((r) => r.predicted),
  });

  const score = (rows) => {
    const { actual, predicted } = flatten(rows);
    if (!actual.length) return { mape: NaN, mae: NaN, rmse: NaN, bias: NaN };
    return {
      mape: mape(actual, predicted),
      mae: mae(actual, predicted),
      rmse: rmse(actual, predicted),
      bias: bias(actual, predicted),
    };
  };

  const model = score(results.model);
  const naive = score(results.naive);
  const seasonalNaive = score(results.seasonalNaive);
  const skill = Number.isFinite(seasonalNaive.mae) && seasonalNaive.mae > 0
    ? 1 - model.mae / seasonalNaive.mae
    : NaN;

  return { model, naive, seasonalNaive, skill, folds: folded.length, horizon };
}

/* ================================================================== */
/* 3. Inventory policy — safety stock, ROP, EOQ, stockout probability  */
/* ================================================================== */

/**
 * Classic (Q, R) continuous-review policy under uncertainty in BOTH demand
 * and lead time:
 *
 *   sigma_DL = sqrt( LT * sigma_d^2  +  d_bar^2 * sigma_LT^2 )
 *   SS       = z * sigma_DL
 *   ROP      = d_bar * LT + SS
 *   EOQ      = sqrt( 2 * D * S / H )
 *
 * Stockout probability before the next delivery is P(demand over lead time >
 * current stock), evaluated against the same normal approximation.
 */
function inventoryPolicy(item, fc, opts = {}) {
  const serviceLevel = opts.serviceLevel ?? 0.95;
  const orderCost = opts.orderCost ?? 45;          // S: cost to place an order
  const holdingRate = opts.holdingRate ?? 0.22;    // annual % of unit cost

  const dBar = fc.dailyMean;
  const sigmaD = fc.dailySigma;
  const LT = item.leadTimeDays;
  const sigmaLT = item.leadTimeSigma;

  const sigmaDL = Math.sqrt(LT * sigmaD ** 2 + dBar ** 2 * sigmaLT ** 2);
  const z = Stats.normalQuantile(serviceLevel);
  const safetyStock = Math.max(0, z * sigmaDL);
  const leadTimeDemand = dBar * LT;
  const reorderPoint = leadTimeDemand + safetyStock;

  const annualDemand = dBar * 365;
  const holdingCost = item.unitCost * holdingRate;
  const eoq = holdingCost > 0 ? Math.sqrt((2 * annualDemand * orderCost) / holdingCost) : 0;
  const orderQty = Math.max(item.moq, Math.round(eoq / item.moq) * item.moq || item.moq);

  // P(stockout before replenishment arrives)
  const stockoutProb = sigmaDL > 0
    ? 1 - Stats.normalCdf((item.quantity - leadTimeDemand) / sigmaDL)
    : (item.quantity < leadTimeDemand ? 1 : 0);

  const daysOfCover = dBar > 0 ? item.quantity / dBar : Infinity;

  // Expected units short per cycle, via the normal loss function
  // E[shortage] = sigma_DL * (phi(z) - z*(1-Phi(z)))
  const phi = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const zCur = sigmaDL > 0 ? (item.quantity - leadTimeDemand) / sigmaDL : 0;
  const expectedShortage = sigmaDL > 0
    ? Math.max(0, sigmaDL * (phi(zCur) - zCur * (1 - Stats.normalCdf(zCur))))
    : 0;

  return {
    dBar,
    sigmaD,
    sigmaDL,
    z,
    safetyStock,
    leadTimeDemand,
    reorderPoint,
    eoq,
    orderQty,
    stockoutProb,
    daysOfCover,
    expectedShortage,
    shouldReorder: item.quantity <= reorderPoint,
    serviceLevel,
    annualHoldingCost: (safetyStock + orderQty / 2) * holdingCost,
  };
}

/* ================================================================== */
/* 4. Expiry risk — expected spoilage for perishables                  */
/* ================================================================== */

/**
 * For a perishable batch with D days until expiry, forecast cumulative demand
 * over those D days. Anything left over spoils. Because cumulative demand is
 * itself uncertain, expected spoilage is computed against the normal
 * distribution of cumulative demand rather than the point forecast alone:
 *
 *   E[spoil] = integral over demand < stock of (stock - demand)
 *            = sigma_C * ( phi(k) - k*(1-Phi(k)) ) + (stock - mu_C) ... via
 *   the standard normal loss identity, evaluated at k = (stock - mu_C)/sigma_C.
 */
function expiryRisk(item, fc) {
  if (!item.perishable) return null;

  const days = Math.max(0, item.daysToExpiry());
  if (days === 0) {
    return {
      days: 0, expectedSpoilUnits: item.quantity, writeOffValue: item.quantity * item.unitCost,
      spoilProbability: 1, cumulativeDemand: 0, clearanceAdvised: true,
    };
  }

  // Cumulative demand over the remaining shelf life.
  const horizonFc = forecast(item.history, Math.min(days, 60));
  const used = horizonFc.point.slice(0, days);
  const muC = used.reduce((a, b) => a + b, 0);
  const sigmaC = fc.dailySigma * Math.sqrt(days);

  const phi = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const k = sigmaC > 0 ? (item.quantity - muC) / sigmaC : (item.quantity > muC ? 9 : -9);

  // E[max(0, stock - demand)] = sigma*phi(k) + (stock-mu)*Phi(k)
  const expectedSpoilUnits = sigmaC > 0
    ? Math.max(0, sigmaC * phi(k) + (item.quantity - muC) * Stats.normalCdf(k))
    : Math.max(0, item.quantity - muC);

  const spoilProbability = Stats.normalCdf(k); // P(demand < stock)

  return {
    days,
    cumulativeDemand: muC,
    sigmaC,
    expectedSpoilUnits,
    writeOffValue: expectedSpoilUnits * item.unitCost,
    spoilProbability,
    clearanceAdvised: expectedSpoilUnits > 0.1 * item.quantity && expectedSpoilUnits >= 1,
    /** Discount needed to clear the surplus, capped at the gross margin. */
    suggestedDiscount: (() => {
      if (expectedSpoilUnits < 1) return 0;
      const surplusShare = expectedSpoilUnits / Math.max(1, item.quantity);
      const maxDiscount = item.marginPerUnit / item.price;
      return Math.min(maxDiscount, surplusShare) * 100;
    })(),
  };
}

/* ================================================================== */
/* 5. Anomaly detection — robust z-scores on deseasonalised residuals  */
/* ================================================================== */

/**
 * A plain z-score on raw sales flags every Saturday as an anomaly, because
 * weekends genuinely sell more. So the series is first decomposed into trend
 * and weekly seasonality, and only the residual is scored — with a MAD-based
 * robust z, since the median and MAD are not dragged around by the very
 * outliers being searched for.
 *
 * The trend is a running MEDIAN over two full seasons, not a moving average.
 * That detail matters more than it looks: a *run* of outliers — a four-day
 * supply outage, say — drags a moving average down to meet it, so the
 * residual goes small and the outage hides itself. This is outlier masking,
 * and it is exactly the event an inventory system most needs to catch. A
 * median over a 15-day window is unmoved by four bad days, so the outage
 * stands out at full size.
 *
 * The window is 2m+1 so it holds each weekday position twice; the seasonal
 * step then removes whatever phase-dependent offset the median introduces.
 */
function detectAnomalies(series, threshold = 3.0) {
  const n = series.length;
  const half = SEASON; // window = 2*SEASON + 1 = 15 days

  // Trend: centred running median (robust to runs of outliers).
  const trend = new Array(n).fill(null);
  for (let t = half; t < n - half; t++) {
    trend[t] = Stats.median(series.slice(t - half, t + half + 1));
  }

  // Seasonal: average detrended value by day-of-week position, centred.
  const byPos = Array.from({ length: SEASON }, () => []);
  for (let t = half; t < n - half; t++) byPos[t % SEASON].push(series[t] - trend[t]);
  const seasonal = byPos.map((xs) => (xs.length ? Stats.mean(xs) : 0));
  const seasonalMean = Stats.mean(seasonal);
  const seasonalCentred = seasonal.map((s) => s - seasonalMean);

  // Residual = observed - trend - seasonal
  const residuals = [];
  const index = [];
  for (let t = half; t < n - half; t++) {
    residuals.push(series[t] - trend[t] - seasonalCentred[t % SEASON]);
    index.push(t);
  }

  const med = Stats.median(residuals);
  const scale = Stats.mad(residuals) || Stats.std(residuals) || 1;

  const anomalies = [];
  residuals.forEach((r, i) => {
    const z = (r - med) / scale;
    if (Math.abs(z) >= threshold) {
      anomalies.push({
        day: index[i],
        value: series[index[i]],
        expected: trend[index[i]] + seasonalCentred[index[i] % SEASON],
        z,
        direction: z > 0 ? 'spike' : 'drop',
      });
    }
  });

  return { anomalies, residualScale: scale, checked: residuals.length, threshold };
}

/* ================================================================== */
/* 6. ABC classification — Pareto by annual gross margin               */
/* ================================================================== */

/**
 * Ranks SKUs by annualised gross margin and cuts the cumulative curve at
 * 80% (A) and 95% (B). A-items justify tight service levels and frequent
 * review; C-items do not.
 */
function classifyABC(items) {
  const scored = items.map((item) => ({
    item,
    annualMargin: (item.unitsSold(90) / 90) * 365 * item.marginPerUnit,
  }));
  scored.sort((a, b) => b.annualMargin - a.annualMargin);

  const total = scored.reduce((a, s) => a + s.annualMargin, 0) || 1;
  let cum = 0;
  return scored.map((s) => {
    cum += s.annualMargin;
    const share = cum / total;
    const cls = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
    return { ...s, cumulativeShare: share, abc: cls };
  });
}

/* ================================================================== */
/* Orchestration — one analysis object per SKU                         */
/* ================================================================== */

/**
 * Runs the full pipeline for one item and returns its analysis record.
 *
 * `abcEntry` comes from classifyABC() over the whole catalogue, because ABC
 * class and annual-margin share are relative measures — an item cannot be
 * classified in isolation.
 *
 * Split out from analyseInventory() so a caller that needs a single SKU does
 * not have to analyse the entire catalogue: the Cloudflare Worker analyses one
 * item per request to stay inside its CPU budget, and shares this exact code
 * path with the browser so the two cannot drift apart.
 */
function analyseItem(item, abcEntry, opts = {}) {
  const fc = forecast(item.history, opts.horizon ?? 14);
  const bt = backtest(item.history, 7, 6);
  const policy = inventoryPolicy(item, fc, opts);
  const expiry = expiryRisk(item, fc);
  const anomalies = detectAnomalies(item.history);

  // Composite risk score in [0,100]: blends stockout probability, expiry
  // write-off exposure and forecast uncertainty, weighted by ABC class.
  const classWeight = { A: 1.0, B: 0.75, C: 0.5 }[abcEntry.abc];
  const expiryExposure = expiry
    ? Math.min(1, expiry.writeOffValue / Math.max(1, item.stockValue))
    : 0;
  const cv = fc.dailyMean > 0 ? Math.min(1, fc.dailySigma / fc.dailyMean) : 0;
  const riskScore = Math.round(
    100 * classWeight * (0.55 * policy.stockoutProb + 0.3 * expiryExposure + 0.15 * cv)
  );

  return {
    item,
    forecast: fc,
    backtest: bt,
    policy,
    expiry,
    anomalies,
    abc: abcEntry.abc,
    annualMargin: abcEntry.annualMargin,
    cumulativeShare: abcEntry.cumulativeShare,
    riskScore,
  };
}

/**
 * Runs the whole pipeline over the catalogue and returns a single analysis
 * record per item. This is what the UI renders.
 */
function analyseInventory(items, opts = {}) {
  const abc = classifyABC(items);
  const abcBySku = new Map(abc.map((a) => [a.item.sku, a]));

  const analyses = items.map((item) => analyseItem(item, abcBySku.get(item.sku), opts));

  analyses.sort((a, b) => b.riskScore - a.riskScore);
  return analyses;
}

/* ================================================================== */
/* NLU — intent classification for the assistant                       */
/* ================================================================== */

/**
 * A small rule-and-score intent classifier. Each intent carries weighted
 * keyword patterns; the utterance is scored against all of them and the
 * highest-scoring intent wins, provided it clears a confidence floor.
 * Entities (SKU / item name / number) are extracted by fuzzy matching
 * against the live catalogue.
 */
const INTENTS = [
  { name: 'reorder',    patterns: [['reorder', 3], ['order', 2], ['restock', 3], ['purchase order', 3], ['buy more', 2], ['replenish', 3], ['what should i order', 4]] },
  { name: 'stockout',   patterns: [['stockout', 3], ['run out', 3], ['out of stock', 3], ['risk', 2], ['shortage', 3], ['short', 1]] },
  { name: 'forecast',   patterns: [['forecast', 3], ['predict', 3], ['demand', 2], ['next week', 2], ['expect', 2], ['how many will', 3], ['projection', 3]] },
  { name: 'expiry',     patterns: [['expire', 3], ['expiry', 3], ['expiring', 3], ['spoil', 3], ['waste', 2], ['write off', 3], ['perishable', 2], ['fresh', 1]] },
  { name: 'lowstock',   patterns: [['low stock', 4], ['low on', 2], ['below threshold', 3], ['running low', 3]] },
  { name: 'value',      patterns: [['revenue', 3], ['sales', 2], ['profit', 3], ['margin', 3], ['stock value', 3], ['worth', 2], ['inventory value', 4]] },
  { name: 'anomaly',    patterns: [['anomaly', 3], ['anomalies', 3], ['unusual', 3], ['strange', 2], ['outlier', 3], ['spike', 2], ['weird', 2]] },
  { name: 'abc',        patterns: [['abc', 3], ['pareto', 3], ['classification', 2], ['top items', 3], ['most important', 3], ['best seller', 3]] },
  { name: 'accuracy',   patterns: [['accuracy', 3], ['mape', 4], ['how accurate', 4], ['backtest', 4], ['error', 2], ['reliable', 2]] },
  { name: 'itemDetail', patterns: [['tell me about', 3], ['details', 2], ['status of', 3], ['how is', 2], ['show me', 2]] },
  { name: 'help',       patterns: [['help', 3], ['what can you', 4], ['how do i', 2], ['commands', 3]] },
];

function classifyIntent(utterance) {
  const text = utterance.toLowerCase();
  const scores = INTENTS.map((intent) => {
    let score = 0;
    for (const [pattern, weight] of intent.patterns) {
      if (text.includes(pattern)) score += weight;
    }
    return { intent: intent.name, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const runnerUp = scores[1];
  const confidence = top.score === 0 ? 0 : top.score / (top.score + (runnerUp?.score ?? 0) + 1);
  return { intent: top.score > 0 ? top.intent : 'unknown', score: top.score, confidence, ranked: scores.slice(0, 3) };
}

/** Levenshtein-free fuzzy match: token overlap against item names and SKUs. */
function extractItem(utterance, items) {
  const text = utterance.toLowerCase();
  let best = null;
  for (const item of items) {
    if (text.includes(item.sku.toLowerCase())) return { item, score: 100 };
    const tokens = item.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    let hits = 0;
    for (const tk of tokens) if (text.includes(tk)) hits += 1;
    const score = tokens.length ? hits / tokens.length : 0;
    if (score > 0.4 && (!best || score > best.score)) best = { item, score };
  }
  return best;
}

/* ================================================================== */
/* Exports                                                             */
/* ================================================================== */

const AIEngine = {
  Stats,
  SEASON,
  holtWinters,
  project,
  varianceMultipliers,
  forecast,
  backtest,
  mape,
  mae,
  rmse,
  bias,
  inventoryPolicy,
  expiryRisk,
  detectAnomalies,
  classifyABC,
  analyseItem,
  analyseInventory,
  classifyIntent,
  extractItem,
  INTENTS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = AIEngine;
if (typeof window !== 'undefined') Object.assign(window, AIEngine, { AIEngine });
