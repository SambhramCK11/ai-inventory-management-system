package com.inventory.model;

import com.inventory.exception.InsufficientStockException;

/**
 * Abstract base class for every stocked article.
 *
 * This is the class from the original OOP assignment, carried forward with
 * the fields the AI layer needs (unit cost, supplier lead time and its
 * variance, minimum order quantity, demand history). The two abstract methods
 * are the contract subclasses must satisfy: {@link #getDetails()} for display
 * and {@link #isAtRisk()} for the subclass-specific notion of risk that the
 * base class cannot know about.
 *
 * Encapsulation is real here, not decorative: quantity is private and can only
 * move through {@link #purchase(int)} and {@link #restock(int)}, both of which
 * validate. There is no setter that lets a caller put the stock level into a
 * state the class would reject.
 */
public abstract class InventoryItem {

    private final int id;
    private final String sku;
    private final String name;
    private final String category;
    private final double price;
    private final double unitCost;
    private final String supplier;
    private final int leadTimeDays;
    private final double leadTimeSigma;
    private final int moq;
    private final int[] history;

    private int quantity;

    protected InventoryItem(int id, String sku, String name, String category,
                            int quantity, double price, double unitCost,
                            String supplier, int leadTimeDays, double leadTimeSigma,
                            int moq, int[] history) {
        if (quantity < 0) throw new IllegalArgumentException("Quantity cannot be negative");
        if (price < 0 || unitCost < 0) throw new IllegalArgumentException("Prices cannot be negative");
        this.id = id;
        this.sku = sku;
        this.name = name;
        this.category = category;
        this.quantity = quantity;
        this.price = price;
        this.unitCost = unitCost;
        this.supplier = supplier;
        this.leadTimeDays = leadTimeDays;
        this.leadTimeSigma = leadTimeSigma;
        this.moq = moq;
        this.history = history;
    }

    /* ---------------- accessors ---------------- */

    public int getId()              { return id; }
    public String getSku()          { return sku; }
    public String getName()         { return name; }
    public String getCategory()     { return category; }
    public int getQuantity()        { return quantity; }
    public double getPrice()        { return price; }
    public double getUnitCost()     { return unitCost; }
    public String getSupplier()     { return supplier; }
    public int getLeadTimeDays()    { return leadTimeDays; }
    public double getLeadTimeSigma(){ return leadTimeSigma; }
    public int getMoq()             { return moq; }

    /** Defensive copy — callers must not be able to rewrite sales history. */
    public int[] getHistory()       { return history.clone(); }

    public double getMarginPerUnit() { return price - unitCost; }
    public double getStockValue()    { return quantity * unitCost; }

    /* ---------------- derived figures ---------------- */

    /** Units sold over the trailing {@code n} days. */
    public int unitsSold(int n) {
        int from = Math.max(0, history.length - n);
        int total = 0;
        for (int i = from; i < history.length; i++) total += history[i];
        return total;
    }

    public double revenue(int n) { return unitsSold(n) * price; }
    public double profit(int n)  { return unitsSold(n) * getMarginPerUnit(); }

    /* ---------------- mutations ---------------- */

    /**
     * Sells {@code units} and returns the revenue taken.
     *
     * @throws InsufficientStockException when the request exceeds stock. The
     *         original version printed to stdout and returned false; an
     *         exception is used instead so a caller cannot ignore the failure
     *         by forgetting to check a return value.
     */
    public double purchase(int units) {
        if (units <= 0) throw new IllegalArgumentException("Quantity must be positive");
        if (units > quantity) throw new InsufficientStockException(name, units, quantity);
        quantity -= units;
        return units * price;
    }

    public void restock(int units) {
        if (units <= 0) throw new IllegalArgumentException("Quantity must be positive");
        quantity += units;
    }

    /* ---------------- abstract contract ---------------- */

    public abstract String getDetails();

    /** Subclass-specific risk, beyond the plain stock level. */
    public abstract boolean isAtRisk();

    public abstract boolean isPerishable();

    @Override
    public String toString() { return getDetails(); }
}
