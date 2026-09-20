package com.inventory.web;

import java.util.Collection;
import java.util.Map;

/**
 * A minimal JSON writer.
 *
 * Hand-rolled because the whole backend has zero third-party dependencies: it
 * compiles and runs with nothing but a JDK, which means a reviewer can build
 * it in one command with no network access. The scope is deliberately small —
 * this serialises, it does not parse.
 */
public final class Json {

    private Json() {}

    public static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }

    /** Non-finite doubles are emitted as null — JSON has no NaN or Infinity. */
    public static String num(double v) {
        if (!Double.isFinite(v)) return "null";
        if (v == Math.rint(v) && Math.abs(v) < 1e15) return String.valueOf((long) v);
        return String.valueOf(Math.round(v * 1e6) / 1e6);
    }

    public static String str(String s) {
        return s == null ? "null" : "\"" + escape(s) + "\"";
    }

    public static String arr(double[] xs) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < xs.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(num(xs[i]));
        }
        return sb.append(']').toString();
    }

    public static String arr(int[] xs) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < xs.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(xs[i]);
        }
        return sb.append(']').toString();
    }

    public static String arr(Collection<String> parts) {
        return "[" + String.join(",", parts) + "]";
    }

    /** Values are treated as pre-serialised JSON fragments. */
    public static String obj(Map<String, String> fields) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> e : fields.entrySet()) {
            if (!first) sb.append(',');
            sb.append(str(e.getKey())).append(':').append(e.getValue());
            first = false;
        }
        return sb.append('}').toString();
    }
}
