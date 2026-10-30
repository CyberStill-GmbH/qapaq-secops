# KrakenD CE 3.0.0 compilado desde su etiqueta oficial con Go y golang.org/x/net parcheados.
#
# La imagen oficial `krakend:3.0.0` trae Go 1.26.8 y x/net 0.58.0, con CVEs HIGH de denegación
# de servicio (CVE-2026-78667, CVE-2026-78669, CVE-2026-97031). KrakenD es el borde detrás del
# ALB público, así que esos CVEs no se ignoran: se recompila la misma versión con Go 1.26.10
# y x/net 0.60.0. Cuando KrakenD publique una imagen corregida, se vuelve a `FROM krakend:<versión>`.
# Pasos de compilación tomados del Dockerfile y el Makefile de krakend-ce v3.0.0 (Apache 2.0).

FROM golang:1.26.10-alpine3.23@sha256:a07f231c19b03e6106cf442f02a5bcf262147e744d15b7b5e4b6d81d420c70a0 AS build
ARG KRAKEND_VERSION=3.0.0
# Commit de la etiqueta v3.0.0; si la etiqueta se moviera, la compilación falla.
ARG KRAKEND_COMMIT=1bd4af95102cef14795f60f4201de72130fc6423
ARG KRAKEND_JOSE_VERSION=v3.0.1
ARG KRAKEND_JOSE_COMMIT=3aa1f0176b0e9e75023e2b258a9bff473b61facf
ARG GO_AUTH0_VERSION=v2.0.1
ARG GO_AUTH0_COMMIT=fe3d54b3d0ccd3a580b0a43e03df8d60b2b3ed73
ENV GOTOOLCHAIN=local
RUN apk add --no-cache git make gcc musl-dev binutils-gold
WORKDIR /src
RUN git clone --depth 1 --branch "v${KRAKEND_VERSION}" https://github.com/krakend/krakend-ce.git . \
  && test "$(git rev-parse HEAD)" = "${KRAKEND_COMMIT}"
RUN git clone --depth 1 --branch "${KRAKEND_JOSE_VERSION}" https://github.com/krakend/krakend-jose.git /src/downstream/krakend-jose \
  && test "$(git -C /src/downstream/krakend-jose rev-parse HEAD)" = "${KRAKEND_JOSE_COMMIT}" \
  && git clone --depth 1 --branch "${GO_AUTH0_VERSION}" https://github.com/krakend/go-auth0.git /src/downstream/go-auth0 \
  && test "$(git -C /src/downstream/go-auth0 rev-parse HEAD)" = "${GO_AUTH0_COMMIT}"
COPY patches/ /patches/
RUN git -C /src/downstream/krakend-jose apply /patches/krakend-jose-v3.0.1-go-jose-v4.patch \
  && git -C /src/downstream/go-auth0 apply /patches/go-auth0-v2.0.1-go-jose-v4.patch
RUN go mod edit -replace=github.com/krakend/krakend-jose/v3=/src/downstream/krakend-jose \
  && go mod edit -replace=github.com/krakend/go-auth0/v2=/src/downstream/go-auth0 \
  && go get golang.org/x/net@v0.60.0 \
  && go mod tidy \
  && go list -deps -f '{{if .Module}}{{.Module.Path}}@{{.Module.Version}}{{end}}' ./cmd/krakend-ce > /tmp/krakend-deps \
  && if grep -Fq 'github.com/go-jose/go-jose/v3@' /tmp/krakend-deps; then echo 'go-jose/v3 is compiled into KrakenD' >&2; exit 1; fi \
  && grep -Fq 'github.com/go-jose/go-jose/v4@v4.1.6' /tmp/krakend-deps \
  && make build GLIBC_VERSION=musl \
  && go version -m ./krakend > /tmp/krakend-build-info \
  && if grep -Fq 'github.com/go-jose/go-jose/v3' /tmp/krakend-build-info; then echo 'go-jose/v3 remains in KrakenD binary' >&2; exit 1; fi \
  && grep -Fq 'github.com/go-jose/go-jose/v4 v4.1.6' /tmp/krakend-build-info \
  && ./krakend version

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN apk upgrade --no-cache --no-interactive && apk add --no-cache ca-certificates tzdata \
  && adduser -u 1000 -S -D -H krakend && mkdir /etc/krakend && chown 1000:1000 /etc/krakend
COPY --from=build /src/krakend /usr/bin/krakend
COPY --chown=1000:1000 --chmod=0555 entrypoint.sh /usr/local/bin/qapaq-krakend-entrypoint
USER 1000:1000
WORKDIR /etc/krakend
COPY --chown=1000:1000 krakend.tmpl /etc/krakend/krakend.tmpl
COPY --chown=1000:1000 krakend-azure-ingestion.tmpl /etc/krakend/krakend-azure-ingestion.tmpl
ENV FC_ENABLE=1
# El entrypoint solo materializa la CA del Indexer cuando llega como secreto (Sprint 5).
ENTRYPOINT ["/usr/local/bin/qapaq-krakend-entrypoint"]
CMD ["run", "-c", "/etc/krakend/krakend.tmpl"]
EXPOSE 8080 8090
