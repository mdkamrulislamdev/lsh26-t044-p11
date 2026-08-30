# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS devdeps
WORKDIR /app
COPY package.json ./
RUN npm install

# Test stage: `docker compose run --rm test`
FROM node:22-alpine AS test
WORKDIR /app
COPY --from=devdeps /app/node_modules ./node_modules
COPY . .
CMD ["node", "--test", "--test-reporter=spec"]

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz || exit 1
CMD ["node", "src/index.js"]
