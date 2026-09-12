-- Namespace: plugin_webpush_7d3a6286ba
--   = "plugin_" + namespaceSlug("webpush") + "_" + sha256(manifest.id "conreo.webpush")[0:10]
--
-- The host requires every migration object to carry the fully qualified schema
-- name, so it is written out literally here. `manifest.id` and
-- `database.namespaceSlug` are therefore frozen contract values.

-- Subscriptions are per board user, per browser/device, per company.
-- `endpoint` is the push service URL and is globally unique: re-subscribing the
-- same browser returns the same endpoint, so it is the natural upsert key.
CREATE TABLE IF NOT EXISTS plugin_webpush_7d3a6286ba.push_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  company_id uuid NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  label text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscription_user_company_idx
  ON plugin_webpush_7d3a6286ba.push_subscription (user_id, company_id);

-- One row per delivery attempt. Doubles as the throttle ledger (count recent
-- rows per subscription) and as the "why didn't I get that?" debugging trail.
CREATE TABLE IF NOT EXISTS plugin_webpush_7d3a6286ba.push_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES plugin_webpush_7d3a6286ba.push_subscription (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  http_status integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_delivery_subscription_created_idx
  ON plugin_webpush_7d3a6286ba.push_delivery (subscription_id, created_at DESC);

-- Exactly one VAPID keypair per instance. The public key is handed to browsers;
-- the private key signs delivery JWTs and never leaves the worker.
CREATE TABLE IF NOT EXISTS plugin_webpush_7d3a6286ba.vapid_keypair (
  id integer PRIMARY KEY DEFAULT 1,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vapid_keypair_singleton CHECK (id = 1)
);
