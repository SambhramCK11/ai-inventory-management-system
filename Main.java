package com.inventory;

import com.inventory.ai.Analytics;
import com.inventory.data.DataGenerator;
import com.inventory.web.ApiServer;

import java.util.List;

/**
 * Entry point.
 *
 * <pre>
 *   java -cp out com.inventory.Main            # prints the analysis and exits
 *   java -cp out com.inventory.Main --serve    # starts the JSON API on :8080
 *   java -cp out com.inventory.Main --serve 9000
 * </pre>
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        // The report uses non-ASCII box and bullet characters; without this
        // they render as '?' on any JVM whose default console encoding is not
        // UTF-8 (the default on Windows, and in many containers).
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out),
                true, java.nio.charset.StandardCharsets.UTF_8));

        InventoryManager manager = new InventoryManager();
        manager.addAll(DataGenerator.buildInventory());

        boolean serve = args.length > 0 && args[0].equals("--serve");
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 8080;

        if (serve) {
            new ApiServer(manager, port).start();
            System.out.printf("Inventory API listening on http://localhost:%d%n", port);
            System.out.println("Try: /api/health  /api/analysis  /api/accuracy  /api/expiry");
            Thread.currentThread().join();
        } else {
            report(manager);
        }
    }

    /** Console report — the headline numbers, so the engine can be run without a browser. */
    private static void report(InventoryManager manager) {
        List<Analytics.Analysis> analyses = manager.getAnalysis();

        System.out.println("=".repeat(96));
        System.out.println("AI INVENTORY MANAGEMENT SYSTEM — analysis report");
        System.out.println("=".repeat(96));
        System.out.printf("%d SKUs · %s of stock at cost · service level %.0f%%%n%n",
                analyses.size(), usd(manager.getTotalStockValue()), manager.getServiceLevel() * 100);

        System.out.printf("%-10s %-24s %3s %6s %7s %8s %9s %8s %7s%n",
                "SKU", "ITEM", "ABC", "RISK", "COVER", "P(OUT)", "REORDER", "MAPE", "SKILL");
        System.out.println("-".repeat(96));

        for (Analytics.Analysis a : analyses) {
            System.out.printf("%-10s %-24s %3s %6d %6.1fd %7.1f%% %9s %7.1f%% %+7.3f%n",
                    a.item.getSku(),
                    truncate(a.item.getName(), 24),
                    a.abc,
                    a.riskScore,
                    a.policy.daysOfCover,
                    a.policy.stockoutProb * 100,
                    a.policy.shouldReorder ? String.valueOf(a.policy.orderQty) : "—",
                    a.backtest.model.mape,
                    a.backtest.skill);
        }

        System.out.println("-".repeat(96));

        double meanMape = analyses.stream()
                .mapToDouble(a -> a.backtest.model.mape).filter(Double::isFinite).average().orElse(Double.NaN);
        double meanSkill = analyses.stream()
                .mapToDouble(a -> a.backtest.skill).filter(Double::isFinite).average().orElse(Double.NaN);
        long wins = analyses.stream().filter(a -> a.backtest.skill > 0).count();
        long reorder = analyses.stream().filter(a -> a.policy.shouldReorder).count();
        long anomalies = analyses.stream().mapToLong(a -> a.anomalies.anomalies.size()).sum();

        System.out.printf("Mean MAPE %.1f%%  ·  mean skill vs seasonal-naive %+.3f  ·  beats baseline %d/%d%n",
                meanMape, meanSkill, wins, analyses.size());
        System.out.printf("%d items due for reorder  ·  %s forecast write-off  ·  %d anomalies detected%n",
                reorder, usd(manager.getForecastWriteOff()), anomalies);
    }

    private static String usd(double v) {
        return String.format("$%,.0f", v);
    }

    private static String truncate(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n - 1) + "…";
    }
}
