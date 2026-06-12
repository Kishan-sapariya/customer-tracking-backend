# ── ILL CTS backend — production image (multi-stage) ─────────────────────────
# Build: tsc → dist, with the Prisma client generated for this (debian) runtime.

FROM node:22-slim AS base
WORKDIR /app
# Prisma needs OpenSSL at build- and run-time.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- install deps (cached on package*.json) + generate Prisma client ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

# --- compile TypeScript to dist/ ---
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- lean runtime image ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=5002

# App code + the deps/generated-client/prisma-CLI from the build stage.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Run as the built-in non-root node user.
USER node

EXPOSE 5002
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
