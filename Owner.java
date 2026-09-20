package com.inventory.model;

/**
 * Credentials for the owner role. Kept as its own class rather than a pair of
 * strings on the manager, so authentication has somewhere to live if it ever
 * grows past a string comparison.
 */
public class Owner {

    private final String username;
    private final String passwordHash;

    public Owner(String username, String password) {
        this.username = username;
        this.passwordHash = hash(password);
    }

    public String getUsername() { return username; }

    public boolean authenticate(String password) {
        return passwordHash.equals(hash(password));
    }

    /**
     * Not a real password hash. A production system needs bcrypt, scrypt or
     * Argon2 with a per-user salt; this only ensures the plaintext is not held
     * in a field, and is labelled so nobody mistakes it for security.
     */
    private static String hash(String password) {
        return Integer.toHexString(password.hashCode());
    }
}
