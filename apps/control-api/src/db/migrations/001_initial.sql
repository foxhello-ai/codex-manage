CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_type TEXT NOT NULL,
  identifier TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(identity_type, identifier)
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL,
  identifier TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_codes_lookup_idx
  ON verification_codes(identity_type, identifier, purpose, created_at DESC);
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  token_type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_subject_idx ON auth_tokens(subject_type, subject_id, token_type);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  client_version TEXT NOT NULL,
  codex_cli_version TEXT,
  origin_port INTEGER NOT NULL DEFAULT 4310,
  status TEXT NOT NULL DEFAULT 'active',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_heartbeats (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_version TEXT NOT NULL,
  tunnel_status TEXT NOT NULL,
  public_hostname TEXT,
  error_code TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_heartbeats_device_idx ON device_heartbeats(device_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  cloudflare_tunnel_id TEXT,
  cloudflare_zone_id TEXT,
  hostname TEXT NOT NULL,
  target_hostname TEXT,
  target_cloudflare_zone_id TEXT,
  status TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  last_connected_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS target_hostname TEXT;
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS cloudflare_zone_id TEXT;
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS target_cloudflare_zone_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tunnels_active_device_idx
  ON tunnels(device_id) WHERE status NOT IN ('revoked', 'deleted');

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tunnel_id TEXT REFERENCES tunnels(id) ON DELETE SET NULL,
  hostname TEXT NOT NULL,
  domain_type TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_active_hostname_idx
  ON domains(hostname) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  billing_period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL,
  entitlement_value JSONB NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlements_user_idx ON entitlements(user_id, entitlement_key);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  channel_transaction_id TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  callback_received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provisioning_jobs_ready_idx
  ON provisioning_jobs(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_configs (
  id TEXT PRIMARY KEY,
  public_api_base_url TEXT NOT NULL,
  desktop_update_feed_url TEXT NOT NULL,
  device_domain TEXT NOT NULL,
  managed_domain_suffixes JSONB NOT NULL DEFAULT '[]'::jsonb,
  admin_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  desktop_config_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  cloudflare_zone_id TEXT,
  updated_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE system_configs ADD COLUMN IF NOT EXISTS cloudflare_zone_id TEXT;

CREATE TABLE IF NOT EXISTS issue_reports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  client_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  os_version TEXT,
  channel TEXT NOT NULL DEFAULT 'stable',
  fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT,
  linked_incident_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_reports_lookup_idx
  ON issue_reports(status, level, created_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_device_idx
  ON issue_reports(device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_report_snapshots (
  id TEXT PRIMARY KEY,
  issue_report_id TEXT NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  runtime_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostic_excerpt_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  redaction_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issue_report_events (
  id TEXT PRIMARY KEY,
  issue_report_id TEXT NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_report_events_report_idx
  ON issue_report_events(issue_report_id, created_at ASC);

CREATE TABLE IF NOT EXISTS issue_report_dedup (
  fingerprint TEXT NOT NULL,
  client_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  first_report_id TEXT NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  last_report_id TEXT NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fingerprint, client_version, platform, arch)
);

INSERT INTO plans (id, code, name, description, price_cents, billing_period)
VALUES
  ('plan-free', 'free', '体验版', 'Quick Tunnel 体验通道', 0, 'none'),
  ('plan-formal', 'formal', '正式版', '固定域名 Named Tunnel', 0, 'manual')
ON CONFLICT (code) DO NOTHING;
