#!/usr/bin/env bash
#
# Assemble the artifact that gets copied to a remote Paperclip instance.
#
# The bundle is `dist/` + `migrations/` + the package manifest + a flat
# production `node_modules`. Dependencies have to travel with the plugin because
# `web-push` is resolved at runtime: bundling it exits the forked worker at
# startup, so it can never be inlined into dist/worker.js.
#
# Usage: ./scripts/bundle-deploy.sh [target-dir]   (default: .cache/deploy-webpush)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolve to an absolute path: a relative target is easy to misread later, and a
# stale bundle elsewhere in the tree is worse than no bundle at all.
TARGET="$(cd "$ROOT" && mkdir -p "$(dirname "${1:-.cache/deploy-webpush}")" && cd "$(dirname "${1:-.cache/deploy-webpush}")" && pwd)/$(basename "${1:-.cache/deploy-webpush}")"

echo "==> building"
(cd "$ROOT" && pnpm build)

echo "==> staging into $TARGET"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$ROOT/dist" "$TARGET/dist"
cp -r "$ROOT/migrations" "$TARGET/migrations"
cp "$ROOT/package.json" "$TARGET/package.json"

cat > "$TARGET/package.json" <<'JSON'
{
  "name": "paperclip-plugin-webpush",
  "version": "0.9.0",
  "type": "module",
  "private": true,
  "description": "Desktop and Android Web Push notifications for Paperclip board events.",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "dependencies": {
    "web-push": "^3.6.7"
  }
}
JSON

# The authoring machine's umask must not decide whether the target instance can
# read the bundle: a 600 package.json installs fine as root and fails as soon as
# the server runs as a non-root user.
chmod -R a+rX "$TARGET"

echo "==> installing production dependencies (flat, no symlinks)"
# A flat tree keeps the copy portable: pnpm's store symlinks would not survive a
# `docker cp` into an instance that has no matching store.
(cd "$TARGET" && npm install --omit=dev --no-audit --no-fund)

chmod -R a+rX "$TARGET"

echo
echo "bundle ready: $TARGET"
du -sh "$TARGET" 2>/dev/null || true
echo
echo "install it on the target instance with:"
echo "  docker cp $TARGET \$(docker ps -q -f name=server):/paperclip/plugins/webpush"
echo "  paperclipai plugin install /paperclip/plugins/webpush --api-base <instance-url>"
