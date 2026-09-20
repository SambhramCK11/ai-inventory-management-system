package com.inventory.ai;

/**
 * Statistical primitives. Deliberately no dependency on a maths library: the
 * whole point of this layer is that every number on the dashboard can be
 * traced to a formula somebody can read.
 */
public final class Stats {

    private Stats() {}

    public static double mean(double[] xs) {
        if (xs.length == 0) return 0;
        double s = 0;
        for (double x : xs) s += x;
        return s / xs.length;
    }

    public static double mean(int[] xs) {
        if (xs.length == 0) return 0;
        double s = 0;
        for (int x : xs) s += x;
        return s / xs.length;
    }

    /** Sample standard deviation (n-1 denominator). */
    public static double std(double[] xs) {
        if (xs.length < 2) return 0;
        double m = mean(xs), v = 0;
        for (double x : xs) v += (x - m) * (x - m);
        return Math.sqrt(v / (xs.length - 1));
    }

    public static double median(double[] xs) {
        if (xs.length == 0) return 0;
        double[] s = xs.clone();
        java.util.Arrays.sort(s);
        int mid = s.length / 2;
        return s.length % 2 != 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2.0;
    }

    /** Median absolute deviation, scaled to be a consistent sigma estimator. */
    public static double mad(double[] xs) {
        double med = median(xs);
        double[] dev = new double[xs.length];
        for (int i = 0; i < xs.length; i++) dev[i] = Math.abs(xs[i] - med);
        return 1.4826 * median(dev);
    }

    /**
     * Standard normal CDF via the Abramowitz &amp; Stegun 7.1.26 erf
     * approximation. Maximum absolute error about 1.5e-7.
     */
    public static double normalCdf(double z) {
        double sign = z < 0 ? -1 : 1;
        double x = Math.abs(z) / Math.sqrt(2);
        double t = 1 / (1 + 0.3275911 * x);
        double y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return 0.5 * (1 + sign * y);
    }

    /** Standard normal PDF. */
    public static double normalPdf(double x) {
        return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    }

    /**
     * Inverse standard normal CDF (Acklam's rational approximation).
     * Turns a target service level into the safety factor z.
     */
    public static double normalQuantile(double p) {
        if (p <= 0) return Double.NEGATIVE_INFINITY;
        if (p >= 1) return Double.POSITIVE_INFINITY;

        final double[] a = {-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
                             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0};
        final double[] b = {-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
                             6.680131188771972e1, -1.328068155288572e1};
        final double[] c = {-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
                            -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0};
        final double[] d = {7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
                            3.754408661907416e0};

        double pLow = 0.02425, pHigh = 1 - pLow, q, r;

        if (p < pLow) {
            q = Math.sqrt(-2 * Math.log(p));
            return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                 / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        }
        if (p > pHigh) {
            q = Math.sqrt(-2 * Math.log(1 - p));
            return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                  / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        }
        q = p - 0.5;
        r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
             / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
}
