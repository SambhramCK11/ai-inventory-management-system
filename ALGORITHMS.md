# Algorithms

Every model in this system is implemented from first principles, in both
JavaScript (`web/assets/js/ai-engine.js`) and Java
(`backend/src/com/inventory/ai/`). This document is the reference for what each
one computes and why that form was chosen over the obvious alternative.

---

## 1. Demand forecasting — Holt-Winters, ETS(A,A,A)

### The model

Additive trend, additive weekly seasonality, period `m = 7`:

```
level_t  = α(y_t − s_{t−m}) + (1−α)(level_{t−1} + trend_{t−1})
trend_t  = β(level_t − level_{t−1}) + (1−β)·trend_{t−1}
s_t      = γ(y_t − level_t) + (1−γ)·s_{t−m}
ŷ_{t+h}  = level_t + h·trend_t + s_{t+h−m}
```

### Initialisation

Seasonal indices start as the average of each weekday position over the first
two seasons, centred to sum to zero. Level starts at the first season's mean;
trend at `(mean of season 2 − mean of season 1) / m`.

Poor initialisation shows up as a transient in the first two or three seasons.
That is why in-sample residuals are collected only from `t ≥ m` — scoring the
warm-up period would flatter the model.

### Why additive, not multiplicative

Multiplicative seasonality is usually the better fit for retail demand, since
weekend lift tends to scale with volume. It is not used here because several
SKUs have zero-demand days, and a multiplicative seasonal factor is undefined
when the level is zero. Choosing the form that is defined everywhere in the
data beats choosing the form that fits slightly better where it is defined.

### Parameter selection

`(α, β, γ)` are grid-searched per SKU over 6 × 4 × 4 = 96 combinations,
minimising in-sample sum of squared error.

A grid rather than gradient descent because the surface is cheap to evaluate
(a few hundred passes over a 200-point series), bounded on `[0,1]³`, and not
guaranteed convex — a local method can get stuck where an exhaustive grid
cannot. Grid resolution is the real trade here, and it is coarse by design:
finer spacing buys fractions of a percent of in-sample fit and costs
generalisation.

---

## 2. Prediction intervals

### The formula used

For ETS(A,A,A), the h-step-ahead forecast error variance is

```
Var(h) = σ²·[ 1 + Σ_{j=1}^{h−1} c_j² ]
c_j    = α(1 + jβ) + γ(1−α)·1{ j mod m = 0 }
```

(Hyndman, Koehler, Ord & Snyder, *Forecasting with Exponential Smoothing*,
ch. 6.) `σ` is the standard deviation of in-sample residuals, and the interval
is `ŷ_{t+h} ± z·σ·√(Var(h)/σ²)`, floored at zero.

### Why not √h

The intuitive approach — widen the band by `√h`, since the variance of a sum of
`h` independent errors is `h·σ²` — is wrong for a smoothing model. It describes
a random walk, where errors accumulate permanently. Holt-Winters corrects
toward the level at every step, so its errors do not accumulate that way.

The practical difference is large. At `h = 14` with typical fitted constants,
the ETS multiplier is around 1.9 while `√14 ≈ 3.74` — the naive band is roughly
twice as wide as the model warrants. An interval that wide is not conservative,
it is useless: it tells a planner nothing they can act on.

`EngineTest.testVarianceMultipliers()` asserts the multiplier stays strictly
below `√h`, and that `α = 0` leaves the variance flat (a model that ignores new
information carries the one-step variance at every horizon).

### Cumulative intervals

For the total over a horizon, per-step variances are summed. Successive h-step
errors share underlying shocks, so treating them as independent understates the
true variance. This is documented as an approximation in the code rather than
presented as an identity.

### Aggregating across SKUs

The dashboard's all-SKU chart does **not** sum each SKU's interval. Doing so
would assume every SKU errs in the same direction on the same day. Demand
shocks are largely SKU-specific, so variances are pooled:

```
σ_aggregate = √( Σ σ_i² )
```

which is why the aggregate band is proportionally much tighter than any single
item's — the standard risk-pooling result, and the reason centralised
warehouses need less safety stock than the sum of their branches.

---

## 3. Backtesting

### Protocol

Rolling origin, 6 folds, 7-day horizon. At each cut point the model is refitted
on history *only* — no information from after the cut reaches the fit — and
asked for the next seven days, compared against held-out actuals.

A single train/test split would give one noisy number. Rolling origin uses the
series as it would actually be used in production: refit, forecast, observe,
repeat.

### Baselines

Two, on identical folds:

- **Naive**: `ŷ = ` last observed value
- **Seasonal naive**: `ŷ = ` same weekday last week

### Metrics

| Metric | Definition | Note |
|---|---|---|
| MAPE | `mean(\|actual − pred\| / actual)` | zero actuals excluded — the ratio is undefined there |
| MAE | `mean(\|actual − pred\|)` | in units; robust to outliers |
| RMSE | `√mean((actual − pred)²)` | penalises large misses |
| Bias | `mean(actual − pred)` | positive = under-forecasting |
| Skill | `1 − MAE_model / MAE_seasonal-naive` | the honest headline |

Bias deserves its own line because direction matters asymmetrically in
inventory: under-forecasting causes stockouts, which lose the margin on the sale
and sometimes the customer; over-forecasting causes holding cost and, for
perishables, write-off. The two are not equally expensive, and a model with low
MAE but persistent negative bias is worse than its MAE suggests.

Skill is reported because absolute accuracy is not decision-relevant on its own.
A model with 15% MAPE on a series with a strong weekly cycle may be doing
nothing a seasonal-naive forecast doesn't already do.

---

## 4. Replenishment — continuous-review (Q, R)

```
σ_DL = √( LT·σ_d²  +  d̄²·σ_LT² )
SS   = z·σ_DL
ROP  = d̄·LT + SS
EOQ  = √( 2·D·S / H )
```

where `LT` is mean lead time, `σ_LT` its standard deviation, `d̄` and `σ_d` mean
and standard deviation of daily demand, `z = Φ⁻¹(service level)`, `D` annual
demand, `S` order cost, `H` annual holding cost per unit.

### The second term

Most treatments give `SS = z·σ_d·√LT`, which assumes the supplier is perfectly
reliable. Real suppliers are not, and the omitted term `d̄²·σ_LT²` is frequently
the *larger* of the two — for a fast-moving item with a variable supplier it
dominates completely.

This is the single most common reason a stated 95% service level delivers
around 80% in practice. `EngineTest.testPolicyMonotonicity()` asserts that
computed safety stock strictly exceeds the demand-only figure, which fails
immediately if the lead-time term is ever dropped.

### Stockout probability

```
P(stockout) = 1 − Φ( (Q_onhand − d̄·LT) / σ_DL )
```

and expected units short per cycle uses the normal loss function:

```
E[shortage] = σ_DL·( φ(k) − k·(1−Φ(k)) ),   k = (Q_onhand − d̄·LT)/σ_DL
```

### Order quantity

EOQ rounded to the nearest multiple of the supplier's minimum order quantity,
floored at one MOQ. EOQ's assumptions (constant demand, instant replenishment,
no quantity discounts) are all violated here; it is used as a sensible starting
magnitude, not a claim of optimality.

---

## 5. Expiry and waste

For a batch of `Q` units with `D` days of shelf life remaining, let `μ_C` be
forecast cumulative demand over those `D` days and `σ_C = σ·√D`. Expected
leftover is the expectation of the positive part:

```
E[max(0, Q − demand)] = σ_C·φ(k) + (Q − μ_C)·Φ(k),   k = (Q − μ_C)/σ_C
```

Write-off value is that figure times unit cost.

### Why not just compare

Comparing `Q` against the point forecast `μ_C` gives zero expected spoilage
whenever `Q < μ_C`, which is wrong: demand is uncertain, so there is always
*some* probability of a shortfall, and near the boundary it is substantial. The
integral captures that; the comparison discards it.

### Suggested markdown

Capped at the item's gross margin percentage. A markdown deeper than the margin
turns a write-off into a realised loss, which is worse than the write-off it
was meant to avoid. `EngineTest.testExpiryRisk()` asserts the cap holds.

---

## 6. Anomaly detection

### Procedure

1. **Trend** — centred running *median* over `2m+1 = 15` days.
2. **Seasonal** — mean detrended value per weekday position, centred to sum to
   zero.
3. **Residual** — `observed − trend − seasonal`.
4. **Score** — robust z: `(r − median(r)) / MAD(r)`, with
   `MAD = 1.4826·median(|r − median(r)|)`.
5. **Flag** `|z| ≥ 3`.

### Three decisions, each with a reason

**Deseasonalise first.** Scoring raw sales flags every weekend, because
weekends genuinely sell more. `EngineTest.testAnomalyDetection()` asserts that a
pure weekly cycle produces *zero* anomalies — the test that fails the moment
anyone scores raw values.

**Median, not mean, for the trend.** This one was found by a failing test. A
*run* of outliers — the planted four-day supply outage — drags a moving average
down to meet it, so the residual goes small and the outage hides itself. That
is outlier masking, and it is exactly the event an inventory system most needs
to catch, since a run of zero-sales days usually means the item was
*unavailable*, not unwanted. A median over 15 days is unmoved by four bad ones.

**MAD, not standard deviation, for the scale.** The standard deviation is
inflated by the outliers being searched for, so a large anomaly raises the bar
it must clear. The MAD does not have that feedback loop.

---

## 7. ABC classification

SKUs ranked by annualised gross margin, cumulative curve cut at 80% (A) and
95% (B).

**Margin, not revenue.** A high-turnover item sold at near cost generates
impressive revenue and very little reason to protect it with a high service
level. Ranking by revenue systematically over-invests in exactly those items.

The classification feeds the composite risk score, where class weights
(A = 1.0, B = 0.75, C = 0.5) scale the blend of stockout probability, expiry
exposure and forecast uncertainty. A 60% stockout probability on a class-C item
is genuinely less urgent than 40% on a class-A item, and a ranking that ignores
that sends buyers to the wrong SKU first.

---

## 8. Intent classification

Ten intents, each with weighted keyword patterns. The utterance is scored
against all of them; the highest score wins if it clears zero. Confidence is
`top / (top + runner_up + 1)`, so a clear winner scores high and two close
candidates score low. Entities are resolved by exact SKU match first, then token
overlap against item names above a 0.4 threshold.

Answers are generated from the analysis objects, never from free text. The
consequence is the point: the assistant cannot state a number the dashboard does
not also show. For an operations tool that property is worth more than fluency —
a confidently wrong stock figure is more expensive than "I didn't understand
that."

Every reply carries its classified intent and confidence in the UI, so a user
can see *why* they got the answer they got.

---

## Numerical utilities

**`normalCdf`** — Abramowitz & Stegun 7.1.26 erf approximation, max absolute
error ≈ 1.5 × 10⁻⁷.

**`normalQuantile`** — Acklam's rational approximation.

These two must be mutual inverses, or safety stock and stockout probability
would quietly disagree with each other. `EngineTest.testStats()` round-trips
`Φ(Φ⁻¹(p)) = p` at four service levels to 10⁻⁶.

**`mulberry32`** — seeded PRNG, reproduced exactly in Java. JavaScript's
`Math.imul` is a 32-bit signed multiply, which is plain `int` multiplication in
Java, and `>>>` is a logical shift in both languages, so the integer streams
match without coercion tricks. That identity is what makes the cross-language
parity test meaningful: the two engines see byte-identical inputs, so any
disagreement in output is a real algorithmic difference.
