package com.inventory.ai;

/**
 * Additive Holt-Winters triple exponential smoothing, with grid-searched
 * smoothing constants, ETS prediction intervals and a rolling-origin
 * backtest.
 *
 * This is a line-for-line counterpart of the JavaScript engine in
 * {@code web/assets/js/ai-engine.js}. Both operate on the same seeded demand
 * series, so the two implementations can be diffed numerically — and are, in
 * {@code test/com/inventory/EngineTest.java}. Keeping a reference
 * implementation in a second language is a cheap and surprisingly effective
 * check on a numerical routine: a transcription error shows up as a
 * disagreement rather than as a plausible-looking wrong number.
 */
public final class Forecaster {

    public static final int SEASON = 7;

    private Forecaster() {}

    /* ---------------------------------------------------------------- */
    /* Fitted state                                                      */
    /* ---------------------------------------------------------------- */

    public static final class State {
        public final double level;
        public final double trend;
        public final double[] seasonals;
        public final Double[] fitted;
        public final double[] residuals;
        public final int m;
        public final int n;

        State(double level, double trend, double[] seasonals,
              Double[] fitted, double[] residuals, int m, int n) {
            this.level = level; this.trend = trend; this.seasonals = seasonals;
            this.fitted = fitted; this.residuals = residuals; this.m = m; this.n = n;
        }
    }

    public static final class Result {
        public final double[] point;
        public final double[] lower;
        public final double[] upper;
        public final double[] mult;
        public final double sigma;
        public final double alpha, beta, gamma;
        public final double dailyMean;
        public final double cumulativePoint, cumulativeLower, cumulativeUpper;

        Result(double[] point, double[] lower, double[] upper, double[] mult, double sigma,
               double alpha, double beta, double gamma,
               double cumulativePoint, double cumulativeLower, double cumulativeUpper) {
            this.point = point; this.lower = lower; this.upper = upper; this.mult = mult;
            this.sigma = sigma; this.alpha = alpha; this.beta = beta; this.gamma = gamma;
            this.dailyMean = Stats.mean(point);
            this.cumulativePoint = cumulativePoint;
            this.cumulativeLower = cumulativeLower;
            this.cumulativeUpper = cumulativeUpper;
        }
    }

    /* ---------------------------------------------------------------- */
    /* Fitting                                                           */
    /* ---------------------------------------------------------------- */

    /**
     * <pre>
     * level_t  = alpha*(y_t - s_{t-m}) + (1-alpha)*(level_{t-1} + trend_{t-1})
     * trend_t  = beta *(level_t - level_{t-1}) + (1-beta)*trend_{t-1}
     * s_t      = gamma*(y_t - level_t) + (1-gamma)*s_{t-m}
     * yhat_h   = level_t + h*trend_t + s_{t+h-m}
     * </pre>
     *
     * Additive rather than multiplicative seasonality: several SKUs have
     * zero-demand days, where multiplicative factors are undefined.
     */
    public static State holtWinters(int[] series, double alpha, double beta, double gamma, int m) {
        int n = series.length;
        if (n < 2 * m) throw new IllegalArgumentException("Need at least two full seasons of history");

        // Seasonal init: average of each period position over the first two
        // seasons, centred so the factors sum to zero.
        double[] season = new double[m];
        for (int i = 0; i < m; i++) season[i] = (series[i] + series[i + m]) / 2.0;
        double seasonMean = Stats.mean(season);
        for (int i = 0; i < m; i++) season[i] -= seasonMean;

        double firstSeason = 0, secondSeason = 0;
        for (int i = 0; i < m; i++) { firstSeason += series[i]; secondSeason += series[i + m]; }
        firstSeason /= m; secondSeason /= m;

        double level = firstSeason;
        double trend = (secondSeason - firstSeason) / m;

        double[] seasonals = season.clone();
        Double[] fitted = new Double[n];
        double[] residualBuf = new double[n];
        int residualCount = 0;

        for (int t = 0; t < n; t++) {
            double s = seasonals[t % m];
            double prediction = level + trend + s;
            if (t >= m) {
                fitted[t] = prediction;
                residualBuf[residualCount++] = series[t] - prediction;
            }
            double prevLevel = level;
            level = alpha * (series[t] - s) + (1 - alpha) * (level + trend);
            trend = beta * (level - prevLevel) + (1 - beta) * trend;
            seasonals[t % m] = gamma * (series[t] - level) + (1 - gamma) * s;
        }

        double[] residuals = java.util.Arrays.copyOf(residualBuf, residualCount);
        return new State(level, trend, seasonals, fitted, residuals, m, n);
    }

    /** Projects a fitted state h steps ahead, floored at zero. */
    public static double[] project(State state, int horizon) {
        double[] out = new double[horizon];
        for (int h = 1; h <= horizon; h++) {
            double s = state.seasonals[(state.n + h - 1) % state.m];
            out[h - 1] = Math.max(0, state.level + h * state.trend + s);
        }
        return out;
    }

    /**
     * h-step forecast error variance multipliers for ETS(A,A,A).
     *
     * Widening a band by sqrt(h) treats errors as accumulating like a random
     * walk, which badly overstates uncertainty for a smoothing model: the
     * model corrects toward the level at every step instead of drifting.
     * The correct variance (Hyndman et al., <i>Forecasting with Exponential
     * Smoothing</i>, ch. 6) is
     *
     * <pre>
     * Var(h) = sigma^2 * [ 1 + SUM_{j=1}^{h-1} c_j^2 ]
     * c_j    = alpha*(1 + j*beta) + gamma*(1-alpha)*1{ j mod m == 0 }
     * </pre>
     */
    public static double[] varianceMultipliers(int horizon, double alpha, double beta, double gamma, int m) {
        double[] out = new double[horizon];
        double acc = 0;
        for (int h = 1; h <= horizon; h++) {
            if (h > 1) {
                int j = h - 1;
                double c = alpha * (1 + j * beta) + (j % m == 0 ? gamma * (1 - alpha) : 0);
                acc += c * c;
            }
            out[h - 1] = Math.sqrt(1 + acc);
        }
        return out;
    }

    private static final double[] ALPHA_GRID = {0.05, 0.15, 0.3, 0.45, 0.6, 0.8};
    private static final double[] BETA_GRID  = {0.01, 0.05, 0.15, 0.3};
    private static final double[] GAMMA_GRID = {0.05, 0.2, 0.4, 0.6};

    /**
     * Grid-searches the smoothing constants by minimising in-sample SSE, then
     * forecasts with prediction intervals.
     *
     * A grid search rather than gradient descent because the surface is cheap
     * to evaluate (a few hundred passes over a 200-point series), bounded, and
     * not guaranteed convex — the grid cannot get stuck where a local method
     * would.
     */
    public static Result forecast(int[] series, int horizon, double confidence) {
        State best = null;
        double bestSse = Double.POSITIVE_INFINITY;
        double bA = 0, bB = 0, bG = 0;

        for (double alpha : ALPHA_GRID) {
            for (double beta : BETA_GRID) {
                for (double gamma : GAMMA_GRID) {
                    State st;
                    try {
                        st = holtWinters(series, alpha, beta, gamma, SEASON);
                    } catch (IllegalArgumentException e) {
                        continue;
                    }
                    double sse = 0;
                    for (double r : st.residuals) sse += r * r;
                    if (!Double.isFinite(sse)) continue;
                    if (sse < bestSse) { bestSse = sse; best = st; bA = alpha; bB = beta; bG = gamma; }
                }
            }
        }
        if (best == null) throw new IllegalArgumentException("Could not fit a forecast to this series");

        double sigma = Stats.std(best.residuals);
        double z = Stats.normalQuantile(1 - (1 - confidence) / 2);
        double[] point = project(best, horizon);
        double[] mult = varianceMultipliers(horizon, bA, bB, bG, SEASON);

        double[] lower = new double[horizon];
        double[] upper = new double[horizon];
        double cumVar = 0, cumPoint = 0;
        for (int i = 0; i < horizon; i++) {
            lower[i] = Math.max(0, point[i] - z * sigma * mult[i]);
            upper[i] = point[i] + z * sigma * mult[i];
            cumVar += Math.pow(sigma * mult[i], 2);
            cumPoint += point[i];
        }
        double cumSigma = Math.sqrt(cumVar);

        return new Result(point, lower, upper, mult, sigma, bA, bB, bG,
                cumPoint, Math.max(0, cumPoint - z * cumSigma), cumPoint + z * cumSigma);
    }

    public static Result forecast(int[] series, int horizon) {
        return forecast(series, horizon, 0.95);
    }

    /* ---------------------------------------------------------------- */
    /* Error metrics                                                     */
    /* ---------------------------------------------------------------- */

    /** MAPE, skipping zero actuals where the percentage error is undefined. */
    public static double mape(double[] actual, double[] predicted) {
        double sum = 0;
        int count = 0;
        for (int i = 0; i < actual.length; i++) {
            if (actual[i] == 0) continue;
            sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
            count++;
        }
        return count == 0 ? Double.NaN : (sum / count) * 100;
    }

    public static double mae(double[] actual, double[] predicted) {
        double s = 0;
        for (int i = 0; i < actual.length; i++) s += Math.abs(actual[i] - predicted[i]);
        return s / actual.length;
    }

    public static double rmse(double[] actual, double[] predicted) {
        double s = 0;
        for (int i = 0; i < actual.length; i++) s += Math.pow(actual[i] - predicted[i], 2);
        return Math.sqrt(s / actual.length);
    }

    /** Mean error. Positive means the model under-forecasts. */
    public static double bias(double[] actual, double[] predicted) {
        double s = 0;
        for (int i = 0; i < actual.length; i++) s += actual[i] - predicted[i];
        return s / actual.length;
    }

    /* ---------------------------------------------------------------- */
    /* Rolling-origin backtest                                           */
    /* ---------------------------------------------------------------- */

    public static final class Metrics {
        public final double mape, mae, rmse, bias;
        Metrics(double mape, double mae, double rmse, double bias) {
            this.mape = mape; this.mae = mae; this.rmse = rmse; this.bias = bias;
        }
    }

    public static final class Backtest {
        public final Metrics model, naive, seasonalNaive;
        public final double skill;
        public final int folds, horizon;
        Backtest(Metrics model, Metrics naive, Metrics seasonalNaive,
                 double skill, int folds, int horizon) {
            this.model = model; this.naive = naive; this.seasonalNaive = seasonalNaive;
            this.skill = skill; this.folds = folds; this.horizon = horizon;
        }
    }

    /**
     * At each of {@code folds} successively later cut points the model is
     * refitted on history only and asked for the next {@code horizon} days,
     * which are then compared with held-out actuals. Two baselines run on
     * identical folds:
     *
     * <ul>
     *   <li>naive — yhat = last observed value</li>
     *   <li>seasonal naive — yhat = same weekday last week</li>
     * </ul>
     *
     * Skill = 1 - MAE_model / MAE_seasonalNaive. Reporting accuracy without a
     * baseline is how a model that has learned nothing but the weekly cycle
     * gets mistaken for a good one.
     */
    public static Backtest backtest(int[] series, int horizon, int folds) {
        int minTrain = 2 * SEASON + 21;
        int step = Math.max(1, (series.length - minTrain - horizon) / folds);
        int origin = series.length - horizon - (folds - 1) * step;
        if (origin < minTrain) origin = minTrain;

        java.util.List<double[]> aM = new java.util.ArrayList<>(), pM = new java.util.ArrayList<>();
        java.util.List<double[]> pN = new java.util.ArrayList<>(), pS = new java.util.ArrayList<>();
        int used = 0;

        for (int f = 0; f < folds; f++) {
            int cut = origin + f * step;
            if (cut + horizon > series.length) break;

            int[] train = java.util.Arrays.copyOfRange(series, 0, cut);
            double[] actual = new double[horizon];
            for (int h = 0; h < horizon; h++) actual[h] = series[cut + h];

            Result fc;
            try {
                fc = forecast(train, horizon);
            } catch (IllegalArgumentException e) {
                continue;
            }

            double[] naive = new double[horizon];
            double[] snaive = new double[horizon];
            for (int h = 0; h < horizon; h++) {
                naive[h] = train[train.length - 1];
                snaive[h] = train[train.length - SEASON + (h % SEASON)];
            }

            aM.add(actual); pM.add(fc.point); pN.add(naive); pS.add(snaive);
            used++;
        }

        double[] actualFlat = flatten(aM);
        Metrics model = score(actualFlat, flatten(pM));
        Metrics naive = score(actualFlat, flatten(pN));
        Metrics snaive = score(actualFlat, flatten(pS));
        double skill = (Double.isFinite(snaive.mae) && snaive.mae > 0)
                ? 1 - model.mae / snaive.mae : Double.NaN;

        return new Backtest(model, naive, snaive, skill, used, horizon);
    }

    private static double[] flatten(java.util.List<double[]> rows) {
        int n = 0;
        for (double[] r : rows) n += r.length;
        double[] out = new double[n];
        int i = 0;
        for (double[] r : rows) for (double v : r) out[i++] = v;
        return out;
    }

    private static Metrics score(double[] actual, double[] predicted) {
        if (actual.length == 0) return new Metrics(Double.NaN, Double.NaN, Double.NaN, Double.NaN);
        return new Metrics(mape(actual, predicted), mae(actual, predicted),
                rmse(actual, predicted), bias(actual, predicted));
    }
}
