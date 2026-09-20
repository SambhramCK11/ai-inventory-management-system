package com.inventory.web;

import com.inventory.InventoryManager;
import com.inventory.ai.Analytics;
import com.inventory.exception.InsufficientStockException;
import com.inventory.exception.ItemNotFoundException;
import com.inventory.model.InventoryItem;
import com.inventory.model.PerishableItem;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A read-mostly JSON API over {@link InventoryManager}, built on the HTTP
 * server bundled with the JDK ({@code com.sun.net.httpserver}) so the backend
 * has no third-party dependencies at all.
 *
 * Endpoints:
 * <pre>
 *   GET  /api/health
 *   GET  /api/items
 *   GET  /api/items/{sku}
 *   GET  /api/analysis                 full AI analysis for every SKU
 *   GET  /api/analysis/{sku}
 *   GET  /api/forecast/{sku}?horizon=14
 *   GET  /api/replenishment?service=0.95
 *   GET  /api/expiry
 *   GET  /api/anomalies
 *   GET  /api/accuracy
 *   POST /api/buy?sku=BEV-1003&qty=5
 *   POST /api/restock?sku=BEV-1003&qty=200
 * </pre>
 */
public class ApiServer {

    private final InventoryManager manager;
    private final int port;

    public ApiServer(InventoryManager manager, int port) {
        this.manager = manager;
        this.port = port;
    }

    public HttpServer start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/api/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
            try {
                route(exchange, path, query);
            } catch (ItemNotFoundException e) {
                send(exchange, 404, error(e.getMessage()));
            } catch (InsufficientStockException e) {
                send(exchange, 409, error(e.getMessage()));
            } catch (IllegalArgumentException e) {
                send(exchange, 400, error(e.getMessage()));
            } catch (Exception e) {
                send(exchange, 500, error("Internal error: " + e.getClass().getSimpleName()));
            }
        });

        server.setExecutor(null);
        server.start();
        return server;
    }

    /* ---------------------------------------------------------------- */
    /* Routing                                                           */
    /* ---------------------------------------------------------------- */

    private void route(HttpExchange ex, String path, Map<String, String> q) throws IOException {
        String method = ex.getRequestMethod();

        if (path.equals("/api/health")) {
            send(ex, 200, Json.obj(Map.of(
                    "status", Json.str("ok"),
                    "skus", String.valueOf(manager.getInventory().size()),
                    "serviceLevel", Json.num(manager.getServiceLevel()))));
            return;
        }

        if (path.equals("/api/items") && method.equals("GET")) {
            List<String> rows = new ArrayList<>();
            for (InventoryItem i : manager.getInventory()) rows.add(itemJson(i));
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.startsWith("/api/items/") && method.equals("GET")) {
            InventoryItem item = manager.requireBySku(tail(path, "/api/items/"));
            send(ex, 200, itemJson(item));
            return;
        }

        if (path.equals("/api/analysis") && method.equals("GET")) {
            if (q.containsKey("service")) manager.setServiceLevel(Double.parseDouble(q.get("service")));
            List<String> rows = new ArrayList<>();
            for (Analytics.Analysis a : manager.getAnalysis()) rows.add(analysisJson(a));
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.startsWith("/api/analysis/") && method.equals("GET")) {
            String sku = tail(path, "/api/analysis/");
            Analytics.Analysis a = manager.getAnalysis(sku)
                    .orElseThrow(() -> new ItemNotFoundException(sku));
            send(ex, 200, analysisJson(a));
            return;
        }

        if (path.startsWith("/api/forecast/") && method.equals("GET")) {
            String sku = tail(path, "/api/forecast/");
            InventoryItem item = manager.requireBySku(sku);
            int horizon = Integer.parseInt(q.getOrDefault("horizon", "14"));
            if (horizon < 1 || horizon > 90) throw new IllegalArgumentException("horizon must be 1..90");
            var fc = com.inventory.ai.Forecaster.forecast(item.getHistory(), horizon);
            send(ex, 200, forecastJson(item, fc));
            return;
        }

        if (path.equals("/api/replenishment") && method.equals("GET")) {
            if (q.containsKey("service")) manager.setServiceLevel(Double.parseDouble(q.get("service")));
            List<String> rows = new ArrayList<>();
            for (Analytics.Analysis a : manager.getAnalysis()) {
                rows.add(Json.obj(ordered(
                        "sku", Json.str(a.item.getSku()),
                        "name", Json.str(a.item.getName()),
                        "onHand", String.valueOf(a.item.getQuantity()),
                        "dailyDemand", Json.num(a.policy.dBar),
                        "leadTimeDays", String.valueOf(a.item.getLeadTimeDays()),
                        "safetyStock", Json.num(a.policy.safetyStock),
                        "reorderPoint", Json.num(a.policy.reorderPoint),
                        "eoq", Json.num(a.policy.eoq),
                        "orderQty", String.valueOf(a.policy.orderQty),
                        "stockoutProb", Json.num(a.policy.stockoutProb),
                        "shouldReorder", String.valueOf(a.policy.shouldReorder))));
            }
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.equals("/api/expiry") && method.equals("GET")) {
            List<String> rows = new ArrayList<>();
            for (Analytics.Analysis a : manager.getAnalysis()) {
                if (a.expiry == null) continue;
                rows.add(Json.obj(ordered(
                        "sku", Json.str(a.item.getSku()),
                        "name", Json.str(a.item.getName()),
                        "quantity", String.valueOf(a.item.getQuantity()),
                        "expiryDate", Json.str(((PerishableItem) a.item).getExpiryDate().toString()),
                        "daysLeft", String.valueOf(a.expiry.days),
                        "forecastDemand", Json.num(a.expiry.cumulativeDemand),
                        "expectedSpoilUnits", Json.num(a.expiry.expectedSpoilUnits),
                        "writeOffValue", Json.num(a.expiry.writeOffValue),
                        "suggestedDiscountPct", Json.num(a.expiry.suggestedDiscount))));
            }
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.equals("/api/anomalies") && method.equals("GET")) {
            List<String> rows = new ArrayList<>();
            for (Analytics.Analysis a : manager.getAnalysis()) {
                for (Analytics.Anomaly an : a.anomalies.anomalies) {
                    rows.add(Json.obj(ordered(
                            "sku", Json.str(a.item.getSku()),
                            "name", Json.str(a.item.getName()),
                            "day", String.valueOf(an.day),
                            "observed", String.valueOf(an.value),
                            "expected", Json.num(an.expected),
                            "z", Json.num(an.z),
                            "direction", Json.str(an.direction))));
                }
            }
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.equals("/api/accuracy") && method.equals("GET")) {
            List<String> rows = new ArrayList<>();
            for (Analytics.Analysis a : manager.getAnalysis()) {
                rows.add(Json.obj(ordered(
                        "sku", Json.str(a.item.getSku()),
                        "name", Json.str(a.item.getName()),
                        "mape", Json.num(a.backtest.model.mape),
                        "mae", Json.num(a.backtest.model.mae),
                        "rmse", Json.num(a.backtest.model.rmse),
                        "bias", Json.num(a.backtest.model.bias),
                        "naiveMae", Json.num(a.backtest.naive.mae),
                        "seasonalNaiveMae", Json.num(a.backtest.seasonalNaive.mae),
                        "skill", Json.num(a.backtest.skill),
                        "folds", String.valueOf(a.backtest.folds))));
            }
            send(ex, 200, Json.arr(rows));
            return;
        }

        if (path.equals("/api/buy") && method.equals("POST")) {
            String sku = required(q, "sku");
            int qty = Integer.parseInt(required(q, "qty"));
            double revenue = manager.buyItem(sku, qty);
            InventoryItem item = manager.requireBySku(sku);
            send(ex, 200, Json.obj(ordered(
                    "sku", Json.str(sku),
                    "unitsSold", String.valueOf(qty),
                    "revenue", Json.num(revenue),
                    "remaining", String.valueOf(item.getQuantity()),
                    "totalRevenue", Json.num(manager.getTotalRevenue()))));
            return;
        }

        if (path.equals("/api/restock") && method.equals("POST")) {
            String sku = required(q, "sku");
            int qty = Integer.parseInt(required(q, "qty"));
            manager.restock(sku, qty);
            send(ex, 200, Json.obj(ordered(
                    "sku", Json.str(sku),
                    "added", String.valueOf(qty),
                    "onHand", String.valueOf(manager.requireBySku(sku).getQuantity()))));
            return;
        }

        send(ex, 404, error("No route for " + method + " " + path));
    }

    /* ---------------------------------------------------------------- */
    /* Serialisation                                                     */
    /* ---------------------------------------------------------------- */

    private String itemJson(InventoryItem i) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("id", String.valueOf(i.getId()));
        f.put("sku", Json.str(i.getSku()));
        f.put("name", Json.str(i.getName()));
        f.put("category", Json.str(i.getCategory()));
        f.put("quantity", String.valueOf(i.getQuantity()));
        f.put("price", Json.num(i.getPrice()));
        f.put("unitCost", Json.num(i.getUnitCost()));
        f.put("supplier", Json.str(i.getSupplier()));
        f.put("leadTimeDays", String.valueOf(i.getLeadTimeDays()));
        f.put("perishable", String.valueOf(i.isPerishable()));
        f.put("atRisk", String.valueOf(i.isAtRisk()));
        if (i instanceof PerishableItem p) {
            f.put("expiryDate", Json.str(p.getExpiryDate().toString()));
            f.put("daysToExpiry", String.valueOf(p.daysToExpiry()));
        }
        f.put("details", Json.str(i.getDetails()));
        return Json.obj(f);
    }

    private String analysisJson(Analytics.Analysis a) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("sku", Json.str(a.item.getSku()));
        f.put("name", Json.str(a.item.getName()));
        f.put("quantity", String.valueOf(a.item.getQuantity()));
        f.put("abc", Json.str(a.abc));
        f.put("riskScore", String.valueOf(a.riskScore));
        f.put("annualMargin", Json.num(a.annualMargin));
        f.put("dailyDemand", Json.num(a.forecast.dailyMean));
        f.put("forecast14d", Json.num(a.forecast.cumulativePoint));
        f.put("forecastLower", Json.num(a.forecast.cumulativeLower));
        f.put("forecastUpper", Json.num(a.forecast.cumulativeUpper));
        f.put("daysOfCover", Json.num(a.policy.daysOfCover));
        f.put("safetyStock", Json.num(a.policy.safetyStock));
        f.put("reorderPoint", Json.num(a.policy.reorderPoint));
        f.put("orderQty", String.valueOf(a.policy.orderQty));
        f.put("stockoutProb", Json.num(a.policy.stockoutProb));
        f.put("shouldReorder", String.valueOf(a.policy.shouldReorder));
        f.put("mape", Json.num(a.backtest.model.mape));
        f.put("skill", Json.num(a.backtest.skill));
        f.put("anomalyCount", String.valueOf(a.anomalies.anomalies.size()));
        if (a.expiry != null) {
            f.put("daysToExpiry", String.valueOf(a.expiry.days));
            f.put("expectedSpoilUnits", Json.num(a.expiry.expectedSpoilUnits));
            f.put("writeOffValue", Json.num(a.expiry.writeOffValue));
        }
        return Json.obj(f);
    }

    private String forecastJson(InventoryItem item, com.inventory.ai.Forecaster.Result fc) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("sku", Json.str(item.getSku()));
        f.put("name", Json.str(item.getName()));
        f.put("history", Json.arr(item.getHistory()));
        f.put("point", Json.arr(fc.point));
        f.put("lower", Json.arr(fc.lower));
        f.put("upper", Json.arr(fc.upper));
        f.put("sigma", Json.num(fc.sigma));
        f.put("alpha", Json.num(fc.alpha));
        f.put("beta", Json.num(fc.beta));
        f.put("gamma", Json.num(fc.gamma));
        f.put("cumulative", Json.obj(ordered(
                "point", Json.num(fc.cumulativePoint),
                "lower", Json.num(fc.cumulativeLower),
                "upper", Json.num(fc.cumulativeUpper))));
        return Json.obj(f);
    }

    /* ---------------------------------------------------------------- */
    /* Plumbing                                                          */
    /* ---------------------------------------------------------------- */

    private static Map<String, String> ordered(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static String tail(String path, String prefix) {
        return path.substring(prefix.length());
    }

    private static String required(Map<String, String> q, String key) {
        String v = q.get(key);
        if (v == null || v.isBlank()) throw new IllegalArgumentException("Missing required parameter: " + key);
        return v;
    }

    private static String error(String message) {
        return Json.obj(Map.of("error", Json.str(message)));
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isBlank()) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) out.put(decode(pair), "");
            else out.put(decode(pair.substring(0, eq)), decode(pair.substring(eq + 1)));
        }
        return out;
    }

    private static String decode(String s) {
        return java.net.URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        // The static front end is opened from the file system, so it has a
        // null origin; permissive CORS is appropriate for a local demo and
        // would not be in production.
        ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    /** Convenience for tests and callers that only need an Optional. */
    public Optional<InventoryManager> manager() { return Optional.of(manager); }
}
