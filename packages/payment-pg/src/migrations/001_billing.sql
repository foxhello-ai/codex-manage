CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  billing_period TEXT NOT NULL,
  duration_days INTEGER,
  purchase_enabled BOOLEAN NOT NULL DEFAULT false,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  plan_code TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  channel TEXT NOT NULL,
  client_type TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_orders_user_idx ON billing_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_orders_pending_idx ON billing_orders(user_id, plan_id, channel, expires_at)
  WHERE status IN ('pending','paying');

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider_order_no TEXT,
  provider_transaction_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL,
  qr_code_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  callback_received_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_payments_order_idx ON billing_payments(order_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_provider_transaction_idx
  ON billing_payments(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_payment_callback_logs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  order_no TEXT,
  payment_id TEXT REFERENCES billing_payments(id) ON DELETE SET NULL,
  provider_transaction_id TEXT,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  processing_status TEXT NOT NULL,
  error_code TEXT,
  raw_payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_refund_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE CASCADE,
  payment_id TEXT REFERENCES billing_payments(id) ON DELETE SET NULL,
  requested_by_admin_id TEXT,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_refund_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_fulfillment_events (
  id TEXT PRIMARY KEY,
  fulfillment_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  business_object_type TEXT NOT NULL,
  business_object_id TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
