/**
 * Cloudflare Worker — JSON API for the inventory system.
 *
 * Replaces backend/src/com/inventory/web/ApiServer.java route for route and
 * field for field, with Neon Postgres standing in for the in-memory
 * InventoryManager. The forecasting and policy maths is not reimplemented
 * here: it is the same web/assets/js/ai-engine.js the dashboard runs, which is
 * itself parity-tested against the Java engine.
 *
 * Request budget on the Workers free plan is 10 ms of CPU, so work is split:
 *
 *   single SKU   analysed live        ~2.3 ms measured
 *   aggregates   read analysis_cache  no engine work at all
 *
 * Anything that is not /api/* is served from ./web by the assets binding,
 * before this script is invoked.
 */

import engine from '../web/assets/js/ai-engine.js';

import {
  abcIndex,
  accuracyRow,
  anomalyRows,
  analyseOne,
  expiryRow,
  forCache,
  itemJson,
  replenishmentRow,
} from './analysis.mjs';
import { connect, loadInventory, loadItem, totalRevenue } from './repository.mjs';

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });

/** Thrown by handlers to produce a specific status rather than a bare 500. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = (sku) => new HttpError(404, `No item with SKU '${sku}'`);

/** Parse and bounds-check an integer query parameter. */
function intParam(url, name, { required = false, min, max, fallback } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') {
    if (required) throw new HttpError(400, `Missing required parameter '${name}'`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HttpError(400, `Parameter '${name}' must be an integer, got '${raw}'`);
  }
  if (min !== undefined && value < min) throw new HttpError(400, `'${name}' must be >= ${min}`);
  if (max !== undefined && value > max) throw new HttpError(400, `'${name}' must be <= ${max}`);
  return value;
}

/** Read the cached analysis rows, highest risk first. */
async function cachedAnalyses(sql) {
  const rows = await sql`
    SELECT c.sku, c.analysis, c.risk_score, c.abc, c.computed_at,
           i.name, i.quantity, i.lead_time_days, i.expiry_date
    FROM analysis_cache c
    JOIN items i USING (sku)
    ORDER BY c.risk_score DESC
  `;
  if (rows.length === 0) {
    throw new HttpError(
      503,
      'analysis_cache is empty. Run `npm run db:seed` then `npm run db:refresh`.'
    );
  }
  return rows;
}

const expiryIso = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value === null ? null : String(value).slice(0, 10);

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Route table, matched before any database work happens.
 *
 * Matching first matters: connecting on every request meant an unknown path
 * reported a database error instead of a 404, and it opened a connection for
 * requests that never needed one.
 */
const ROUTES = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/items$/, listItems],
  ['GET', /^\/api\/items\/(.+)$/, getItem],
  ['GET', /^\/api\/analysis$/, listAnalysis],
  ['GET', /^\/api\/analysis\/(.+)$/, getAnalysis],
  ['GET', /^\/api\/forecast\/(.+)$/, getForecast],
  ['GET', /^\/api\/replenishment$/, listReplenishment],
  ['GET', /^\/api\/expiry$/, listExpiry],
  ['GET', /^\/api\/anomalies$/, listAnomalies],
  ['GET', /^\/api\/accuracy$/, listAccuracy],
  ['POST', /^\/api\/buy$/, (ctx) => recordMovement(ctx, 'buy')],
  ['POST', /^\/api\/restock$/, (ctx) => recordMovement(ctx, 'restock')],
];

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  let pathMatched = false;
  for (const [method, pattern, handler] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (request.method !== method) continue;

    if (!env.DATABASE_URL) {
      throw new HttpError(
        503,
        'DATABASE_URL is not configured. Set it with: npx wrangler secret put DATABASE_URL'
      );
    }
    return handler({
      sql: connect(env),
      url,
      request,
      // First capture group, percent-decoded — the SKU for every route that has one.
      param: match[1] ? decodeURIComponent(match[1]) : undefined,
    });
  }

  if (pathMatched) {
    throw new HttpError(405, `${request.method} is not allowed on ${pathname}`);
  }
  throw new HttpError(404, `No route for ${request.method} ${pathname}`);
}

async function health({ sql }) {
  const [row] = await sql`SELECT count(*)::int AS skus FROM items`;
  const [cache] = await sql`
    SELECT count(*)::int AS rows, max(computed_at) AS computed_at FROM analysis_cache
  `;
  return json({
    status: 'ok',
    skus: row.skus,
    analysisCached: cache.rows,
    analysisComputedAt: cache.computed_at,
    totalRevenue: await totalRevenue(sql),
    engine: 'ai-engine.js (shared with the dashboard)',
  });
}

async function listItems({ sql }) {
  const inventory = await loadInventory(sql);
  return json(inventory.map(itemJson));
}

async function getItem({ sql, param: sku }) {
  const item = await loadItem(sql, sku);
  if (!item) throw notFound(sku);
  return json(itemJson(item));
}

// Aggregate: served from analysis_cache, never computed here.
async function listAnalysis({ sql }) {
  const rows = await cachedAnalyses(sql);
  return json(
    rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      riskScore: r.risk_score,
      abc: r.abc,
      computedAt: r.computed_at,
      ...r.analysis,
    }))
  );
}

// Single SKU: analysed live, so it reflects stock changes immediately.
async function getAnalysis({ sql, url, param: sku }) {
  const inventory = await loadInventory(sql);
  const item = inventory.find((i) => i.sku === sku);
  if (!item) throw notFound(sku);

  const analysis = analyseOne(item, inventory, {
    serviceLevel: Number(url.searchParams.get('service')) || undefined,
  });
  return json({ item: itemJson(item), ...forCache(analysis), live: true });
}

async function getForecast({ sql, url, param: sku }) {
  const horizon = intParam(url, 'horizon', { min: 1, max: 90, fallback: 14 });
  const item = await loadItem(sql, sku);
  if (!item) throw notFound(sku);

  const fc = engine.forecast(item.history, horizon);
  return json({
    sku: item.sku,
    name: item.name,
    horizon,
    point: fc.point,
    lower: fc.lower,
    upper: fc.upper,
    sigma: fc.sigma,
    confidence: fc.confidence,
    cumulative: fc.cumulative,
    dailyMean: fc.dailyMean,
    dailySigma: fc.dailySigma,
    params: fc.params,
  });
}

async function listReplenishment({ sql }) {
  const rows = await cachedAnalyses(sql);
  return json(
    rows.map((r) =>
      replenishmentRow(r.sku, r.name, r.quantity, r.lead_time_days, r.analysis.policy)
    )
  );
}

async function listExpiry({ sql }) {
  const rows = await cachedAnalyses(sql);
  return json(
    rows
      .filter((r) => r.analysis.expiry)
      .map((r) =>
        expiryRow(r.sku, r.name, r.quantity, expiryIso(r.expiry_date), r.analysis.expiry)
      )
  );
}

async function listAnomalies({ sql }) {
  const rows = await cachedAnalyses(sql);
  return json(rows.flatMap((r) => anomalyRows(r.sku, r.name, r.analysis.anomalies)));
}

async function listAccuracy({ sql }) {
  const rows = await cachedAnalyses(sql);
  return json(rows.map((r) => accuracyRow(r.sku, r.name, r.analysis.backtest)));
}

/* ------------------------------------------------------------------ */
/* Stock movements                                                     */
/* ------------------------------------------------------------------ */

/**
 * Apply a buy or restock and refresh that SKU's cached analysis.
 *
 * The stock change is a single conditional UPDATE rather than a read followed
 * by a write, so two concurrent buys cannot both pass a "do we have enough?"
 * check and oversell. A zero-row result means either an unknown SKU or
 * insufficient stock, which the follow-up lookup tells apart.
 */
async function recordMovement({ sql, url }, kind) {
  const sku = url.searchParams.get('sku');
  if (!sku) throw new HttpError(400, "Missing required parameter 'sku'");
  const qty = intParam(url, 'qty', { required: true, min: 1, max: 1_000_000 });

  const updated =
    kind === 'buy'
      ? await sql`
          UPDATE items
          SET quantity = quantity - ${qty}, updated_at = now()
          WHERE sku = ${sku} AND quantity >= ${qty}
          RETURNING quantity, price, name
        `
      : await sql`
          UPDATE items
          SET quantity = quantity + ${qty}, updated_at = now()
          WHERE sku = ${sku}
          RETURNING quantity, unit_cost AS price, name
        `;

  if (updated.length === 0) {
    const [existing] = await sql`SELECT quantity FROM items WHERE sku = ${sku}`;
    if (!existing) throw notFound(sku);
    throw new HttpError(
      409,
      `Insufficient stock for '${sku}': requested ${qty}, available ${existing.quantity}`
    );
  }

  const row = updated[0];
  const unitAmount = Number(row.price);
  const total = unitAmount * qty;

  await sql`
    INSERT INTO transactions (sku, kind, quantity, unit_amount, total_amount)
    VALUES (${sku}, ${kind}, ${qty}, ${unitAmount}, ${total})
  `;
  // Only a sale moves revenue; a restock is a cost, recorded in the ledger only.
  if (kind === 'buy') {
    await sql`UPDATE owner SET total_revenue = total_revenue + ${total} WHERE id = 1`;
  }

  // Stock changed, so this SKU's cached policy and risk are stale. One SKU is
  // ~2.3 ms of CPU, which fits the budget; the other rows are untouched.
  const inventory = await loadInventory(sql);
  const item = inventory.find((i) => i.sku === sku);
  const analysis = engine.analyseItem(item, abcIndex(inventory).get(sku));
  await sql`
    UPDATE analysis_cache
    SET analysis = ${JSON.stringify(forCache(analysis))},
        risk_score = ${analysis.riskScore},
        abc = ${analysis.abc},
        computed_at = now()
    WHERE sku = ${sku}
  `;

  return json(
    kind === 'buy'
      ? {
          sku,
          name: row.name,
          unitsSold: qty,
          revenue: total,
          remaining: row.quantity,
          totalRevenue: await totalRevenue(sql),
          riskScore: analysis.riskScore,
        }
      : {
          sku,
          name: row.name,
          added: qty,
          cost: total,
          onHand: row.quantity,
          riskScore: analysis.riskScore,
          shouldReorder: analysis.policy.shouldReorder,
        }
  );
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Static assets are matched by the runtime before the Worker runs, so
    // reaching here with a non-API path means the file does not exist.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : json({ error: 'Not found' }, 404);
    }

    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      // Surface the message but not a stack trace.
      console.error('Unhandled error:', error);
      return json({ error: error.message ?? 'Internal error' }, 500);
    }
  },
};
