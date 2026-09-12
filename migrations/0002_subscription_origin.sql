-- Namespace: plugin_webpush_7d3a6286ba (see 0001 for how it is derived).

-- The registering browser's origin, captured at subscribe time. It is used as
-- the VAPID `sub` claim when it is an https origin (push services reject http
-- subjects), so no operator-configured address is required for the common case.
ALTER TABLE plugin_webpush_7d3a6286ba.push_subscription
  ADD COLUMN IF NOT EXISTS origin text;
