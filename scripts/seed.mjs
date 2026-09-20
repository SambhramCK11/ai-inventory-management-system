/**
 * Seed the Neon database from the deterministic generator in
 * web/assets/js/data.js.
 *
 * Reusing that module rather than restating the catalogue in SQL is the whole
 * point: the browser dashboard, the Java backend and the Worker API all derive
 * their numbers from the same seeded PRNG, so the rows loaded here are the same
 * rows the front end would have generated for itself.
 *
 *   npm run db:seed            # skips if items already exist
 *   npm run db:seed -- --force # truncate and reload
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { neon } from '@neondatabase/serverless';

import { ROOT, databaseUrl } from './db.mjs';

// data.js is a CommonJS module shared with the browser, so pull it in via
// require rather than converting it to ESM and breaking the <script> tags.
const require = createRequire(import.meta.url);
const { buildInventory } = require(resolve(ROOT, 'web/assets/js/data.js'));

const force = process.argv.includes('--force');
const sql = neon(databaseUrl());

const [{ count: existing }] = await sql`SELECT count(*)::int AS count FROM items`;

if (existing > 0 && !force) {
  console.log(`items already holds ${existing} row(s) — nothing to do.`);
  console.log('Re-seed from scratch with:  npm run db:seed -- --force');
  process.exit(0);
}

if (force && existing > 0) {
  console.log(`Clearing ${existing} existing item(s)...`);
  // demand_history and transactions cascade from items.
  await sql`TRUNCATE items CASCADE`;
  await sql`UPDATE owner SET total_revenue = 0 WHERE id = 1`;
}

const inventory = buildInventory();
console.log(`Seeding ${inventory.length} item(s) from the seeded generator...`);

for (const item of inventory) {
  await sql`
    INSERT INTO items (
      id, sku, name, category, quantity, price, unit_cost, supplier,
      lead_time_days, lead_time_sigma, moq, perishable, shelf_life_days, expiry_date
    ) VALUES (
      ${item.id}, ${item.sku}, ${item.name}, ${item.category}, ${item.quantity},
      ${item.price}, ${item.unitCost}, ${item.supplier}, ${item.leadTimeDays},
      ${item.leadTimeSigma}, ${item.moq}, ${item.perishable},
      ${item.shelfLifeDays}, ${item.expiryDate}
    )
    ON CONFLICT (sku) DO UPDATE SET
      quantity    = EXCLUDED.quantity,
      price       = EXCLUDED.price,
      unit_cost   = EXCLUDED.unit_cost,
      expiry_date = EXCLUDED.expiry_date,
      updated_at  = now()
  `;

  // One multi-row INSERT per SKU: 200 days each, which keeps the number of
  // round trips at one per item instead of one per day.
  const values = item.history.map((units, day) => [item.sku, day, units]);
  await sql.query(
    `INSERT INTO demand_history (sku, day, units)
     VALUES ${values.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ')}
     ON CONFLICT (sku, day) DO UPDATE SET units = EXCLUDED.units`,
    values.flat()
  );

  console.log(`  ${item.sku.padEnd(10)} qty ${String(item.quantity).padStart(5)}  ${item.history.length} days of history`);
}

const [totals] = await sql`
  SELECT (SELECT count(*)::int FROM items)          AS items,
         (SELECT count(*)::int FROM demand_history) AS history
`;
console.log(`\nSeed complete — ${totals.items} items, ${totals.history} history rows.`);
