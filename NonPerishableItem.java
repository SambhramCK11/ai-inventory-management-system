package com.inventory.model;

/** An item with no shelf life. */
public class NonPerishableItem extends InventoryItem {

    public NonPerishableItem(int id, String sku, String name, String category,
                             int quantity, double price, double unitCost,
                             String supplier, int leadTimeDays, double leadTimeSigma,
                             int moq, int[] history) {
        super(id, sku, name, category, quantity, price, unitCost,
              supplier, leadTimeDays, leadTimeSigma, moq, history);
    }

    /** Override: nothing spoils, so stock level alone governs risk. */
    @Override
    public boolean isAtRisk() { return false; }

    @Override
    public String getDetails() {
        return String.format("%s - Quantity: %d, Price: $%.2f",
                getName(), getQuantity(), getPrice());
    }

    @Override
    public boolean isPerishable() { return false; }
}
