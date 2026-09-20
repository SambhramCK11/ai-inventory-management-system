package com.inventory;

import com.inventory.ai.Analytics;
import com.inventory.ai.Forecaster;
import com.inventory.ai.Stats;
import com.inventory.data.DataGenerator;
import com.inventory.exception.InsufficientStockException;
import com.inventory.exception.ItemNotFoundException;
import com.inventory.model.InventoryItem;
import com.inventory.model.PerishableItem;

import java.time.LocalDate;
import java.util.List;

/**
 * Test suite.
 *
 * Hand-rolled rather than JUnit, for the same reason the rest of the backend
 * has no dependencies: it must build and run on a machine with nothing but a
 * JDK and no network. The assertions are the ones that matter.
 *
 *   java -cp out com.inventory.EngineTest
 *
 * The most valuable group is the last one. The same algorithms exist in
 * JavaScript (web/assets/js/), and the seeded generator produces an identical
 * demand series in both languages, so the expected values below were taken
 * from the JavaScript engine. A transcription error in either implementation
 * shows up here as a failure rather than as a plausible-looking wrong number
 * on a dashboard. That cross-check is what caught a timezone bug in the
 * JavaScript expiry-date generator, which was producing dates one day early
 * for any viewer east of Greenwich.
 */
public class EngineTest {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out),
                true, java.nio.charset.StandardCharsets.UTF_8));

        System.out.println("Running engine tests\n");

        testDeterminism();
        testDomainModel();
        testExceptions();
        testStats();
        testHoltWinters();
        testVarianceMultipliers();
        testForecastIntervals();
        testBacktestBeatsBaseline();
        testPolicyMonotonicity();
        testExpiryRisk();
        testAnomalyDetection();
        testAbcClassification();
        testCrossLanguageParity();

        System.out.printf("%n%d passed, %d failed%n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    /* ================================================================ */
    /* Assertions                                                       */
    /* ================================================================ */

    private static void check(String name, boolean condition, String detail) {
        if (condition) {
            passed++;
            System.out.printf("  PASS  %s%n", name);
        } else {
            failed++;
            System.out.printf("  FAIL  %s — %s%n", name, detail);
        }
    }

    private static void near(String name, double actual, double expected, double tolerance) {
        boolean ok = Math.abs(actual - expected) <= tolerance;
        check(name, ok, String.format("expected %.6f ± %.6f, got %.6f", expected, tolerance, actual));
    }

    private static void section(String title) {
        System.out.println(title);
    }

    /* ================================================================ */
    /* Tests                                                            */
    /* ================================================================ */

    private static void testDeterminism() {
        section("Determinism");
        LocalDate today = LocalDate.of(2026, 9, 19);
        List<InventoryItem> a = DataGenerator.buildInventory(DataGenerator.DEFAULT_SEED, today);
        List<InventoryItem> b = DataGenerator.buildInventory(DataGenerator.DEFAULT_SEED, today);

        boolean identical = a.size() == b.size();
        for (int i = 0; identical && i < a.size(); i++) {
            identical = java.util.Arrays.equals(a.get(i).getHistory(), b.get(i).getHistory())
                    && a.get(i).getQuantity() == b.get(i).getQuantity();
        }
        check("same seed reproduces the identical catalogue", identical, "series differed between runs");

        List<InventoryItem> c = DataGenerator.buildInventory(12345, today);
        check("a different seed produces different demand",
                !java.util.Arrays.equals(a.get(0).getHistory(), c.get(0).getHistory()),
                "seed had no effect");

        check("history length is 200 days",
                a.get(0).getHistory().length == DataGenerator.HISTORY_DAYS, "wrong length");

        // getHistory() must hand back a copy, or a caller can rewrite the past.
        int[] stolen = a.get(0).getHistory();
        int original = stolen[0];
        stolen[0] = -999;
        check("getHistory() returns a defensive copy",
                a.get(0).getHistory()[0] == original, "internal array was mutable from outside");
    }

    private static void testDomainModel() {
        section("\nDomain model");
        List<InventoryItem> items = DataGenerator.buildInventory();

        InventoryItem perishable = items.stream().filter(InventoryItem::isPerishable).findFirst().orElseThrow();
        InventoryItem plain = items.stream().filter(i -> !i.isPerishable()).findFirst().orElseThrow();

        check("perishable overrides getDetails() to include expiry",
                perishable.getDetails().contains("Expires"), perishable.getDetails());
        check("non-perishable omits expiry from getDetails()",
                !plain.getDetails().contains("Expires"), plain.getDetails());
        check("non-perishable is never at risk by shelf life",
                !plain.isAtRisk(), "non-perishable reported at risk");
        check("polymorphic dispatch through the base type",
                perishable instanceof PerishableItem && perishable.isPerishable(), "wrong subtype");

        int before = plain.getQuantity();
        double revenue = plain.purchase(5);
        check("purchase decrements stock", plain.getQuantity() == before - 5, "stock not reduced");
        near("purchase returns the revenue", revenue, 5 * plain.getPrice(), 1e-9);

        plain.restock(5);
        check("restock restores stock", plain.getQuantity() == before, "stock not restored");

        near("margin per unit", plain.getMarginPerUnit(), plain.getPrice() - plain.getUnitCost(), 1e-9);
        near("stock value", plain.getStockValue(), plain.getQuantity() * plain.getUnitCost(), 1e-9);
    }

    private static void testExceptions() {
        section("\nExceptions");
        InventoryManager manager = new InventoryManager();
        manager.addAll(DataGenerator.buildInventory());
        InventoryItem item = manager.getInventory().get(0);

        boolean threw = false;
        int available = item.getQuantity();
        try {
            item.purchase(available + 1);
        } catch (InsufficientStockException e) {
            threw = true;
            check("exception carries the available count", e.getAvailable() == available,
                    "got " + e.getAvailable());
            check("exception carries the requested count", e.getRequested() == available + 1,
                    "got " + e.getRequested());
        }
        check("over-large purchase throws InsufficientStockException", threw, "no exception thrown");
        check("failed purchase leaves stock untouched", item.getQuantity() == available,
                "stock changed on a failed purchase");

        threw = false;
        try { manager.requireBySku("NOPE-0000"); } catch (ItemNotFoundException e) { threw = true; }
        check("unknown SKU throws ItemNotFoundException", threw, "no exception thrown");

        threw = false;
        try { item.purchase(0); } catch (IllegalArgumentException e) { threw = true; }
        check("zero-quantity purchase is rejected", threw, "no exception thrown");

        threw = false;
        try { manager.setServiceLevel(1.0); } catch (IllegalArgumentException e) { threw = true; }
        check("service level of 1.0 is rejected", threw, "no exception thrown");
    }

    private static void testStats() {
        section("\nStatistics");
        near("normalCdf(0)", Stats.normalCdf(0), 0.5, 1e-9);
        near("normalCdf(1.96)", Stats.normalCdf(1.96), 0.975, 1e-4);
        near("normalCdf(-1.96)", Stats.normalCdf(-1.96), 0.025, 1e-4);
        near("normalQuantile(0.95)", Stats.normalQuantile(0.95), 1.6448536, 1e-5);
        near("normalQuantile(0.975)", Stats.normalQuantile(0.975), 1.959964, 1e-5);

        // The two must be mutual inverses, or safety stock and stockout
        // probability would disagree with each other.
        for (double p : new double[]{0.80, 0.90, 0.95, 0.99}) {
            near("CDF(quantile(" + p + ")) round-trips", Stats.normalCdf(Stats.normalQuantile(p)), p, 1e-6);
        }

        double[] xs = {1, 2, 3, 4, 100};
        near("median resists the outlier", Stats.median(xs), 3, 1e-9);
        check("MAD is far below the standard deviation here",
                Stats.mad(xs) < Stats.std(xs) / 10,
                String.format("mad=%.3f std=%.3f", Stats.mad(xs), Stats.std(xs)));
    }

    private static void testHoltWinters() {
        section("\nHolt-Winters");
        int[] series = DataGenerator.buildInventory().get(0).getHistory();

        Forecaster.State st = Forecaster.holtWinters(series, 0.3, 0.05, 0.2, 7);
        check("residuals start after the first full season",
                st.residuals.length == series.length - 7, "got " + st.residuals.length);

        double meanResidual = Stats.mean(st.residuals);
        check("residuals are approximately centred on zero",
                Math.abs(meanResidual) < 0.15 * Stats.std(st.residuals),
                String.format("mean residual %.3f vs sigma %.3f", meanResidual, Stats.std(st.residuals)));

        boolean threw = false;
        try {
            Forecaster.holtWinters(new int[]{1, 2, 3}, 0.3, 0.05, 0.2, 7);
        } catch (IllegalArgumentException e) { threw = true; }
        check("fitting fewer than two seasons is rejected", threw, "no exception thrown");

        // A pure weekly cycle with no noise must be reproduced almost exactly.
        int[] clean = new int[70];
        int[] shape = {10, 12, 14, 16, 22, 28, 18};
        for (int i = 0; i < clean.length; i++) clean[i] = shape[i % 7];
        Forecaster.Result fc = Forecaster.forecast(clean, 7);
        double maxErr = 0;
        for (int h = 0; h < 7; h++) maxErr = Math.max(maxErr, Math.abs(fc.point[h] - shape[(70 + h) % 7]));
        check("a noiseless weekly cycle is recovered", maxErr < 1.0,
                String.format("max error %.3f units", maxErr));
    }

    private static void testVarianceMultipliers() {
        section("\nPrediction-interval variance");
        double[] m = Forecaster.varianceMultipliers(14, 0.3, 0.05, 0.2, 7);

        near("one-step multiplier is exactly 1", m[0], 1.0, 1e-12);

        boolean increasing = true;
        for (int i = 1; i < m.length; i++) if (m[i] < m[i - 1]) increasing = false;
        check("uncertainty grows with the horizon", increasing, "multipliers were not monotonic");

        // The whole point of using the ETS variance: it must be materially
        // tighter than the random-walk sqrt(h) widening it replaced.
        check("stays well below the sqrt(h) random-walk bound",
                m[13] < Math.sqrt(14),
                String.format("ETS %.3f vs sqrt(h) %.3f", m[13], Math.sqrt(14)));

        // With alpha = 0 the model ignores new information, so every step
        // ahead carries exactly the one-step variance.
        double[] flat = Forecaster.varianceMultipliers(10, 0.0, 0.0, 0.0, 7);
        near("alpha=0 leaves the variance flat", flat[9], 1.0, 1e-12);
    }

    private static void testForecastIntervals() {
        section("\nForecast intervals");
        int[] series = DataGenerator.buildInventory().get(2).getHistory();
        Forecaster.Result fc = Forecaster.forecast(series, 14);

        boolean ordered = true, nonNegative = true;
        for (int i = 0; i < 14; i++) {
            if (!(fc.lower[i] <= fc.point[i] && fc.point[i] <= fc.upper[i])) ordered = false;
            if (fc.lower[i] < 0 || fc.point[i] < 0) nonNegative = false;
        }
        check("lower <= point <= upper at every step", ordered, "interval was inverted");
        check("no negative demand is ever forecast", nonNegative, "negative units forecast");

        check("the interval widens with the horizon",
                (fc.upper[13] - fc.lower[13]) > (fc.upper[0] - fc.lower[0]),
                "interval did not widen");

        check("cumulative interval brackets the cumulative point",
                fc.cumulativeLower <= fc.cumulativePoint && fc.cumulativePoint <= fc.cumulativeUpper,
                "cumulative interval was inverted");

        // A 99% interval must contain the 95% one.
        Forecaster.Result wide = Forecaster.forecast(series, 14, 0.99);
        check("a higher confidence level gives a wider interval",
                wide.upper[7] > fc.upper[7], "99% band was not wider than 95%");
    }

    private static void testBacktestBeatsBaseline() {
        section("\nBacktesting");
        List<InventoryItem> items = DataGenerator.buildInventory();

        int wins = 0, evaluated = 0;
        double mapeSum = 0, skillSum = 0;
        for (InventoryItem item : items) {
            Forecaster.Backtest bt = Forecaster.backtest(item.getHistory(), 7, 6);
            if (!Double.isFinite(bt.skill)) continue;
            evaluated++;
            if (bt.skill > 0) wins++;
            mapeSum += bt.model.mape;
            skillSum += bt.skill;
        }

        check("every SKU produced a usable backtest", evaluated == items.size(),
                evaluated + " of " + items.size());
        check("six folds were evaluated",
                Forecaster.backtest(items.get(0).getHistory(), 7, 6).folds == 6, "wrong fold count");

        double meanMape = mapeSum / evaluated;
        double meanSkill = skillSum / evaluated;

        check("mean MAPE is within a plausible retail range (<30%)",
                meanMape < 30, String.format("%.2f%%", meanMape));
        check("the model beats the seasonal-naive baseline on average",
                meanSkill > 0, String.format("mean skill %+.4f", meanSkill));
        check("it beats the baseline on most SKUs",
                wins >= evaluated * 0.75, wins + "/" + evaluated);
    }

    private static void testPolicyMonotonicity() {
        section("\nReplenishment policy");
        List<InventoryItem> items = DataGenerator.buildInventory();
        InventoryItem item = items.get(0);
        Forecaster.Result fc = Forecaster.forecast(item.getHistory(), 14);

        Analytics.Policy p90 = Analytics.policy(item, fc, 0.90);
        Analytics.Policy p99 = Analytics.policy(item, fc, 0.99);

        check("a higher service level demands more safety stock",
                p99.safetyStock > p90.safetyStock,
                String.format("90%%: %.1f, 99%%: %.1f", p90.safetyStock, p99.safetyStock));
        check("a higher service level raises the reorder point",
                p99.reorderPoint > p90.reorderPoint, "reorder point did not move");

        // Safety stock must exceed the demand-only figure, or the lead-time
        // variance term has been dropped — the classic error this policy is
        // written to avoid.
        double demandOnly = p90.z * Math.sqrt(item.getLeadTimeDays()) * fc.sigma;
        check("safety stock accounts for lead-time variance too",
                p90.safetyStock > demandOnly,
                String.format("combined %.2f vs demand-only %.2f", p90.safetyStock, demandOnly));

        check("stockout probability is a probability",
                p90.stockoutProb >= 0 && p90.stockoutProb <= 1, "out of [0,1]");
        check("order quantity respects the minimum order quantity",
                p90.orderQty >= item.getMoq(), p90.orderQty + " < MOQ " + item.getMoq());
        check("order quantity is a whole multiple of the MOQ",
                p90.orderQty % item.getMoq() == 0, p90.orderQty + " is not a multiple of " + item.getMoq());
        check("expected shortage is never negative", p90.expectedShortage >= 0, "negative shortage");

        // An item with no stock is certain to stock out.
        Analytics.Policy zero = Analytics.policy(
                new com.inventory.model.NonPerishableItem(9999, "T-1", "Test", "Test", 0,
                        10, 5, "T", 7, 1, 10, item.getHistory()), fc, 0.95);
        check("zero stock gives a stockout probability near 1",
                zero.stockoutProb > 0.99, String.format("%.4f", zero.stockoutProb));
    }

    private static void testExpiryRisk() {
        section("\nExpiry risk");
        List<InventoryItem> items = DataGenerator.buildInventory();

        boolean bounded = true, nonNegative = true;
        double totalWriteOff = 0;
        for (InventoryItem item : items) {
            if (!(item instanceof PerishableItem p)) continue;
            Forecaster.Result fc = Forecaster.forecast(p.getHistory(), 14);
            Analytics.ExpiryRisk risk = Analytics.expiryRisk(p, fc);

            if (risk.expectedSpoilUnits > p.getQuantity() + 1e-6) bounded = false;
            if (risk.expectedSpoilUnits < 0) nonNegative = false;
            totalWriteOff += risk.writeOffValue;
        }
        check("expected spoilage never exceeds the stock on hand", bounded, "spoilage exceeded quantity");
        check("expected spoilage is never negative", nonNegative, "negative spoilage");
        check("total write-off is positive for this catalogue",
                totalWriteOff > 0, String.format("$%.2f", totalWriteOff));

        // A batch with far more stock than it can possibly sell must show
        // spoilage close to the surplus.
        PerishableItem doomed = new PerishableItem(9998, "T-2", "Doomed", "Test",
                10_000, 5, 2, "T", 1, 0.1, 10,
                items.get(0).getHistory(), 30, LocalDate.now().plusDays(1));
        Forecaster.Result fc = Forecaster.forecast(doomed.getHistory(), 14);
        Analytics.ExpiryRisk risk = Analytics.expiryRisk(doomed, fc);
        check("a hopelessly overstocked batch spoils almost entirely",
                risk.expectedSpoilUnits > 9000,
                String.format("%.1f of 10000", risk.expectedSpoilUnits));
        check("the suggested markdown never exceeds the gross margin",
                risk.suggestedDiscount <= (doomed.getMarginPerUnit() / doomed.getPrice()) * 100 + 1e-6,
                String.format("%.2f%%", risk.suggestedDiscount));
    }

    private static void testAnomalyDetection() {
        section("\nAnomaly detection");

        // A clean weekly cycle must produce NO anomalies. This is the test
        // that fails if the detector scores raw values instead of
        // deseasonalised residuals — it would flag every weekend.
        int[] clean = new int[140];
        int[] shape = {10, 12, 14, 16, 30, 38, 20};
        for (int i = 0; i < clean.length; i++) clean[i] = shape[i % 7];
        Analytics.AnomalyReport quiet = Analytics.detectAnomalies(clean, 3.0);
        check("a pure weekly cycle raises no anomalies",
                quiet.anomalies.isEmpty(), quiet.anomalies.size() + " false positives");

        // Now inject one unmistakable spike.
        int[] spiked = clean.clone();
        spiked[70] = 400;
        Analytics.AnomalyReport loud = Analytics.detectAnomalies(spiked, 3.0);
        boolean foundIt = loud.anomalies.stream().anyMatch(a -> a.day == 70 && a.direction.equals("spike"));
        check("an injected spike is detected at the right day", foundIt,
                "detected " + loud.anomalies.size() + " events, none at day 70");

        // And one drop.
        int[] dropped = clean.clone();
        dropped[70] = 0;
        Analytics.AnomalyReport low = Analytics.detectAnomalies(dropped, 3.0);
        check("an injected drop is detected and signed correctly",
                low.anomalies.stream().anyMatch(a -> a.day == 70 && a.direction.equals("drop")),
                "drop not detected");

        // The real catalogue contains planted promotions and a supply outage.
        List<InventoryItem> items = DataGenerator.buildInventory();
        long total = items.stream()
                .mapToLong(i -> Analytics.detectAnomalies(i.getHistory(), 3.0).anomalies.size()).sum();
        check("the seeded promotions and outage are picked up", total > 0, "found none");

        InventoryItem mouse = items.stream().filter(i -> i.getSku().equals("ELC-5002")).findFirst().orElseThrow();
        boolean foundOutage = Analytics.detectAnomalies(mouse.getHistory(), 3.0).anomalies.stream()
                .anyMatch(a -> a.day >= 100 && a.day < 104 && a.direction.equals("drop"));
        check("the planted 4-day supply outage is found on ELC-5002", foundOutage, "outage missed");
    }

    private static void testAbcClassification() {
        section("\nABC classification");
        List<InventoryItem> items = DataGenerator.buildInventory();
        List<Analytics.AbcEntry> abc = Analytics.classifyAbc(items);

        check("every item is classified", abc.size() == items.size(), "count mismatch");

        boolean descending = true;
        for (int i = 1; i < abc.size(); i++) {
            if (abc.get(i).annualMargin > abc.get(i - 1).annualMargin) descending = false;
        }
        check("entries are ranked by descending margin", descending, "ordering was wrong");

        boolean shareIncreases = true;
        for (int i = 1; i < abc.size(); i++) {
            if (abc.get(i).cumulativeShare < abc.get(i - 1).cumulativeShare) shareIncreases = false;
        }
        check("cumulative share is non-decreasing", shareIncreases, "share went backwards");
        near("cumulative share ends at 100%", abc.get(abc.size() - 1).cumulativeShare, 1.0, 1e-6);

        boolean classesOrdered = true;
        String seen = "A";
        for (Analytics.AbcEntry e : abc) {
            if (seen.equals("A") && e.abc.equals("B")) seen = "B";
            else if (seen.equals("B") && e.abc.equals("C")) seen = "C";
            else if (!e.abc.equals(seen)) classesOrdered = false;
        }
        check("classes appear in A, B, C order without interleaving", classesOrdered, "classes interleaved");
    }

    /**
     * Values below come from the JavaScript engine over the same seeded
     * series. Tolerances are loose enough to absorb last-ulp differences in
     * the two runtimes' transcendental functions, and far too tight to hide
     * an actual algorithmic divergence.
     */
    private static void testCrossLanguageParity() {
        section("\nCross-language parity with the JavaScript engine");
        List<InventoryItem> items = DataGenerator.buildInventory();

        // The PRNG must produce the identical integer stream.
        DataGenerator.Mulberry32 rng = new DataGenerator.Mulberry32(DataGenerator.DEFAULT_SEED);
        near("mulberry32 draw 1", rng.next(), 0.8436797377653420, 1e-12);
        near("mulberry32 draw 2", rng.next(), 0.3907737105619162, 1e-12);
        near("mulberry32 draw 3", rng.next(), 0.0911537655629218, 1e-12);

        // Which means the generated demand matches exactly.
        int[] first = items.get(0).getHistory();
        check("BEV-1001 first five days match the JS series",
                first[0] == 33 && first[1] == 46 && first[2] == 24 && first[3] == 41 && first[4] == 24,
                java.util.Arrays.toString(java.util.Arrays.copyOf(first, 5)));

        check("BEV-1001 opening stock matches", items.get(0).getQuantity() == 809,
                "got " + items.get(0).getQuantity());

        // And so do the headline model metrics.
        int wins = 0;
        double mapeSum = 0, skillSum = 0;
        for (InventoryItem item : items) {
            Forecaster.Backtest bt = Forecaster.backtest(item.getHistory(), 7, 6);
            mapeSum += bt.model.mape;
            skillSum += bt.skill;
            if (bt.skill > 0) wins++;
        }
        near("mean MAPE matches the JS engine", mapeSum / items.size(), 20.77, 0.05);
        near("mean skill matches the JS engine", skillSum / items.size(), 0.185, 0.005);
        check("same number of SKUs beat the baseline", wins == 17, "got " + wins);

        InventoryManager manager = new InventoryManager();
        manager.addAll(items);
        near("total stock value matches", manager.getTotalStockValue(), 44584, 2.0);
        check("same number of items due for reorder",
                manager.getReorderDue().size() == 7, "got " + manager.getReorderDue().size());
    }
}
