-- Neon Postgres schema for the inventory system.
--
-- Mirrors the Java domain model in backend/src/com/inventory/model:
-- InventoryItem is one table with a `perishable` discriminator rather than a
-- table per subclass — the subclasses differ only by two nullable columns, so
-- single-table inheritance keeps every read a single-table scan and stays well
-- inside Neon's free-tier storage.
--
-- Apply with:  npm run db:migrate

CREATE TABLE IF NOT EXISTS items (
    id                integer       PRIMARY KEY,
    sku               text          NOT NULL UNIQUE,
    name              text          NOT NULL,
    category          text          NOT NULL,
    quantity          integer       NOT NULL CHECK (quantity >= 0),
    price             numeric(10,2) NOT NULL CHECK (price >= 0),
    unit_cost         numeric(10,2) NOT NULL CHECK (unit_cost >= 0),
    supplier          text          NOT NULL,
    lead_time_days    integer       NOT NULL CHECK (lead_time_days > 0),
    lead_time_sigma   numeric(6,2)  NOT NULL CHECK (lead_time_sigma >= 0),
    moq               integer       NOT NULL CHECK (moq > 0),
    perishable        boolean       NOT NULL DEFAULT false,
    -- Only meaningful when perishable; enforced below so a non-perishable row
    -- can never carry a shelf life.
    shelf_life_days   integer       CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
    expiry_date       date,
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT perishable_has_shelf_life CHECK (
        (perishable AND shelf_life_days IS NOT NULL)
        OR (NOT perishable AND shelf_life_days IS NULL AND expiry_date IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items (category);
CREATE INDEX IF NOT EXISTS idx_items_expiry   ON items (expiry_date)
    WHERE expiry_date IS NOT NULL;

-- Daily units sold, oldest day = 0. Kept as rows rather than an array so the
-- series can be extended a day at a time and queried by window.
CREATE TABLE IF NOT EXISTS demand_history (
    sku    text    NOT NULL REFERENCES items (sku) ON DELETE CASCADE,
    day    integer NOT NULL CHECK (day >= 0),
    units  integer NOT NULL CHECK (units >= 0),
    PRIMARY KEY (sku, day)
);

-- Single-row table holding the owner's running revenue, replacing the
-- in-memory counter on the Java InventoryManager.
CREATE TABLE IF NOT EXISTS owner (
    id             integer       PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    username       text          NOT NULL DEFAULT 'owner',
    total_revenue  numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_revenue >= 0)
);

INSERT INTO owner (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Append-only ledger of every buy/restock, so stock movements are auditable
-- instead of vanishing into a mutated quantity.
CREATE TABLE IF NOT EXISTS transactions (
    id            bigserial     PRIMARY KEY,
    sku           text          NOT NULL REFERENCES items (sku) ON DELETE CASCADE,
    kind          text          NOT NULL CHECK (kind IN ('buy', 'restock')),
    quantity      integer       NOT NULL CHECK (quantity > 0),
    unit_amount   numeric(10,2) NOT NULL,
    total_amount  numeric(12,2) NOT NULL,
    created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_sku_time
    ON transactions (sku, created_at DESC);
