package com.inventory.data;

import com.inventory.model.InventoryItem;
import com.inventory.model.NonPerishableItem;
import com.inventory.model.PerishableItem;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Deterministic synthetic catalogue, bit-for-bit identical to the JavaScript
 * generator in {@code web/assets/js/data.js}.
 *
 * The PRNG below reproduces mulberry32 exactly. JavaScript's {@code Math.imul}
 * is a 32-bit signed multiply, which is plain {@code int} multiplication in
 * Java, and {@code >>>} is a logical shift in both languages — so the integer
 * stream matches without any coercion tricks. That is what lets the Java and
 * JavaScript engines be compared numerically in the test suite instead of
 * merely looking similar.
 */
public final class DataGenerator {

    public static final int HISTORY_DAYS = 200;
    public static final int DEFAULT_SEED = 20260919;

    private DataGenerator() {}

    /* ---------------------------------------------------------------- */
    /* PRNG                                                              */
    /* ---------------------------------------------------------------- */

    /** mulberry32 — same integer stream as the JavaScript implementation. */
    public static final class Mulberry32 {
        private int a;

        public Mulberry32(int seed) { this.a = seed; }

        public double next() {
            a = a + 0x6D2B79F5;
            int t = (a ^ (a >>> 15)) * (1 | a);
            t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t;
            return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
        }

        /** Box-Muller transform: standard normal from a uniform generator. */
        public double gaussian() {
            double u = 0, v = 0;
            while (u == 0) u = next();
            while (v == 0) v = next();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        }
    }

    /* ---------------------------------------------------------------- */
    /* Catalogue specification                                           */
    /* ---------------------------------------------------------------- */

    /** A promotional window: start day, length in days, multiplicative lift. */
    record Promo(int start, int length, double lift) {}

    record Spec(String sku, String name, String category, boolean perishable,
                Integer shelfLife, double cost, double price,
                double base, double trend, double weekly, double noise,
                int lead, double leadSigma, int moq,
                String scenario, Integer expiryIn, Promo[] promos) {}

    private static final Spec[] CATALOGUE = {
        new Spec("BEV-1001", "Cold Brew Concentrate", "Beverages",   true,  45,   3.10,  6.50,  42, 0.07, 0.34, 0.16, 5,  1.4, 120, "healthy",   26,   new Promo[]{new Promo(44, 6, 1.9)}),
        new Spec("BEV-1002", "Sparkling Water 12pk",  "Beverages",   false, null, 4.20,  8.00,  30, 0.02, 0.28, 0.18, 7,  2.0, 100, "reorder",   null, new Promo[]{}),
        new Spec("BEV-1003", "Oat Milk 1L",           "Beverages",   true,  30,   1.65,  3.40,  58, 0.10, 0.18, 0.15, 3,  0.8, 200, "spoil",     9,    new Promo[]{}),
        new Spec("SNK-2001", "Protein Bar Box",       "Snacks",      true,  180,  9.40,  17.00, 22, 0.05, 0.12, 0.20, 10, 2.6, 60,  "critical",  74,   new Promo[]{new Promo(76, 8, 2.2)}),
        new Spec("SNK-2002", "Salted Pretzels 400g",  "Snacks",      true,  120,  1.20,  2.80,  46, -0.05, 0.22, 0.19, 6, 1.5, 150, "overstock", 41,   new Promo[]{}),
        new Spec("SNK-2003", "Dark Chocolate 90%",    "Snacks",      true,  240,  2.30,  5.20,  24, 0.09, 0.30, 0.21, 14, 3.4, 80,  "reorder",   133,  new Promo[]{}),
        new Spec("FRS-3001", "Avocado (case)",        "Fresh",       true,  12,   11.00, 19.50, 27, 0.03, 0.40, 0.24, 2,  0.6, 40,  "spoil",     4,    new Promo[]{}),
        new Spec("FRS-3002", "Free-Range Eggs (30)",  "Fresh",       true,  21,   4.80,  8.90,  39, 0.01, 0.26, 0.14, 3,  0.7, 90,  "healthy",   11,   new Promo[]{}),
        new Spec("FRS-3003", "Greek Yoghurt 1kg",     "Fresh",       true,  24,   3.40,  6.10,  33, 0.06, 0.21, 0.17, 4,  1.0, 100, "critical",  7,    new Promo[]{}),
        new Spec("HHD-4001", "Laundry Pods 60ct",     "Household",   false, null, 12.50, 21.00, 16, 0.02, 0.10, 0.22, 18, 4.5, 40,  "critical",  null, new Promo[]{}),
        new Spec("HHD-4002", "Kitchen Roll 6pk",      "Household",   false, null, 5.60,  9.80,  21, 0.00, 0.14, 0.18, 12, 3.0, 60,  "healthy",   null, new Promo[]{}),
        new Spec("HHD-4003", "Dish Soap 750ml",       "Household",   false, null, 2.10,  4.30,  26, -0.03, 0.16, 0.20, 9, 2.2, 120, "overstock", null, new Promo[]{}),
        new Spec("ELC-5001", "USB-C Cable 2m",        "Electronics", false, null, 3.00,  11.00, 22, 0.09, 0.19, 0.24, 21, 5.5, 100, "reorder",   null, new Promo[]{new Promo(58, 7, 1.6)}),
        new Spec("ELC-5002", "Wireless Mouse",        "Electronics", false, null, 8.50,  24.00, 14, 0.04, 0.24, 0.25, 24, 6.0, 50,  "healthy",   null, new Promo[]{}),
        new Spec("ELC-5003", "Power Bank 10000mAh",   "Electronics", false, null, 14.00, 34.00, 11, 0.06, 0.20, 0.26, 28, 7.0, 30,  "critical",  null, new Promo[]{}),
        new Spec("BKY-6001", "Sourdough Loaf",        "Bakery",      true,  5,    1.90,  4.75,  64, 0.05, 0.46, 0.16, 1,  0.3, 60,  "healthy",   2,    new Promo[]{}),
        new Spec("BKY-6002", "Croissant 6pk",         "Bakery",      true,  4,    2.40,  6.20,  37, 0.07, 0.52, 0.18, 1,  0.3, 48,  "spoil",     3,    new Promo[]{}),
        new Spec("BKY-6003", "Gluten-Free Muffins",   "Bakery",      true,  7,    3.10,  7.40,  19, 0.11, 0.33, 0.23, 2,  0.5, 36,  "reorder",   5,    new Promo[]{}),
    };

    private static final String[] SUPPLIERS = {
        "Gulf Fresh Trading", "Jebel Ali Distribution", "Marina Wholesale",
        "Deira Supply Co.", "Al Quoz Logistics", "Emirates Foodstuff",
    };

    private static final double[] WEEK_SHAPE = {0.86, 0.9, 0.95, 1.02, 1.18, 1.32, 1.12};

    /* ---------------------------------------------------------------- */
    /* Generation                                                        */
    /* ---------------------------------------------------------------- */

    /**
     * <pre>
     * demand_t = max(0, round( (base + trend*t) * seasonal(t) * promo(t) * (1 + e_t) ))
     * </pre>
     * with e_t ~ N(0, noise^2). The AI layer never sees these parameters — it
     * only sees the resulting series, so recovering the signal is a genuine
     * estimation problem rather than a lookup.
     */
    private static int[] generateHistory(Spec spec, Mulberry32 rng, int days) {
        int[] series = new int[days];
        for (int t = 0; t < days; t++) {
            double level = spec.base() + spec.trend() * t;
            int dow = t % 7;
            double seasonal = 1 + (spec.weekly() * (WEEK_SHAPE[dow] - 1)) / 0.32;

            double promo = 1;
            for (Promo p : spec.promos()) {
                if (t >= p.start() && t < p.start() + p.length()) promo = p.lift();
            }

            double eps = rng.gaussian() * spec.noise();
            double value = level * seasonal * promo * (1 + eps);

            // Supply disruption on one electronics line: a 4-day stockout,
            // placed in training history so the anomaly detector has a
            // negative outlier to find as well as promotional spikes.
            if (spec.sku().equals("ELC-5002") && t >= 100 && t < 104) value = 0;

            series[t] = (int) Math.max(0, Math.round(value));
        }
        return series;
    }

    /**
     * Opening stock is derived from realised demand rather than hard-coded,
     * so the scenario each SKU illustrates survives a change to the demand
     * parameters. Cover targets are multiples of the replenishment lead time,
     * which is the horizon that actually matters.
     */
    private static int assignStock(Spec spec, int[] history, Integer expiryDays) {
        double recentMean = 0;
        for (int i = history.length - 28; i < history.length; i++) recentMean += history[i];
        recentMean /= 28.0;

        if ("spoil".equals(spec.scenario()) && expiryDays != null) {
            return (int) Math.round(recentMean * Math.max(1, expiryDays) * 1.55);
        }

        double coverMultiple = switch (spec.scenario()) {
            case "critical"  -> 0.45;
            case "reorder"   -> 1.15;
            case "healthy"   -> 2.4;
            case "overstock" -> 4.5;
            default          -> 2.0;
        };

        double coverDays = spec.lead() * coverMultiple + 2;
        return (int) Math.max(spec.moq() / 4.0, Math.round(recentMean * coverDays));
    }

    public static List<InventoryItem> buildInventory() {
        return buildInventory(DEFAULT_SEED, LocalDate.now());
    }

    public static List<InventoryItem> buildInventory(int seed, LocalDate today) {
        Mulberry32 rng = new Mulberry32(seed);
        List<InventoryItem> items = new ArrayList<>();

        for (int i = 0; i < CATALOGUE.length; i++) {
            Spec spec = CATALOGUE[i];
            int[] history = generateHistory(spec, rng, HISTORY_DAYS);
            int quantity = assignStock(spec, history, spec.expiryIn());
            String supplier = SUPPLIERS[i % SUPPLIERS.length];
            int id = 1001 + i;

            if (spec.perishable()) {
                items.add(new PerishableItem(id, spec.sku(), spec.name(), spec.category(),
                        quantity, spec.price(), spec.cost(), supplier, spec.lead(),
                        spec.leadSigma(), spec.moq(), history,
                        spec.shelfLife(), today.plusDays(spec.expiryIn())));
            } else {
                items.add(new NonPerishableItem(id, spec.sku(), spec.name(), spec.category(),
                        quantity, spec.price(), spec.cost(), supplier, spec.lead(),
                        spec.leadSigma(), spec.moq(), history));
            }
        }
        return items;
    }
}
