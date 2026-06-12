#!/bin/sh
set -e

# Sync the Prisma schema to the database on startup (idempotent). Set
# AUTO_DB_PUSH=false if you manage the schema separately (e.g. CI migrations).
if [ "${AUTO_DB_PUSH:-true}" = "true" ]; then
  echo "→ Applying Prisma schema (prisma db push)…"
  npx prisma db push --skip-generate
fi

# Hand off to the CMD (node dist/index.js).
exec "$@"
