# One image: the frontend is built with Vite and served by the Express backend, over HTTP on port
# 3000 and over HTTPS on 3443 with a self-signed certificate (kept in /certs). A trusted
# certificate is left to the operator's reverse proxy or tunnel.

# ── Frontend build ─────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ARG BUILD_SHA=dev
ARG VITE_EMAIL_DIV_RENDER=false
ENV VITE_BUILD_SHA=$BUILD_SHA VITE_EMAIL_DIV_RENDER=$VITE_EMAIL_DIV_RENDER
RUN npm run build

# ── Backend dependencies ───────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
# This stage runs on the build machine, but sharp's prebuilt image library is native code: install
# the one for the platform being built (an arm64 image built on amd64 needs the arm64 binary).
ARG TARGETARCH
RUN npm ci --omit=dev --no-audit --no-fund --os=linux --libc=musl \
      --cpu="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ARG BUILD_SHA=dev
ARG APP_VERSION
ENV NODE_ENV=production \
    PORT=3000 \
    TLS_PORT=3443 \
    TLS_CERT_DIR=/certs \
    BUILD_SHA=$BUILD_SHA \
    IMAGE_CACHE_DIR=/var/cache/mailflow/images

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY --from=web /web/dist ./public

RUN VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}" && \
    printf '{"version":"%s"}\n' "${VERSION#v}" > build-meta.json && \
    mkdir -p /var/cache/mailflow/images /certs && \
    chown -R node:node /var/cache/mailflow /certs

USER node
EXPOSE 3000 3443
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "src/index.js"]
