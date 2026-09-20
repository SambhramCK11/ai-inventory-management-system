# AI Inventory Management System

A Java inventory management system extended with a demand-forecasting and
replenishment-decision engine, plus a browser front end that runs the same
engine client-side.

The original project (a university OOP assignment, `docs/original-assignment.md`)
was a Swing application: add items, view items, check low stock, check expired
items, view revenue. It worked, and every decision in it was a fixed threshold —
*"fewer than 5 units left"*, *"expiry date has passed"*. This version keeps the
class hierarchy and replaces the thresholds with models:

| Original | This version |
|---|---|
| "Fewer than 5 units" | Stockout probability over the supplier's lead time, given demand **and** lead-time variance |
| "Expiry date has passed" | Expected spoilage in units and dollars, integrated over forecast demand across the remaining shelf life |
| Total revenue | ABC segmentation by annualised gross margin, driving per-class service levels |
| — | Holt-Winters demand forecasting with prediction intervals, backtested against two baselines |
| — | Robust anomaly detection on deseasonalised residuals |
| — | Natural-language query layer over the analysis |

Everything is computed at runtime from 200 days of demand history. There are no
stored results, no pre-baked numbers, and no calls to a hosted model.

---

## Running it

**Front end** — no build step, no server, no network:

```
open web/index.html
```

Sign in with `admin` / `admin123`, or continue as a customer.

**Backend** — needs only a JDK (17+; developed on 21):

```
cd backend
javac -d out $(find src test -name '*.java')

java -cp out com.inventory.Main            # analysis report to stdout
java -cp out com.inventory.Main --serve    # JSON API on http://localhost:8080
java -cp out com.inventory.EngineTest      # 82 tests
```

There is no Maven or Gradle build and no dependency to download — deliberately.
A reviewer can clone this and have it running in under a minute on a machine
with no network access, and the test suite proves the engine works rather than
asserting that it does.

---

## Results

Measured by rolling-origin backtest: at six successive cut points the model is
refitted on history only and asked for the next seven days, which are then
compared against held-out actuals. Identical folds are scored for two baselines.

| Metric | Value |
|---|---|
| Mean MAPE across 18 SKUs | **20.8%** |
| Mean skill vs seasonal-naive | **+0.185** |
| SKUs beating the baseline | **17 / 18** |
| Mean bias | −0.47 units (slight over-forecast) |

Skill = `1 − MAE_model / MAE_seasonal-naive`. A forecast that cannot beat *"the
same as last Tuesday"* is not worth deploying, so the baseline comparison is
reported alongside the headline accuracy rather than instead of it.

**One SKU loses to the baseline** (Cold Brew Concentrate, skill −0.057) and it
is left in the table, flagged red. The pattern is consistent: the model is
weakest on promotion-driven series, because a smoothing model has no promotion
feature to lean on. That is a real limitation of the approach and the honest
place to put it is in the results, not in a footnote.

---

## Architecture

```
web/                          browser front end — opens from the file system
  index.html
  assets/js/
    data.js                   domain model + seeded demand generator
    ai-engine.js              forecasting, policy, expiry, anomalies, ABC, NLU
    charts.js                 hand-rolled SVG charts
    assistant.js              intent → answer, generated from analysis objects
    app.js                    state, routing, rendering

backend/                      dependency-free Java
  src/com/inventory/
    model/                    InventoryItem (abstract) → Perishable / NonPerishable
    exception/                InsufficientStockException, ItemNotFoundException
    ai/                       Stats, Forecaster, Analytics
    data/DataGenerator.java   the same seeded generator, bit-for-bit
    web/                      JDK HTTP server + hand-rolled JSON writer
    InventoryManager.java     service layer
  test/                       82 assertions, no JUnit

docs/ALGORITHMS.md            the maths, with derivations
```

### Why the engine exists twice

The forecasting and decision logic is implemented in both JavaScript and Java,
over the same seeded demand series. That is not duplication for its own sake —
it is the verification strategy. The two implementations must agree numerically,
and `EngineTest.testCrossLanguageParity()` asserts that they do, down to the
PRNG's individual draws.

It earned its keep twice during development:

1. **A timezone bug.** The JavaScript generator built expiry dates by setting
   local midnight and calling `toISOString()`, which converts to UTC — so every
   expiry date came out one day early for any viewer east of Greenwich. The
   Java side used `LocalDate.plusDays` and had no such flaw. The engines
   disagreed on total write-off ($2,655 vs $1,810) and the diff pointed
   straight at the cause. A single implementation would simply have been wrong,
   plausibly, forever.

2. **Outlier masking.** A test asserting that a planted four-day supply outage
   gets detected failed. The trend estimate was a moving average, which a *run*
   of outliers drags down to meet — so the outage hid itself. Switching the
   trend to a running median over two full seasons fixed it in both engines.

---

## The AI engineering

Full derivations are in [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md). In brief:

**Forecasting** — additive Holt-Winters (ETS(A,A,A)) with weekly seasonality.
Smoothing constants `(α, β, γ)` are grid-searched per SKU by minimising
in-sample SSE. Additive rather than multiplicative seasonality because several
SKUs have zero-demand days, where multiplicative factors are undefined.

**Prediction intervals** — from the ETS h-step error variance,
`Var(h) = σ²[1 + Σ c_j²]`, not the `√h` random-walk widening. A smoothing model
corrects toward the level at every step instead of drifting freely, so `√h`
overstates its uncertainty badly; at a 14-day horizon it produced a band roughly
twice as wide as the model actually warrants.

**Replenishment** — continuous-review (Q, R) policy with
`σ_DL = √(LT·σ_d² + d̄²·σ_LT²)`. Most textbook treatments drop the second term
under the root. That omission is the usual reason a 95% target service level
delivers about 80% in practice: supplier variability is frequently the larger of
the two contributions.

**Expiry** — expected spoilage via the normal loss function rather than a
binary flag. What a buyer needs is not *whether* stock will expire but *how
much* will be left, and cumulative demand over the remaining shelf life is
itself uncertain, so the leftover is integrated rather than subtracted.

**Anomalies** — robust MAD-based z-scores on residuals after trend and weekly
seasonality are removed. Scoring raw sales would flag every weekend, since
weekends genuinely sell more.

**ABC** — Pareto segmentation by annualised gross *margin*, not revenue. A
high-turnover item sold at close to cost does not deserve an A-item service
level.

**The assistant** is a keyword-weighted intent classifier over ten intents with
fuzzy entity matching, not an LLM call. It generates every answer from the same
analysis objects the dashboard renders, which gives it a property worth more
here than fluency: it is structurally incapable of stating a number the
dashboard does not also show. Each reply displays its classified intent and
confidence, so the routing decision is visible rather than hidden.

---

## Data

The catalogue is 18 SKUs across 6 categories with 200 days of daily demand,
generated from a seeded PRNG so every run produces identical numbers.

Each SKU's demand comes from a latent process — base rate, linear trend, weekly
seasonality, lognormal-ish noise, and optional promotional windows:

```
demand_t = max(0, round( (base + trend·t) · seasonal(t) · promo(t) · (1 + ε_t) ))
```

The engine never sees those parameters. It sees only the resulting series, so
recovering the signal is a genuine estimation problem rather than a lookup.
Planted in the data: three promotional windows and one four-day supply outage,
for the anomaly detector to find.

Opening stock is derived from *realised* demand rather than hard-coded, so each
SKU's intended scenario (critical / reorder / healthy / overstocked / spoiling)
survives any change to the demand parameters.

**This is synthetic data and the README says so on purpose.** The models are
real and the evaluation is honest, but no claim is made that these accuracy
figures would transfer to a live catalogue.

---

## Known limitations

- **Promotions aren't modelled as a feature.** The model sees a promotional
  spike as noise, which is where most of its remaining error lives. The fix is
  a regression-with-ARIMA-errors or a gradient-boosted model with a promo flag.
- **Normal approximations throughout.** Lead-time demand and cumulative demand
  are treated as normal. For slow-moving items with near-zero daily demand a
  Poisson or negative-binomial model is the correct choice; the normal
  approximation understates the probability of a zero-demand run.
- **No cross-SKU effects.** Cannibalisation and substitution are ignored, so
  each SKU is forecast independently.
- **Single-echelon.** One location, one stocking point. No transfers, no
  distribution network.
- **The assistant's NLU is a keyword classifier.** It is precise on the
  phrasings it covers and brittle outside them. That trade is deliberate for an
  operations tool, where a confidently wrong number is worse than "I didn't
  understand that", but it is not general language understanding.

---

## Original assignment

The source project is an Object-Oriented Programming assignment implementing an
Inventory Management System in Java with Swing. Concepts demonstrated:
inheritance, abstract classes, method overriding, encapsulation, user-defined
exceptions, ArrayList and GUI.

That class hierarchy is preserved here — `InventoryItem` is still abstract with
`PerishableItem` and `NonPerishableItem` overriding `getDetails()`, stock is
still private and mutable only through validating methods, and
`InsufficientStockException` is still a user-defined exception. What changed is
that `purchase()` now throws it instead of printing to stdout and returning a
boolean a caller can forget to check.


## GitHub

This repository contains the complete source for the AI Inventory Management System, including the browser front end, dependency-free Java backend, tests, algorithm documentation, and original assignment documentation.
