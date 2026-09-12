#!/usr/bin/env bash
#
# Read-only verification of an installed Web Push plugin, run ON the instance
# host. Prints the plugin's registry row, its two service-worker registrations
# are checked in the browser, and the subscription/delivery ledger straight from
# the plugin's own namespace.
#
# Usage: ./scripts/verify-install.sh [container-name] [db-container-name]
#   defaults: docker-server-1 docker-db-1

set -euo pipefail

SERVER="${1:-docker-server-1}"
DB="${2:-docker-db-1}"
NS="plugin_webpush_7d3a6286ba"

psql() { sudo docker exec "$DB" psql -U paperclip -d paperclip -t -A -F'|' -c "$1"; }

echo "== plugin registry =="
psql "select plugin_key, status, version, last_error from plugins where plugin_key = 'conreo.webpush';"

echo
echo "== namespace $NS =="
psql "select table_name from information_schema.tables where table_schema = '$NS' order by table_name;"

echo
echo "== registered devices =="
psql "select user_id, company_id, enabled, array_length(event_types, 1) as event_types, created_at from $NS.push_subscription order by created_at;"

echo
echo "== VAPID keypair present =="
psql "select count(*) as keypairs, left(public_key, 16) as public_prefix from $NS.vapid_keypair;"

echo
echo "== deliveries (most recent first) =="
psql "select created_at, event_type, status, coalesce(http_status::text, '-') as http, coalesce(left(error, 60), '-') from $NS.push_delivery order by created_at desc limit 15;"

echo
echo "== delivery totals by status =="
psql "select status, count(*) from $NS.push_delivery group by status order by status;"

echo
echo "== plugin worker process inside the container =="
sudo docker exec "$SERVER" sh -lc 'ps -o pid,etime,args -C node 2>/dev/null | grep -i plugin || echo "(no matching process)"'
