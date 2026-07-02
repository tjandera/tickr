#!/bin/bash
# Start the Tickr Node server. Python connectors are the data tier (reached via
# scripts/data_cli.py), so the project .venv must exist.
#   PORT=3005 ./server/start.sh     # default port (serves the app)
#   PORT=3006 ./server/start.sh     # run beside a Python instance
cd "$(dirname "$0")"

# --- node_modules outside iCloud --------------------------------------------
# This project lives under ~/Documents, which iCloud Drive syncs. Reading the
# 1700+ node_modules files through iCloud's file layer takes MINUTES, and iCloud
# also deletes symlinks inside synced folders. So the real modules live outside
# iCloud and node_modules is a symlink to them. The parent must be named
# "node_modules" (Node resolves the symlink's real path for sibling lookups).
EXT_MODULES="${TICKR_NODE_MODULES:-$HOME/.agnes-modules/node_modules}"

# Recreate the symlink if iCloud removed it (or this is a fresh checkout).
if [ ! -e node_modules ] && [ -d "$EXT_MODULES/express" ]; then
  echo "Restoring node_modules symlink -> $EXT_MODULES"
  ln -s "$EXT_MODULES" node_modules
fi

# Ensure a COMPLETE install. A partial/corrupted node_modules makes imports fail,
# so verify a known-deep file and (re)install into the external location if it is
# missing — building in a fast temp dir, never inside iCloud.
if [ ! -f node_modules/express/lib/express.js ]; then
  echo "Installing Node dependencies (outside iCloud)..."
  rm -f node_modules
  rm -rf "$EXT_MODULES"
  mkdir -p "$(dirname "$EXT_MODULES")"
  BUILD="$(mktemp -d)"
  cp package.json "$BUILD/"
  [ -f package-lock.json ] && cp package-lock.json "$BUILD/"
  ( cd "$BUILD" && npm install --no-audit --no-fund )
  mv "$BUILD/node_modules" "$EXT_MODULES"
  [ -f "$BUILD/package-lock.json" ] && cp "$BUILD/package-lock.json" ./package-lock.json
  rm -rf "$BUILD"
  ln -s "$EXT_MODULES" node_modules
fi

export PORT="${PORT:-3005}"
exec node index.js
