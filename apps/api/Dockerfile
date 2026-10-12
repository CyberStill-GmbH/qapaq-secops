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

# Bundle CA global de RDS, fijado por hash: si AWS lo rota, el build falla hasta revisar y
# actualizar el hash a propósito. Se descarga aquí para fijar permisos legibles por el usuario
# sin privilegios (directorio 0755, archivo 0644): `ADD --chmod` también cambia el directorio
# y lo deja sin permiso de ejecución.
ADD --checksum=sha256:fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /qapaq-certs/rds-global-bundle.pem
RUN chmod 0755 /qapaq-certs && chmod 0644 /qapaq-certs/rds-global-bundle.pem

COPY . .
RUN pnpm --filter '@qapaq/api...' run build \
    && pnpm --filter @qapaq/api deploy --prod --legacy /runtime \
    && node scripts/docker/prune-deploy.mjs /runtime

FROM --platform=linux/amd64 gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime

# Bundle CA de RDS con permisos ya fijados en la etapa de build (C-1).
COPY --from=build /qapaq-certs/ /etc/qapaq/

ENV NODE_ENV=production \
    QAPAQ_PROFILE=production \
    QAPAQ_API_HOST=0.0.0.0 \
    QAPAQ_API_PORT=3000 \
    NODE_EXTRA_CA_CERTS=/etc/qapaq/rds-global-bundle.pem
WORKDIR /app

COPY --from=build --chown=1000:1000 /runtime/ ./

USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["dist/main.js"]
