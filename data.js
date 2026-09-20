/**
 * data.js — Domain model + deterministic synthetic data generator.
 *
 * The domain model is a direct port of the Java class hierarchy from the
 * original OOP assignment (and is mirrored again in /backend):
 *
 *   InventoryItem (abstract)
 *     |-- PerishableItem      (adds shelfLifeDays + batch expiry)
 *     |-- NonPerishableItem
 *
 * Demand history is generated from a seeded PRNG, so every run of the app
 * produces identical numbers. That matters: the forecast accuracy figures
 * shown in the UI are reproducible and can be checked against the Java
 * backend, which uses the same seed and the same algorithms.
 */

/* ------------------------------------------------------------------ */
/* Seeded PRNG (mulberry32) - deterministic across browsers and Node    */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform: standard normal from a uniform generator. */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/* Domain model                                                         */
/* ------------------------------------------------------------------ */

/**
 * Abstract base class. Encapsulates the fields every stocked article shares
 * and declares the contract subclasses must satisfy (getDetails, isAtRisk).
 */
class InventoryItem {
  constructor(spec) {
    if (new.target === InventoryItem) {
      throw new TypeError('InventoryItem is abstract and cannot be instantiated');
    }
    this.id = spec.id;
    this.sku = spec.sku;
    this.name = spec.name;
    this.category = spec.category;
    this.quantity = spec.quantity;
    this.price = spec.price;
    this.unitCost = spec.unitCost;
    this.supplier = spec.supplier;
    this.leadTimeDays = spec.leadTimeDays;
    this.leadTimeSigma = spec.leadTimeSigma;
    this.moq = spec.moq;
    this.history = spec.history; // daily units sold, oldest -> newest
  }

  get marginPerUnit() {
    return this.price - this.unitCost;
  }

  get stockValue() {
    return this.quantity * this.unitCost;
  }

  /** Units sold over the trailing n days. */
  unitsSold(n) {
    return this.history.slice(-n).reduce((a, b) => a + b, 0);
  }

  /** Revenue over the trailing n days. */
  revenue(n) {
    return this.unitsSold(n) * this.price;
  }

  /** Gross profit over the trailing n days. */
  profit(n) {
    return this.unitsSold(n) * this.marginPerUnit;
  }

  purchase(units) {
    if (units <= 0) throw new RangeError('Quantity must be positive');
    if (units > this.quantity) {
      throw new InsufficientStockError(this.name, units, this.quantity);
    }
    this.quantity -= units;
    return units * this.price;
  }

  restock(units) {
    if (units <= 0) throw new RangeError('Quantity must be positive');
    this.quantity += units;
  }

  /** @abstract */
  getDetails() {
    throw new Error('getDetails() must be overridden');
  }

  /** @abstract - subclass-specific risk flag beyond plain stock level. */
  isAtRisk() {
    throw new Error('isAtRisk() must be overridden');
  }
}

class PerishableItem extends InventoryItem {
  constructor(spec) {
    super(spec);
    this.perishable = true;
    this.shelfLifeDays = spec.shelfLifeDays;
    this.expiryDate = spec.expiryDate; // ISO date of the oldest open batch
  }

  /**
   * Whole calendar days until the batch expires.
   *
   * Compared midnight-to-midnight in local time rather than as raw
   * timestamps: "2 days left" should not silently become "1 day left" at
   * six in the evening, and Math.round absorbs the 23- and 25-hour days that
   * daylight-saving transitions produce.
   */
  daysToExpiry(asOf = new Date()) {
    const start = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const [y, m, d] = this.expiryDate.split('-').map(Number);
    const end = new Date(y, m - 1, d);
    return Math.round((end - start) / 86400000);
  }

  isExpired(asOf = new Date()) {
    return this.daysToExpiry(asOf) < 0;
  }

  /** Override - perishables are at risk when the batch is close to expiry. */
  isAtRisk() {
    return this.daysToExpiry() <= 14;
  }

  /** Override - includes the expiry date the base class knows nothing about. */
  getDetails() {
    return `${this.name} - Quantity: ${this.quantity}, Price: $${this.price.toFixed(2)}, Expires: ${this.expiryDate}`;
  }
}

class NonPerishableItem extends InventoryItem {
  constructor(spec) {
    super(spec);
    this.perishable = false;
    this.shelfLifeDays = null;
    this.expiryDate = null;
  }

  daysToExpiry() {
    return Infinity;
  }

  isExpired() {
    return false;
  }

  isAtRisk() {
    return false;
  }

  getDetails() {
    return `${this.name} - Quantity: ${this.quantity}, Price: $${this.price.toFixed(2)}`;
  }
}

/* ------------------------------------------------------------------ */
/* User-defined exceptions                                              */
/* ------------------------------------------------------------------ */

class InsufficientStockError extends Error {
  constructor(name, requested, available) {
    super(`Insufficient stock for ${name}: requested ${requested}, available ${available}`);
    this.name = 'InsufficientStockError';
    this.requested = requested;
    this.available = available;
  }
}

class ItemNotFoundError extends Error {
  constructor(key) {
    super(`No inventory item matching "${key}"`);
    this.name = 'ItemNotFoundError';
  }
}

/* ------------------------------------------------------------------ */
/* Catalogue specification                                              */
/* ------------------------------------------------------------------ */

const HORIZON_HISTORY = 200; // days of demand history generated

/**
 * Each catalogue entry declares the *latent* demand process used to generate
 * history: a base rate, a linear trend, weekly seasonality strength, noise,
 * and optional promotional windows. The AI engine never sees these
 * parameters - it only sees the resulting series, so recovering the signal
 * is a real estimation problem rather than a lookup.
 *
 * `scenario` does NOT feed the demand process. It sets the opening stock
 * level as a multiple of realised demand (see assignStock), so the catalogue
 * contains a deliberate spread of situations for the AI layer to find:
 *
 *   critical  - already below the reorder point, high stockout probability
 *   reorder   - sitting right on the reorder point
 *   healthy   - comfortably covered
 *   overstock - excess capital tied up
 *   spoil     - perishable holding more than it can sell before expiry
 *
 * Promotional windows sit in early history (days 40-90) so they are learned
 * by the model but do not contaminate the held-out backtest folds, which
 * evaluate the last third of the series.
 */
const CATALOGUE = [
  { sku: 'BEV-1001', name: 'Cold Brew Concentrate', category: 'Beverages',   perishable: true,  shelfLife: 45,   cost: 3.10,  price: 6.50,  base: 42, trend:  0.07, weekly: 0.34, noise: 0.16, lead: 5,  leadSigma: 1.4, moq: 120, scenario: 'healthy',   expiryIn: 26,   promos: [[44, 6, 1.9]] },
  { sku: 'BEV-1002', name: 'Sparkling Water 12pk',  category: 'Beverages',   perishable: false, shelfLife: null, cost: 4.20,  price: 8.00,  base: 30, trend:  0.02, weekly: 0.28, noise: 0.18, lead: 7,  leadSigma: 2.0, moq: 100, scenario: 'reorder',   expiryIn: null, promos: [] },
  { sku: 'BEV-1003', name: 'Oat Milk 1L',           category: 'Beverages',   perishable: true,  shelfLife: 30,   cost: 1.65,  price: 3.40,  base: 58, trend:  0.10, weekly: 0.18, noise: 0.15, lead: 3,  leadSigma: 0.8, moq: 200, scenario: 'spoil',     expiryIn: 9,    promos: [] },
  { sku: 'SNK-2001', name: 'Protein Bar Box',       category: 'Snacks',      perishable: true,  shelfLife: 180,  cost: 9.40,  price: 17.00, base: 22, trend:  0.05, weekly: 0.12, noise: 0.20, lead: 10, leadSigma: 2.6, moq: 60,  scenario: 'critical',  expiryIn: 74,   promos: [[76, 8, 2.2]] },
  { sku: 'SNK-2002', name: 'Salted Pretzels 400g',  category: 'Snacks',      perishable: true,  shelfLife: 120,  cost: 1.20,  price: 2.80,  base: 46, trend: -0.05, weekly: 0.22, noise: 0.19, lead: 6,  leadSigma: 1.5, moq: 150, scenario: 'overstock', expiryIn: 41,   promos: [] },
  { sku: 'SNK-2003', name: 'Dark Chocolate 90%',    category: 'Snacks',      perishable: true,  shelfLife: 240,  cost: 2.30,  price: 5.20,  base: 24, trend:  0.09, weekly: 0.30, noise: 0.21, lead: 14, leadSigma: 3.4, moq: 80,  scenario: 'reorder',   expiryIn: 133,  promos: [] },
  { sku: 'FRS-3001', name: 'Avocado (case)',        category: 'Fresh',       perishable: true,  shelfLife: 12,   cost: 11.00, price: 19.50, base: 27, trend:  0.03, weekly: 0.40, noise: 0.24, lead: 2,  leadSigma: 0.6, moq: 40,  scenario: 'spoil',     expiryIn: 4,    promos: [] },
  { sku: 'FRS-3002', name: 'Free-Range Eggs (30)',  category: 'Fresh',       perishable: true,  shelfLife: 21,   cost: 4.80,  price: 8.90,  base: 39, trend:  0.01, weekly: 0.26, noise: 0.14, lead: 3,  leadSigma: 0.7, moq: 90,  scenario: 'healthy',   expiryIn: 11,   promos: [] },
  { sku: 'FRS-3003', name: 'Greek Yoghurt 1kg',     category: 'Fresh',       perishable: true,  shelfLife: 24,   cost: 3.40,  price: 6.10,  base: 33, trend:  0.06, weekly: 0.21, noise: 0.17, lead: 4,  leadSigma: 1.0, moq: 100, scenario: 'critical',  expiryIn: 7,    promos: [] },
  { sku: 'HHD-4001', name: 'Laundry Pods 60ct',     category: 'Household',   perishable: false, shelfLife: null, cost: 12.50, price: 21.00, base: 16, trend:  0.02, weekly: 0.10, noise: 0.22, lead: 18, leadSigma: 4.5, moq: 40,  scenario: 'critical',  expiryIn: null, promos: [] },
  { sku: 'HHD-4002', name: 'Kitchen Roll 6pk',      category: 'Household',   perishable: false, shelfLife: null, cost: 5.60,  price: 9.80,  base: 21, trend:  0.00, weekly: 0.14, noise: 0.18, lead: 12, leadSigma: 3.0, moq: 60,  scenario: 'healthy',   expiryIn: null, promos: [] },
  { sku: 'HHD-4003', name: 'Dish Soap 750ml',       category: 'Household',   perishable: false, shelfLife: null, cost: 2.10,  price: 4.30,  base: 26, trend: -0.03, weekly: 0.16, noise: 0.20, lead: 9,  leadSigma: 2.2, moq: 120, scenario: 'overstock', expiryIn: null, promos: [] },
  { sku: 'ELC-5001', name: 'USB-C Cable 2m',        category: 'Electronics', perishable: false, shelfLife: null, cost: 3.00,  price: 11.00, base: 22, trend:  0.09, weekly: 0.19, noise: 0.24, lead: 21, leadSigma: 5.5, moq: 100, scenario: 'reorder',   expiryIn: null, promos: [[58, 7, 1.6]] },
  { sku: 'ELC-5002', name: 'Wireless Mouse',        category: 'Electronics', perishable: false, shelfLife: null, cost: 8.50,  price: 24.00, base: 14, trend:  0.04, weekly: 0.24, noise: 0.25, lead: 24, leadSigma: 6.0, moq: 50,  scenario: 'healthy',   expiryIn: null, promos: [] },
  { sku: 'ELC-5003', name: 'Power Bank 10000mAh',   category: 'Electronics', perishable: false, shelfLife: null, cost: 14.00, price: 34.00, base: 11, trend:  0.06, weekly: 0.20, noise: 0.26, lead: 28, leadSigma: 7.0, moq: 30,  scenario: 'critical',  expiryIn: null, promos: [] },
  { sku: 'BKY-6001', name: 'Sourdough Loaf',        category: 'Bakery',      perishable: true,  shelfLife: 5,    cost: 1.90,  price: 4.75,  base: 64, trend:  0.05, weekly: 0.46, noise: 0.16, lead: 1,  leadSigma: 0.3, moq: 60,  scenario: 'healthy',   expiryIn: 2,    promos: [] },
  { sku: 'BKY-6002', name: 'Croissant 6pk',         category: 'Bakery',      perishable: true,  shelfLife: 4,    cost: 2.40,  price: 6.20,  base: 37, trend:  0.07, weekly: 0.52, noise: 0.18, lead: 1,  leadSigma: 0.3, moq: 48,  scenario: 'spoil',     expiryIn: 3,    promos: [] },
  { sku: 'BKY-6003', name: 'Gluten-Free Muffins',   category: 'Bakery',      perishable: true,  shelfLife: 7,    cost: 3.10,  price: 7.40,  base: 19, trend:  0.11, weekly: 0.33, noise: 0.23, lead: 2,  leadSigma: 0.5, moq: 36,  scenario: 'reorder',   expiryIn: 5,    promos: [] },
];

const SUPPLIERS = [
  'Gulf Fresh Trading', 'Jebel Ali Distribution', 'Marina Wholesale',
  'Deira Supply Co.', 'Al Quoz Logistics', 'Emirates Foodstuff',
];

/* ------------------------------------------------------------------ */
/* Generator                                                            */
/* ------------------------------------------------------------------ */

/**
 * Generates a demand series from a latent process:
 *
 *   demand_t = max(0, round( (base + trend*t) * seasonal(t) * promo(t) * (1 + e_t) ))
 *
 * with e_t ~ N(0, noise^2). Promotions are multiplicative windows; one SKU
 * also receives a supply disruption (a run of zero-sales days) so the anomaly
 * detector has both positive and negative outliers to find.
 */
function generateHistory(spec, rng, days = HORIZON_HISTORY) {
  const series = [];
  // Weekly profile: multipliers by day index, peaking at the weekend.
  const weekShape = [0.86, 0.9, 0.95, 1.02, 1.18, 1.32, 1.12];

  for (let t = 0; t < days; t++) {
    const level = spec.base + spec.trend * t;
    const dow = t % 7;
    const seasonal = 1 + (spec.weekly * (weekShape[dow] - 1)) / 0.32;

    let promo = 1;
    for (const [start, length, lift] of spec.promos) {
      if (t >= start && t < start + length) promo = lift;
    }

    const eps = gaussian(rng) * spec.noise;
    let value = level * seasonal * promo * (1 + eps);

    // Supply disruption on one electronics line: a 4-day stockout, placed in
    // training history so the anomaly detector has a negative outlier to find.
    if (spec.sku === 'ELC-5002' && t >= 100 && t < 104) value = 0;

    series.push(Math.max(0, Math.round(value)));
  }
  return series;
}

/**
 * Local calendar date, n days from today, as YYYY-MM-DD.
 *
 * Built from the local date components rather than via toISOString(), which
 * converts to UTC and therefore returns the PREVIOUS day for any viewer whose
 * timezone is ahead of UTC — a bug that silently made every expiry date one
 * day early east of Greenwich. The Java generator uses LocalDate.plusDays and
 * has no equivalent trap, which is how the discrepancy was found.
 */
function isoDaysFromNow(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Opening stock is derived from REALISED demand rather than hard-coded, so
 * the scenario each SKU is meant to illustrate survives any change to the
 * demand parameters. Cover targets are expressed as multiples of the
 * replenishment lead time, which is the horizon that actually matters:
 * an item with a 28-day lead time needs far more cover than a daily bakery
 * line, at the same number of units sold per day.
 */
function assignStock(spec, history, expiryDays) {
  const recentMean = history.slice(-28).reduce((a, b) => a + b, 0) / 28;

  // A perishable staged to spoil is sized against its remaining shelf life,
  // not its lead time: it holds ~55% more than it can sell before expiry.
  if (spec.scenario === 'spoil' && expiryDays != null) {
    return Math.round(recentMean * Math.max(1, expiryDays) * 1.55);
  }

  const coverMultiple = {
    critical: 0.45,
    reorder: 1.15,
    healthy: 2.4,
    overstock: 4.5,
    spoil: 2.0,
  }[spec.scenario] ?? 2.0;

  // +2 days of buffer keeps very short lead times (bakery, lead = 1) from
  // collapsing to a couple of units.
  const coverDays = spec.lead * coverMultiple + 2;
  return Math.max(spec.moq / 4, Math.round(recentMean * coverDays));
}

/**
 * Builds the full catalogue. Seed is fixed so the dashboard is reproducible.
 */
function buildInventory(seed = 20260919) {
  const rng = mulberry32(seed);
  return CATALOGUE.map((spec, i) => {
    const history = generateHistory(spec, rng, HORIZON_HISTORY);
    const quantity = assignStock(spec, history, spec.expiryIn);
    const base = {
      id: 1001 + i,
      sku: spec.sku,
      name: spec.name,
      category: spec.category,
      quantity,
      price: spec.price,
      unitCost: spec.cost,
      supplier: SUPPLIERS[i % SUPPLIERS.length],
      leadTimeDays: spec.lead,
      leadTimeSigma: spec.leadSigma,
      moq: spec.moq,
      history,
    };
    return spec.perishable
      ? new PerishableItem({ ...base, shelfLifeDays: spec.shelfLife, expiryDate: isoDaysFromNow(spec.expiryIn) })
      : new NonPerishableItem(base);
  });
}

/* ------------------------------------------------------------------ */
/* Export for both browser and Node (the test harness runs under Node)  */
/* ------------------------------------------------------------------ */

const DataModule = {
  mulberry32,
  gaussian,
  InventoryItem,
  PerishableItem,
  NonPerishableItem,
  InsufficientStockError,
  ItemNotFoundError,
  buildInventory,
  assignStock,
  CATALOGUE,
  HORIZON_HISTORY,
};

if (typeof module !== 'undefined' && module.exports) module.exports = DataModule;
if (typeof window !== 'undefined') Object.assign(window, DataModule);
