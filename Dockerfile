# syntax=docker/dockerfile:1.7
#
# One image, three roles — the command decides which:
#
#   API      node dist/src/server.js          (default)
#   Worker   node dist/src/worker.js          (WORKER_EMBEDDED=false on the API)
#   Migrate  node dist/scripts/migrate.js up  (run once per deploy, before the API)
#
# The build stage compiles with the full dependency tree and then prunes it,
# so the runtime stage carries production dependencies only.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_LOCAL_ROOT=/app/storage/media
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so graceful shutdown (drain HTTP,
# finish in-flight jobs, close pools) actually runs when the container stops.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The migration runner reads the SQL migrations from here at runtime.
COPY database ./database

RUN mkdir -p /app/storage/media && chown -R node:node /app/storage
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/server.js"]
