package com.inventory.ai;

import com.inventory.model.InventoryItem;
import com.inventory.model.PerishableItem;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The decision layer: replenishment policy, expiry risk, anomaly detection
 * and ABC classification, plus the composite analysis record the API serves.
 */
public final class Analytics {

    private Analytics() {}

    /* ================================================================ */
    /* Replenishment policy                                             */
    /* ================================================================ */

    public static final class Policy {
        public final double dBar, sigmaD, sigmaDL, z;
        public final double safetyStock, leadTimeDemand, reorderPoint;
        public final double eoq, stockoutProb, daysOfCover, expectedShortage;
        public final int orderQty;
        public final boolean shouldReorder;
        public final double serviceLevel, annualHoldingCost;

        Policy(double dBar, double sigmaD, double sigmaDL, double z, double safetyStock,
               double leadTimeDemand, double reorderPoint, double eoq, int orderQty,
               double stockoutProb, double daysOfCover, double expectedShortage,
               boolean shouldReorder, double serviceLevel, double annualHoldingCost) {
            this.dBar = dBar; this.sigmaD = sigmaD; this.sigmaDL = sigmaDL; this.z = z;
            this.safetyStock = safetyStock; this.leadTimeDemand = leadTimeDemand;
            this.reorderPoint = reorderPoint; this.eoq = eoq; this.orderQty = orderQty;
            this.stockoutProb = stockoutProb; this.daysOfCover = daysOfCover;
            this.expectedShortage = expectedShortage; this.shouldReorder = shouldReorder;
            this.serviceLevel = serviceLevel; this.annualHoldingCost = annualHoldingCost;
        }
    }

    /**
     * Continuous-review (Q, R) policy under uncertainty in demand AND lead
     * time:
     *
     * <pre>
     * sigma_DL = sqrt( LT*sigma_d^2 + d_bar^2*sigma_LT^2 )
     * SS       = z * sigma_DL
     * ROP      = d_bar*LT + SS
     * EOQ      = sqrt( 2*D*S / H )
     * </pre>
     *
     * Dropping the second term under the root — as most textbook treatments
     * do — is the usual reason a 95% target service level delivers about 80%
     * in practice: supplier variability is often the larger of the two.
     */
    public static Policy policy(InventoryItem item, Forecaster.Result fc,
                                double serviceLevel, double orderCost, double holdingRate) {
        double dBar = fc.dailyMean;
        double sigmaD = fc.sigma;
        int LT = item.getLeadTimeDays();
        double sigmaLT = item.getLeadTimeSigma();

        double sigmaDL = Math.sqrt(LT * sigmaD * sigmaD + dBar * dBar * sigmaLT * sigmaLT);
        double z = Stats.normalQuantile(serviceLevel);
        double safetyStock = Math.max(0, z * sigmaDL);
        double leadTimeDemand = dBar * LT;
        double reorderPoint = leadTimeDemand + safetyStock;

        double annualDemand = dBar * 365;
        double holdingCost = item.getUnitCost() * holdingRate;
        double eoq = holdingCost > 0 ? Math.sqrt(2 * annualDemand * orderCost / holdingCost) : 0;
        int moq = item.getMoq();
        int orderQty = Math.max(moq, (int) Math.round(eoq / moq) * moq);
        if (orderQty <= 0) orderQty = moq;

        double stockoutProb;
        if (sigmaDL > 0) {
            stockoutProb = 1 - Stats.normalCdf((item.getQuantity() - leadTimeDemand) / sigmaDL);
        } else {
            stockoutProb = item.getQuantity() < leadTimeDemand ? 1 : 0;
        }

        double daysOfCover = dBar > 0 ? item.getQuantity() / dBar : Double.POSITIVE_INFINITY;

        // Expected units short per cycle, via the normal loss function:
        // E[shortage] = sigma_DL * ( phi(z) - z*(1-Phi(z)) )
        double expectedShortage = 0;
        if (sigmaDL > 0) {
            double zCur = (item.getQuantity() - leadTimeDemand) / sigmaDL;
            expectedShortage = Math.max(0,
                    sigmaDL * (Stats.normalPdf(zCur) - zCur * (1 - Stats.normalCdf(zCur))));
        }

        return new Policy(dBar, sigmaD, sigmaDL, z, safetyStock, leadTimeDemand, reorderPoint,
                eoq, orderQty, stockoutProb, daysOfCover, expectedShortage,
                item.getQuantity() <= reorderPoint, serviceLevel,
                (safetyStock + orderQty / 2.0) * holdingCost);
    }

    public static Policy policy(InventoryItem item, Forecaster.Result fc, double serviceLevel) {
        return policy(item, fc, serviceLevel, 45, 0.22);
    }

    /* ================================================================ */
    /* Expiry risk                                                      */
    /* ================================================================ */

    public static final class ExpiryRisk {
        public final long days;
        public final double cumulativeDemand, sigmaC, expectedSpoilUnits;
        public final double writeOffValue, spoilProbability, suggestedDiscount;
        public final boolean clearanceAdvised;

        ExpiryRisk(long days, double cumulativeDemand, double sigmaC, double expectedSpoilUnits,
                   double writeOffValue, double spoilProbability, double suggestedDiscount,
                   boolean clearanceAdvised) {
            this.days = days; this.cumulativeDemand = cumulativeDemand; this.sigmaC = sigmaC;
            this.expectedSpoilUnits = expectedSpoilUnits; this.writeOffValue = writeOffValue;
            this.spoilProbability = spoilProbability; this.suggestedDiscount = suggestedDiscount;
            this.clearanceAdvised = clearanceAdvised;
        }
    }

    /**
     * Expected spoilage for a perishable batch.
     *
     * A binary expired/not-expired flag is nearly useless for planning: what a
     * buyer needs is how much will be left when the date arrives. Cumulative
     * demand over the remaining shelf life is itself uncertain, so the
     * leftover is integrated rather than subtracted:
     *
     * <pre>
     * E[max(0, Q - D)] = sigma_C*phi(k) + (Q - mu_C)*Phi(k),   k = (Q-mu_C)/sigma_C
     * </pre>
     */
    public static ExpiryRisk expiryRisk(PerishableItem item, Forecaster.Result fc) {
        long days = Math.max(0, item.daysToExpiry());
        int qty = item.getQuantity();

        if (days == 0) {
            return new ExpiryRisk(0, 0, 0, qty, qty * item.getUnitCost(), 1, 0, true);
        }

        int horizon = (int) Math.min(days, 60);
        Forecaster.Result horizonFc = Forecaster.forecast(item.getHistory(), horizon);
        double muC = 0;
        for (int i = 0; i < Math.min(days, horizonFc.point.length); i++) muC += horizonFc.point[i];
        double sigmaC = fc.sigma * Math.sqrt(days);

        double k = sigmaC > 0 ? (qty - muC) / sigmaC : (qty > muC ? 9 : -9);
        double expectedSpoil = sigmaC > 0
                ? Math.max(0, sigmaC * Stats.normalPdf(k) + (qty - muC) * Stats.normalCdf(k))
                : Math.max(0, qty - muC);

        double discount = 0;
        if (expectedSpoil >= 1) {
            double surplusShare = expectedSpoil / Math.max(1, qty);
            double maxDiscount = item.getMarginPerUnit() / item.getPrice();
            discount = Math.min(maxDiscount, surplusShare) * 100;
        }

        return new ExpiryRisk(days, muC, sigmaC, expectedSpoil,
                expectedSpoil * item.getUnitCost(), Stats.normalCdf(k), discount,
                expectedSpoil > 0.1 * qty && expectedSpoil >= 1);
    }

    /* ================================================================ */
    /* Anomaly detection                                                */
    /* ================================================================ */

    public static final class Anomaly {
        public final int day;
        public final int value;
        public final double expected, z;
        public final String direction;
        Anomaly(int day, int value, double expected, double z, String direction) {
            this.day = day; this.value = value; this.expected = expected;
            this.z = z; this.direction = direction;
        }
    }

    public static final class AnomalyReport {
        public final List<Anomaly> anomalies;
        public final double residualScale;
        public final int checked;
        public final double threshold;
        AnomalyReport(List<Anomaly> anomalies, double residualScale, int checked, double threshold) {
            this.anomalies = anomalies; this.residualScale = residualScale;
            this.checked = checked; this.threshold = threshold;
        }
    }

    /**
     * A plain z-score on raw sales flags every weekend, because weekends
     * genuinely sell more. The series is therefore decomposed into trend and
     * weekly seasonality first, and only the residual is scored — with a
     * MAD-based robust z, since the median and MAD are not dragged around by
     * the very outliers being searched for, which a mean and standard
     * deviation would be.
     *
     * The trend is a running MEDIAN over two full seasons rather than a
     * moving average. That detail matters more than it looks: a <em>run</em>
     * of outliers — a four-day supply outage, say — drags a moving average
     * down to meet it, so the residual goes small and the outage hides
     * itself. This is outlier masking, and it is precisely the event an
     * inventory system most needs to catch. A median over a 15-day window is
     * unmoved by four bad days, so the outage stands out at full size.
     *
     * The window is 2m+1 so it holds each weekday position twice; the
     * seasonal step then removes whatever phase-dependent offset the median
     * introduces.
     */
    public static AnomalyReport detectAnomalies(int[] series, double threshold) {
        int n = series.length;
        int m = Forecaster.SEASON;
        int half = m; // window = 2*SEASON + 1 = 15 days

        Double[] trend = new Double[n];
        for (int t = half; t < n - half; t++) {
            double[] window = new double[2 * half + 1];
            for (int k = 0; k < window.length; k++) window[k] = series[t - half + k];
            trend[t] = Stats.median(window);
        }

        List<List<Double>> byPos = new ArrayList<>();
        for (int i = 0; i < m; i++) byPos.add(new ArrayList<>());
        for (int t = half; t < n - half; t++) byPos.get(t % m).add(series[t] - trend[t]);

        double[] seasonal = new double[m];
        for (int i = 0; i < m; i++) {
            List<Double> xs = byPos.get(i);
            double s = 0;
            for (double v : xs) s += v;
            seasonal[i] = xs.isEmpty() ? 0 : s / xs.size();
        }
        double seasonalMean = Stats.mean(seasonal);
        for (int i = 0; i < m; i++) seasonal[i] -= seasonalMean;

        int count = n - 2 * half;
        double[] residuals = new double[Math.max(0, count)];
        int[] index = new int[Math.max(0, count)];
        int c = 0;
        for (int t = half; t < n - half; t++) {
            residuals[c] = series[t] - trend[t] - seasonal[t % m];
            index[c] = t;
            c++;
        }

        double med = Stats.median(residuals);
        double scale = Stats.mad(residuals);
        if (scale == 0) scale = Stats.std(residuals);
        if (scale == 0) scale = 1;

        List<Anomaly> found = new ArrayList<>();
        for (int i = 0; i < c; i++) {
            double z = (residuals[i] - med) / scale;
            if (Math.abs(z) >= threshold) {
                int t = index[i];
                found.add(new Anomaly(t, series[t], trend[t] + seasonal[t % m], z,
                        z > 0 ? "spike" : "drop"));
            }
        }
        return new AnomalyReport(found, scale, c, threshold);
    }

    /* ================================================================ */
    /* ABC classification                                               */
    /* ================================================================ */

    public static final class AbcEntry {
        public final InventoryItem item;
        public final double annualMargin, cumulativeShare;
        public final String abc;
        AbcEntry(InventoryItem item, double annualMargin, double cumulativeShare, String abc) {
            this.item = item; this.annualMargin = annualMargin;
            this.cumulativeShare = cumulativeShare; this.abc = abc;
        }
    }

    /**
     * Ranks SKUs by annualised gross margin and cuts the cumulative curve at
     * 80% (A) and 95% (B). Margin rather than revenue: a high-turnover item
     * sold at nearly cost does not deserve an A-item service level.
     */
    public static List<AbcEntry> classifyAbc(List<InventoryItem> items) {
        List<double[]> idx = new ArrayList<>();
        List<InventoryItem> sorted = new ArrayList<>(items);

        Map<String, Double> margins = new HashMap<>();
        for (InventoryItem it : items) {
            margins.put(it.getSku(), (it.unitsSold(90) / 90.0) * 365 * it.getMarginPerUnit());
        }
        sorted.sort(Comparator.comparingDouble((InventoryItem it) -> margins.get(it.getSku())).reversed());

        double total = 0;
        for (double v : margins.values()) total += v;
        if (total == 0) total = 1;

        List<AbcEntry> out = new ArrayList<>();
        double cum = 0;
        for (InventoryItem it : sorted) {
            double m = margins.get(it.getSku());
            cum += m;
            double share = cum / total;
            String cls = share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C";
            out.add(new AbcEntry(it, m, share, cls));
        }
        return out;
    }

    /* ================================================================ */
    /* Composite analysis                                               */
    /* ================================================================ */

    public static final class Analysis {
        public final InventoryItem item;
        public final Forecaster.Result forecast;
        public final Forecaster.Backtest backtest;
        public final Policy policy;
        public final ExpiryRisk expiry;   // null for non-perishables
        public final AnomalyReport anomalies;
        public final String abc;
        public final double annualMargin, cumulativeShare;
        public final int riskScore;

        Analysis(InventoryItem item, Forecaster.Result forecast, Forecaster.Backtest backtest,
                 Policy policy, ExpiryRisk expiry, AnomalyReport anomalies,
                 String abc, double annualMargin, double cumulativeShare, int riskScore) {
            this.item = item; this.forecast = forecast; this.backtest = backtest;
            this.policy = policy; this.expiry = expiry; this.anomalies = anomalies;
            this.abc = abc; this.annualMargin = annualMargin;
            this.cumulativeShare = cumulativeShare; this.riskScore = riskScore;
        }
    }

    /**
     * Runs the whole pipeline and returns one record per item, ordered by a
     * composite risk score.
     *
     * The score blends stockout probability, expiry exposure and forecast
     * uncertainty, weighted by ABC class — a 60% stockout probability on a
     * class-C item is genuinely less urgent than a 40% one on a class-A item,
     * and a ranking that ignores that sends buyers to the wrong SKU first.
     */
    public static List<Analysis> analyse(List<InventoryItem> items, double serviceLevel, int horizon) {
        Map<String, AbcEntry> abcBySku = new HashMap<>();
        for (AbcEntry e : classifyAbc(items)) abcBySku.put(e.item.getSku(), e);

        List<Analysis> out = new ArrayList<>();
        for (InventoryItem item : items) {
            int[] history = item.getHistory();
            Forecaster.Result fc = Forecaster.forecast(history, horizon);
            Forecaster.Backtest bt = Forecaster.backtest(history, 7, 6);
            Policy pol = policy(item, fc, serviceLevel);
            ExpiryRisk exp = item instanceof PerishableItem p ? expiryRisk(p, fc) : null;
            AnomalyReport anom = detectAnomalies(history, 3.0);
            AbcEntry abc = abcBySku.get(item.getSku());

            double classWeight = switch (abc.abc) {
                case "A" -> 1.0;
                case "B" -> 0.75;
                default -> 0.5;
            };
            double expiryExposure = exp != null
                    ? Math.min(1, exp.writeOffValue / Math.max(1, item.getStockValue())) : 0;
            double cv = fc.dailyMean > 0 ? Math.min(1, fc.sigma / fc.dailyMean) : 0;
            int riskScore = (int) Math.round(100 * classWeight
                    * (0.55 * pol.stockoutProb + 0.3 * expiryExposure + 0.15 * cv));

            out.add(new Analysis(item, fc, bt, pol, exp, anom,
                    abc.abc, abc.annualMargin, abc.cumulativeShare, riskScore));
        }
        out.sort(Comparator.comparingInt((Analysis a) -> a.riskScore).reversed());
        return out;
    }

    public static List<Analysis> analyse(List<InventoryItem> items) {
        return analyse(items, 0.95, 14);
    }
}
