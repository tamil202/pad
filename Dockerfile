# syntax=docker/dockerfile:1

# ===========================================================================
# Pen Pad — multi-stage image, tuned small for Raspberry Pi (arm64 / armv7).
# Pure JS + Express (no native modules), so Alpine is safe and tiny.
# ===========================================================================

# ---- Stage 1: build (compile TypeScript → dist/) --------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install ALL deps (incl. TypeScript) using the lockfile for reproducibility.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Compile the server.
COPY src ./src
RUN npm run build          # tsc → /app/dist

# ---- Stage 2: runtime (only what's needed to run) -------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install production deps ONLY (express) and drop the npm cache to keep the
# image small — important on an SD card.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring in the compiled server and the static front-end.
COPY --from=build /app/dist ./dist
COPY public ./public

# Data dir for saved pages (also bind-mounted from the host in compose).
# Run as the unprivileged built-in `node` user (uid 1000, matches Pi's default).
RUN mkdir -p data/pages && chown -R node:node /app
USER node

EXPOSE 3000

# A tiny built-in healthcheck — no curl/wget needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/pages',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
