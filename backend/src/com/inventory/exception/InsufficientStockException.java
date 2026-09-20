package com.inventory.exception;

/**
 * Thrown when a purchase asks for more units than are held.
 *
 * Unchecked deliberately: an over-large purchase is a caller bug or a user
 * input problem, not a recoverable condition every call site must handle.
 * The requested and available counts are carried on the exception so the UI
 * can say "only 3 left" rather than re-querying.
 */
public class InsufficientStockException extends RuntimeException {

    private final int requested;
    private final int available;

    public InsufficientStockException(String itemName, int requested, int available) {
        super(String.format("Insufficient stock for %s: requested %d, available %d",
                itemName, requested, available));
        this.requested = requested;
        this.available = available;
    }

    public int getRequested() { return requested; }
    public int getAvailable() { return available; }
}
