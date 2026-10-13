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
COPY modules/access/package.json modules/access/package.json
COPY modules/connectors/package.json modules/connectors/package.json
COPY modules/detection/package.json modules/detection/package.json
COPY modules/soar/package.json modules/soar/package.json
COPY modules/soc/package.json modules/soc/package.json
COPY modules/telemetry/package.json modules/telemetry/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY platform/audit/package.json platform/audit/package.json
COPY platform/configuration/package.json platform/configuration/package.json
COPY platform/database/package.json platform/database/package.json
COPY platform/testing/package.json platform/testing/package.json

RUN pnpm install --filter @qapaq/worker... --frozen-lockfile

COPY . .
RUN pnpm --filter '@qapaq/worker...' run build \
    && pnpm --filter @qapaq/worker deploy --prod --legacy /runtime \
    && node scripts/docker/prune-deploy.mjs /runtime

FROM --platform=linux/amd64 gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime

ENV NODE_ENV=production \
    QAPAQ_PROFILE=production
WORKDIR /app

COPY --from=build --chown=1000:1000 /runtime/ ./

USER 1000:1000
STOPSIGNAL SIGTERM
CMD ["dist/main.js"]
