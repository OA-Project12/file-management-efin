# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates libc6-compat

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
# Only public browser configuration is accepted at build time. Server secrets
# are supplied to the running container, never as Docker build arguments.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
COPY next.config.ts tsconfig.json postcss.config.mjs components.json ./
COPY src ./src
COPY public ./public
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
    && npm run build -- --webpack

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/certs/prod-ca-2021.crt \
    STORAGE_QUOTA_CONTROL_DIR=/tmp/efin-dms-quota
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json package-lock.json next.config.ts ./
COPY --chown=node:node public ./public
# Worker/quota scripts import other scripts and the source maintenance module.
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src/infrastructure/security ./src/infrastructure/security
COPY --chown=node:node src/infrastructure/storage/storage-maintenance.mjs ./src/infrastructure/storage/storage-maintenance.mjs
COPY --chown=node:node certs/prod-ca-2021.crt ./certs/prod-ca-2021.crt
RUN mkdir -p /tmp/efin-dms-quota && chown node:node /tmp/efin-dms-quota
# Runtime uses direct node commands; package managers and their bundled dependencies are unnecessary.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
