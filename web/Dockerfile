# syntax=docker/dockerfile:1

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

# ── dev ──────────────────────────────────────────────────────────────────────
# Vite dev server with HMR. `docker compose up web-dev`.
FROM node:22-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ── build ────────────────────────────────────────────────────────────────────
# Typecheck and bundle. Fails the image build on a type error, by design.
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── check ────────────────────────────────────────────────────────────────────
# Optional stage: the 25-case solver harness. `docker build --target check .`
FROM build AS check
RUN npx --yes tsx scripts/check.ts

# ── runtime ──────────────────────────────────────────────────────────────────
# Static SPA on unprivileged nginx. When the Go monolith lands this stage is
# replaced by the binary with web/dist embedded (plans/04-production.md).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
