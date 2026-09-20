package com.inventory.model;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/**
 * An item whose stock has a shelf life. Adds the expiry date the base class
 * knows nothing about, and overrides both abstract methods accordingly.
 */
public class PerishableItem extends InventoryItem {

    private final int shelfLifeDays;
    private final LocalDate expiryDate;

    public PerishableItem(int id, String sku, String name, String category,
                          int quantity, double price, double unitCost,
                          String supplier, int leadTimeDays, double leadTimeSigma,
                          int moq, int[] history,
                          int shelfLifeDays, LocalDate expiryDate) {
        super(id, sku, name, category, quantity, price, unitCost,
              supplier, leadTimeDays, leadTimeSigma, moq, history);
        this.shelfLifeDays = shelfLifeDays;
        this.expiryDate = expiryDate;
    }

    public int getShelfLifeDays()     { return shelfLifeDays; }
    public LocalDate getExpiryDate()  { return expiryDate; }

    public long daysToExpiry() { return daysToExpiry(LocalDate.now()); }

    public long daysToExpiry(LocalDate asOf) {
        return ChronoUnit.DAYS.between(asOf, expiryDate);
    }

    public boolean isExpired()               { return isExpired(LocalDate.now()); }
    public boolean isExpired(LocalDate asOf) { return daysToExpiry(asOf) < 0; }

    /** Override: a perishable is at risk as its batch approaches expiry. */
    @Override
    public boolean isAtRisk() { return daysToExpiry() <= 14; }

    /** Override: includes the expiry date. */
    @Override
    public String getDetails() {
        return String.format("%s - Quantity: %d, Price: $%.2f, Expires: %s",
                getName(), getQuantity(), getPrice(), expiryDate);
    }

    @Override
    public boolean isPerishable() { return true; }
}
