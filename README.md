# customer-tracking-backend

Backend for the **ILL Customer Tracking System (CTS)** — the single source of truth
for every ILL (Internet Leased Line) customer, with old/new ingestion, an
onboarding pipeline, lifecycle actions, and dashboards.

## Stack

- Node.js + **Express 5** (TypeScript, ES modules)
- PostgreSQL + **Prisma**
- **Zod** validation (one schema for Excel rows, API bodies, and forms)
- JWT (Bearer) auth + bcrypt
- SheetJS-friendly bulk import (parsed on the client, validated/committed here)

## Setup

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL, JWT_SECRET, etc.
npx prisma db push          # create tables in the ill_cts database
npm run db:seed             # demo users
npm run dev                 # http://localhost:5002
```

## Demo logins (after seed)

| Email | Password | Role |
|-------|----------|------|
| admin@email.com    | admin123    | Master |
| account@email.com  | 123456      | Accounts |
| delivery@email.com | delivery123 | Delivery |
| viewer@email.com   | viewer123   | Admin |

## Scripts

- `npm run dev` — watch mode (tsx)
- `npm run build` / `npm start` — compile and run
- `npm run db:push` — sync Prisma schema
- `npm run db:seed` — seed demo users
- `npm run db:studio` — Prisma Studio

## Docker (deployment)

Everything is in this folder: `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `docker-compose.yml`.

**One-command deploy (API + Postgres):**

```bash
# from backend/
JWT_SECRET=your-long-secret POSTGRES_PASSWORD=your-db-pass \
  docker compose up -d --build
# → API on http://localhost:5002 (schema auto-synced on boot)

# seed the demo users once (optional)
docker compose exec api npm run db:seed
```

**Just the image** (bring your own database):

```bash
docker build -t ill-cts-backend .
docker run -d -p 5002:5002 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/ill_cts?schema=public" \
  -e JWT_SECRET="your-long-secret" \
  -e CORS_ORIGIN="https://your-frontend.example.com" \
  ill-cts-backend
```

Notes:
- The entrypoint runs `prisma db push` on startup (idempotent). Set `AUTO_DB_PUSH=false`
  to manage the schema yourself.
- Runs as the non-root `node` user. Multi-stage build; Prisma client is generated
  for the image's runtime.
- Required env: `DATABASE_URL`, `JWT_SECRET`. Optional: `PORT` (5002), `CORS_ORIGIN`,
  `JWT_EXPIRES_IN`, `CUTOFF_DATE`. See `.env.example`.

## Architecture notes

- **Hybrid storage:** indexed columns for what we filter/count on, plus a lossless
  `details` JSON snapshot of the full captured record.
- **Append-only audit:** every status change and lifecycle action writes a
  `CustomerHistory` row in the same transaction.
- **Atomic customer codes** (`ILL-00001…`) via an upsert/increment counter.
