#!/usr/bin/env bash
# deploy.sh — publish this app to Cloudflare Workers with a Neon database.
#
#   ./deploy.sh                                  # prompts for the connection string
#   DATABASE_URL='postgresql://...' ./deploy.sh   # or pass it in
#
# Needs Node 18+, a free Cloudflare account and a free Neon project.
# Safe to re-run: the migration and seed are both idempotent.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mFailed:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || fail "Node is not installed. Get it from https://nodejs.org (18 or newer)."
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 18 ] || fail "Node $MAJOR is too old; wrangler needs 18 or newer."

# ---------------------------------------------------------------- database URL

# Prefer the environment, then an existing .dev.vars, then ask.
if [ -z "${DATABASE_URL:-}" ] && [ -f .dev.vars ]; then
  DATABASE_URL="$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' .dev.vars | head -1 | tr -d '"'"'"'')"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  cat <<'PROMPT'

This app needs a Neon Postgres database (free, no card):

  1. Sign up at https://neon.tech
  2. Create a project, then add a database called "inventory"
     (Branches -> your branch -> Databases -> Add database)
  3. Copy the POOLED connection string -- the host contains "-pooler"

PROMPT
  printf 'Paste the connection string: '
  read -r DATABASE_URL
fi

case "$DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) fail "That does not look like a Postgres connection string." ;;
esac

case "$DATABASE_URL" in
  *-pooler*) ;;
  *) echo "Note: that is not the pooled host. It will work, but the pooled one (containing '-pooler') lets Neon suspend compute when idle." ;;
esac

step "Installing dependencies"
npm install --no-fund --no-audit

# .dev.vars is gitignored; it is what `wrangler dev` and the db:* scripts read.
printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > .dev.vars
echo "Wrote .dev.vars (gitignored)."

step "Creating the tables"
npm run db:migrate

step "Loading the catalogue"
npm run db:seed

step "Precomputing the analysis"
# The full pass is ~60ms of CPU, over the Workers free-plan limit of 10ms per
# request, so it runs here and the Worker reads finished rows.
npm run db:refresh

step "Checking your Cloudflare login"
if npx wrangler whoami 2>&1 | grep -q "not authenticated"; then
  echo "Opening a browser so you can authorise wrangler..."
  npx wrangler login
else
  echo "Already logged in."
fi

step "Storing the connection string as a Worker secret"
printf '%s' "$DATABASE_URL" | npx wrangler secret put DATABASE_URL

step "Deploying"
npx wrangler deploy

cat <<'DONE'

Done. The URL is printed just above, in the form:

    https://ai-inventory-management-system.<your-subdomain>.workers.dev

Check these:

    /                       the dashboard
    /api/health             should report 18 SKUs and a cache timestamp
    /api/replenishment      reorder points for every SKU
    /api/forecast/BEV-1001  a 14-day forecast

If you change the demand history later, re-run `npm run db:refresh`.
DONE
