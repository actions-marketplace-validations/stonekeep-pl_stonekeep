-- Fixture: plain SQL migrations (PostgreSQL flavoured). Seed values are fake.
CREATE TABLE IF NOT EXISTS public.users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(320) NOT NULL UNIQUE,
  phone         VARCHAR(32),
  full_name     TEXT,
  is_email_public BOOLEAN DEFAULT false,
  notes         TEXT DEFAULT 'contact: ignore, this; is a literal',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);

/* Orders reference users. */
CREATE TABLE "orders" (
  "id" SERIAL NOT NULL,
  "user_id" BIGINT NOT NULL REFERENCES users(id),
  "total_cents" INTEGER NOT NULL,
  "shipping_address" TEXT,
  PRIMARY KEY ("id")
);

INSERT INTO users (email, phone, full_name)
VALUES ('jane.fixture@example.com', '+1-555-0100', 'Jane Fixture');
