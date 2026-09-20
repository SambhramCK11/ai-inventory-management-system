package com.inventory.exception;

/** Thrown when no item matches a supplied id, SKU or name. */
public class ItemNotFoundException extends RuntimeException {
    public ItemNotFoundException(String key) {
        super("No inventory item matching \"" + key + "\"");
    }
}
