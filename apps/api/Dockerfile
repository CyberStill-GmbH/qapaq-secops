# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build

ENV COREPACK_HOME=/corepack
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Copy workspace manifests first so dependency installation is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY modules/connectors/package.json modules/connectors/package.json
COPY modules/access/package.json modules/access/package.json
COPY modules/telemetry/package.json modules/telemetry/package.json
COPY modules/detection/package.json modules/detection/package.json
COPY modules/soar/package.json modules/soar/package.json
COPY modules/soc/package.json modules/soc/package.json
COPY platform/database/package.json platform/database/package.json
COPY platform/observability/package.json platform/observability/package.json
COPY platform/testing/package.json platform/testing/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY platform/audit/package.json platform/audit/package.json
COPY platform/configuration/package.json platform/configuration/package.json

RUN pnpm install --filter @qapaq/api... --frozen-lockfile

COPY . .
RUN pnpm --filter '@qapaq/api...' run build \
    && pnpm --filter @qapaq/api deploy --prod --legacy /runtime \
    && node scripts/docker/prune-deploy.mjs /runtime

FROM --platform=linux/amd64 node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS runtime

ENV NODE_ENV=production \
    QAPAQ_PROFILE=production \
    QAPAQ_API_HOST=0.0.0.0 \
    QAPAQ_API_PORT=3000
WORKDIR /app

# npm/Corepack/Yarn are build tools and their CVEs must not ship in runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=1000:1000 /runtime/ ./

USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
