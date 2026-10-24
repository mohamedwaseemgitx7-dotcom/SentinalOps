# syntax=docker/dockerfile:1
# SentinelOps server + web UI. Multi-stage: build with dev deps, run with production deps only.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN sed -i '/^cache=/d' .npmrc && npm ci --workspace @sentinelops/server --workspace @sentinelops/web --include-workspace-root=false
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @sentinelops/server && npm run build -w @sentinelops/web

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
ENV NODE_ENV=production \
    SENTINELOPS_HOST=0.0.0.0 \
    SENTINELOPS_PORT=4600 \
    SENTINELOPS_DATA_DIR=/data \
    SENTINELOPS_WEB_DIR=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN sed -i '/^cache=/d' .npmrc && npm ci --omit=dev --workspace @sentinelops/server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4600/api/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
