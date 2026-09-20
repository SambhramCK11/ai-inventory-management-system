/**
 * Neon data access for the Worker.
 *
 * The AI engine in web/assets/js/ai-engine.js operates on real InventoryItem
 * instances — it reads getters (marginPerUnit, stockValue) and calls methods
 * (unitsSold, daysToExpiry, isAtRisk). So rows coming back from Postgres are
 * rehydrated into the same PerishableItem / NonPerishableItem classes the
 * browser uses, rather than passed around as plain records. That is what keeps
 * the API's numbers identical to the dashboard's.
 */

import { neon } from '@neondatabase/serverless';

import data from '../web/assets/js/data.js';

const { PerishableItem, NonPerishableItem } = data;

/** Postgres numeric comes back as a string; the engine needs numbers. */
const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Build a connection for one request.
 *
 * `neon()` speaks SQL over HTTPS, so there is no connection pool to hold open
 * and no socket to leak between invocations — the right shape for a Worker,
 * and it keeps Neon's compute suspended between bursts, which is what keeps
 * the free tier free.
 */
export function connect(env) {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not bound. Set it with: npx wrangler secret put DATABASE_URL'
    );
  }
  return neon(env.DATABASE_URL);
}

/** Turn a joined row + its demand series into a domain object. */
function hydrate(row, history) {
  const spec = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    price: num(row.price),
    unitCost: num(row.unit_cost),
    supplier: row.supplier,
    leadTimeDays: row.lead_time_days,
    leadTimeSigma: num(row.lead_time_sigma),
    moq: row.moq,
    history,
  };

  if (!row.perishable) return new NonPerishableItem(spec);

  return new PerishableItem({
    ...spec,
    shelfLifeDays: row.shelf_life_days,
    // DATE arrives as a Date or an ISO string depending on driver version;
    // the engine's daysToExpiry() parses 'YYYY-MM-DD', so normalise to that.
    expiryDate:
      row.expiry_date instanceof Date
        ? row.expiry_date.toISOString().slice(0, 10)
        : String(row.expiry_date).slice(0, 10),
  });
}

/**
 * Load the whole catalogue with demand history attached.
 *
 * Two queries rather than a join: a join would repeat all 14 item columns
 * across 200 history rows per SKU, and the catalogue is small enough that
 * assembling the series in memory is cheaper than the wire cost.
 */
export async function loadInventory(sql) {
  const [items, history] = await Promise.all([
    sql`SELECT * FROM items ORDER BY id`,
    sql`SELECT sku, day, units FROM demand_history ORDER BY sku, day`,
  ]);

  const bySku = new Map();
  for (const row of history) {
    if (!bySku.has(row.sku)) bySku.set(row.sku, []);
    bySku.get(row.sku).push(row.units);
  }

  return items.map((row) => hydrate(row, bySku.get(row.sku) ?? []));
}

/** Load a single item, or null when the SKU is unknown. */
export async function loadItem(sql, sku) {
  const rows = await sql`SELECT * FROM items WHERE sku = ${sku}`;
  if (rows.length === 0) return null;

  const history = await sql`
    SELECT units FROM demand_history WHERE sku = ${sku} ORDER BY day
  `;
  return hydrate(rows[0], history.map((r) => r.units));
}

/** Current running revenue for the owner row. */
export async function totalRevenue(sql) {
  const [row] = await sql`SELECT total_revenue FROM owner WHERE id = 1`;
  return num(row?.total_revenue) ?? 0;
}
