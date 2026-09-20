/**
 * Recompute analysis_cache for every SKU.
 *
 * Runs under Node, where the ~60 ms full pass costs nothing, so the Worker
 * never has to do it. Re-run after changing demand history, and any time the
 * cached figures look stale.
 *
 *   npm run db:refresh
 */

import { neon } from '@neondatabase/serverless';

import { databaseUrl } from './db.mjs';
import { abcIndex, forCache } from '../worker/analysis.mjs';
import { loadInventory } from '../worker/repository.mjs';
import engine from '../web/assets/js/ai-engine.js';

const sql = neon(databaseUrl());
const inventory = await loadInventory(sql);

if (inventory.length === 0) {
  console.error('No items in the database. Run `npm run db:seed` first.');
  process.exit(1);
}

console.log(`Recomputing analysis for ${inventory.length} SKU(s)...`);
const started = Date.now();
const abc = abcIndex(inventory);

for (const item of inventory) {
  const analysis = engine.analyseItem(item, abc.get(item.sku));
  await sql`
    INSERT INTO analysis_cache (sku, analysis, risk_score, abc, computed_at)
    VALUES (${item.sku}, ${JSON.stringify(forCache(analysis))}, ${analysis.riskScore},
            ${analysis.abc}, now())
    ON CONFLICT (sku) DO UPDATE SET
      analysis    = EXCLUDED.analysis,
      risk_score  = EXCLUDED.risk_score,
      abc         = EXCLUDED.abc,
      computed_at = now()
  `;
  console.log(
    `  ${item.sku.padEnd(10)} ${analysis.abc}  risk ${String(analysis.riskScore).padStart(3)}` +
      `  reorder=${analysis.policy.shouldReorder}`
  );
}

console.log(`\nRefreshed ${inventory.length} row(s) in ${Date.now() - started} ms.`);
