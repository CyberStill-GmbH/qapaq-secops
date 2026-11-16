# Ankay SSO: puente sesión QAPAQ → sesión Shuffle. Sin dependencias (solo Node).
FROM node:24.11.1-alpine3.22
WORKDIR /app
COPY lib.mjs shuffle-client.mjs server.mjs bootstrap.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
