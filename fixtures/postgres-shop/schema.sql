-- Fixture schema for the Stage 2 engine integration tests.
-- Covers: cascades over several levels, a self-reference, a foreign key on a
-- PII column (email), identity ALWAYS columns, a soft reference declared only
-- in stonekeep.connector.yaml, and retained invoices.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         VARCHAR(32),
  last_login_ip INET,
  date_of_birth DATE,
  manager_id    INTEGER REFERENCES users (id),
  -- External identities used by SaaS connectors (Stage 3).
  stripe_customer_id TEXT UNIQUE,
  auth0_user_id      TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  street      TEXT NOT NULL,
  postal_code VARCHAR(16),
  city        TEXT
);

CREATE TABLE products (
  sku   TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id),
  total_cents INTEGER NOT NULL,
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id       SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  sku      TEXT NOT NULL REFERENCES products (sku),
  qty      INTEGER NOT NULL
);

-- Invoices must be retained (tax law). ON DELETE CASCADE here is deliberate:
-- Stonekeep must detach invoices BEFORE deleting the user so they survive.
CREATE TABLE invoices (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users (id) ON DELETE CASCADE,
  order_id      INTEGER REFERENCES orders (id),
  billing_name  TEXT,
  billing_email TEXT,
  amount_cents  INTEGER NOT NULL,
  issued_on     DATE NOT NULL
);

CREATE TABLE invoice_lines (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices (id),
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);

-- Foreign key on a PII column; masking must keep it consistent with users.email.
CREATE TABLE login_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_email  TEXT NOT NULL REFERENCES users (email) ON UPDATE CASCADE,
  ip_address  INET NOT NULL,
  happened_at TIMESTAMPTZ NOT NULL
);

-- Soft reference: no database FK, declared in stonekeep.connector.yaml.
CREATE TABLE support_tickets (
  id           SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL,
  body         TEXT NOT NULL
);
