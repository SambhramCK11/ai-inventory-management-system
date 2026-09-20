# Deploying on Cloudflare + Neon (free tier)

Two free services, no card required on either:

| Piece | Service | Free allowance | What this project uses |
|---|---|---|---|
| Dashboard (HTML/CSS/JS) | Workers static assets | unmetered, never billed | ~250 KB of assets |
| JSON API | Workers | 100,000 requests/day, 10 ms CPU/request | one Worker |
| Database | Neon Postgres | 0.5 GB storage, autosuspending compute | ~1 MB seeded |

## One-time setup

```bash
npm install
npx wrangler login
```

Create a Neon project at <https://neon.tech> and copy the **pooled**
connection string (the host contains `-pooler`).

```bash
# For local dev and the db:* scripts:
cp .dev.vars.example .dev.vars    # then paste your connection string in

# For the deployed Worker:
npx wrangler secret put DATABASE_URL
```

## Load the database

```bash
npm run db:migrate    # create tables
npm run db:seed       # load the 18-SKU catalogue + 200 days of history
npm run db:refresh    # precompute analysis_cache
```

## Run and deploy

```bash
npm run dev           # http://localhost:8787
npm run deploy        # https://ai-inventory-management-system.<subdomain>.workers.dev
```

## How the work is split, and why

A full `analyseInventory()` pass over the catalogue measures **~60 ms of CPU**.
The Workers free plan allows **10 ms per request**, so the Worker never does
that pass:

- **Single-SKU endpoints** (`/api/analysis/:sku`, `/api/forecast/:sku`) are
  computed live — measured at **2.3 ms median, 4.1 ms max** warm.
- **Aggregate endpoints** (`/api/analysis`, `/api/replenishment`, `/api/expiry`,
  `/api/anomalies`, `/api/accuracy`) read precomputed rows from
  `analysis_cache` and run no engine code at all.
- **`npm run db:refresh`** does the 60 ms pass under Node, where there is no
  CPU ceiling.
- A **buy or restock** refreshes only the affected SKU's cached row (~2.3 ms).

So after changing demand history, re-run `npm run db:refresh`. Stock changes
made through the API keep themselves current.

## API

Same paths and response fields as the Java `ApiServer`, so the two are
interchangeable.

| Method | Path | Source |
|---|---|---|
| GET | `/api/health` | live |
| GET | `/api/items` | live |
| GET | `/api/items/:sku` | live |
| GET | `/api/analysis` | cache |
| GET | `/api/analysis/:sku` | live |
| GET | `/api/forecast/:sku?horizon=1..90` | live |
| GET | `/api/replenishment` | cache |
| GET | `/api/expiry` | cache |
| GET | `/api/anomalies` | cache |
| GET | `/api/accuracy` | cache |
| POST | `/api/buy?sku=&qty=` | live |
| POST | `/api/restock?sku=&qty=` | live |

```bash
curl https://<your-worker>.workers.dev/api/health
curl https://<your-worker>.workers.dev/api/replenishment
curl -X POST "https://<your-worker>.workers.dev/api/buy?sku=BEV-1001&qty=12"
```

## Staying inside the free tier

- Neon suspends compute when idle; the HTTP driver holds no connections open,
  so nothing keeps it awake between requests.
- Static asset requests do not count against the Workers daily limit — only
  `/api/*` does.
- `analysis_cache` holds 18 rows at ~2.7 KB each. Storage is not a concern.
- There is nothing to enable that costs money. Neon's paid features
  (autoscaling, read replicas, branching beyond the free limit) stay off
  unless you turn them on.

## Automatic commits

`scripts/autocommit.sh` watches the working tree and commits + pushes once a
few lines have changed:

```bash
./scripts/autocommit.sh                  # every 3+ changed lines, checked every 15s
THRESHOLD=10 INTERVAL=60 ./scripts/autocommit.sh
NO_PUSH=1 ./scripts/autocommit.sh        # commit locally only
./scripts/autocommit.sh --once           # single pass
```

## The Java backend

`backend/` still builds and runs — it is the reference implementation the JS
engine is parity-tested against:

```bash
npm run test:backend     # javac + 82 assertions, JDK 17+
java -cp backend/out com.inventory.Main
java -cp backend/out com.inventory.Main --serve   # the original JSON API
```

It cannot run on Cloudflare (Workers execute JavaScript and WASM, not JVM
bytecode), which is why the API was ported to `worker/`. Both call the same
algorithms over the same seeded data.
