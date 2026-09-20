package com.inventory;

import com.inventory.ai.Analytics;
import com.inventory.exception.ItemNotFoundException;
import com.inventory.model.InventoryItem;
import com.inventory.model.Owner;
import com.inventory.model.PerishableItem;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * The service layer — the original {@code InventoryManager}, kept as the one
 * place that owns the item collection, with the AI analysis layered on top.
 *
 * The analysis is cached and invalidated on every mutation rather than
 * recomputed per request: a full pass over eighteen SKUs runs a grid search
 * and six backtest folds each, which is cheap enough to do on demand but
 * wasteful to repeat when nothing has changed.
 */
public class InventoryManager {

    private final List<InventoryItem> inventory = new ArrayList<>();
    private final List<Owner> owners = new ArrayList<>();
    private double totalRevenue = 0;

    private List<Analytics.Analysis> cachedAnalysis = null;
    private double serviceLevel = 0.95;

    public InventoryManager() {
        owners.add(new Owner("admin", "admin123"));
    }

    /* ---------------- authentication ---------------- */

    public boolean authenticate(String username, String password) {
        return owners.stream()
                .anyMatch(o -> o.getUsername().equals(username) && o.authenticate(password));
    }

    public void addOwner(String username, String password) {
        owners.add(new Owner(username, password));
    }

    /* ---------------- inventory CRUD ---------------- */

    /** Adds an item, merging quantities if the SKU is already stocked. */
    public void addItem(InventoryItem item) {
        Optional<InventoryItem> existing = findBySku(item.getSku());
        if (existing.isPresent()) {
            existing.get().restock(item.getQuantity());
        } else {
            inventory.add(item);
        }
        invalidate();
    }

    public void addAll(List<InventoryItem> items) {
        inventory.addAll(items);
        invalidate();
    }

    public List<InventoryItem> getInventory() {
        return List.copyOf(inventory);
    }

    public Optional<InventoryItem> findBySku(String sku) {
        return inventory.stream().filter(i -> i.getSku().equalsIgnoreCase(sku)).findFirst();
    }

    public InventoryItem requireBySku(String sku) {
        return findBySku(sku).orElseThrow(() -> new ItemNotFoundException(sku));
    }

    public Optional<InventoryItem> findByName(String name) {
        return inventory.stream().filter(i -> i.getName().equalsIgnoreCase(name)).findFirst();
    }

    public boolean removeItem(int id) {
        boolean removed = inventory.removeIf(i -> i.getId() == id);
        if (removed) invalidate();
        return removed;
    }

    /* ---------------- transactions ---------------- */

    /**
     * Sells units of an item.
     *
     * @throws ItemNotFoundException        if no such SKU is stocked
     * @throws com.inventory.exception.InsufficientStockException if stock is short
     */
    public double buyItem(String sku, int quantity) {
        InventoryItem item = requireBySku(sku);
        double revenue = item.purchase(quantity);
        totalRevenue += revenue;
        invalidate();
        return revenue;
    }

    public void restock(String sku, int quantity) {
        requireBySku(sku).restock(quantity);
        invalidate();
    }

    public double getTotalRevenue() { return totalRevenue; }

    /* ---------------- reporting (original features) ---------------- */

    /**
     * Items below a fixed unit threshold — the original low-stock report.
     * Retained for comparison: {@link #getReorderDue()} is the version that
     * accounts for how fast an item sells and how long its supplier takes,
     * and the two disagree for most of the catalogue.
     */
    public List<InventoryItem> getLowStockItems(int threshold) {
        return inventory.stream().filter(i -> i.getQuantity() < threshold).toList();
    }

    public List<PerishableItem> getExpiredItems() {
        return inventory.stream()
                .filter(i -> i instanceof PerishableItem)
                .map(i -> (PerishableItem) i)
                .filter(PerishableItem::isExpired)
                .toList();
    }

    /* ---------------- AI layer ---------------- */

    public void setServiceLevel(double serviceLevel) {
        if (serviceLevel <= 0 || serviceLevel >= 1) {
            throw new IllegalArgumentException("Service level must be strictly between 0 and 1");
        }
        this.serviceLevel = serviceLevel;
        invalidate();
    }

    public double getServiceLevel() { return serviceLevel; }

    /** Full analysis, recomputed only when the inventory has changed. */
    public List<Analytics.Analysis> getAnalysis() {
        if (cachedAnalysis == null) {
            cachedAnalysis = Analytics.analyse(inventory, serviceLevel, 14);
        }
        return cachedAnalysis;
    }

    public Optional<Analytics.Analysis> getAnalysis(String sku) {
        return getAnalysis().stream().filter(a -> a.item.getSku().equalsIgnoreCase(sku)).findFirst();
    }

    /** Items at or below their reorder point. */
    public List<Analytics.Analysis> getReorderDue() {
        return getAnalysis().stream().filter(a -> a.policy.shouldReorder).toList();
    }

    public double getTotalStockValue() {
        return inventory.stream().mapToDouble(InventoryItem::getStockValue).sum();
    }

    public double getForecastWriteOff() {
        return getAnalysis().stream()
                .filter(a -> a.expiry != null)
                .mapToDouble(a -> a.expiry.writeOffValue)
                .sum();
    }

    private void invalidate() { cachedAnalysis = null; }
}
