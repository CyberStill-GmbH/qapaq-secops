# QAPAQ correlator: static Go binary on distroless (no shell, no package manager), non-root.
# Build context: the repository root (compose: context /opt/qapaq/src).
FROM golang:1.23.12-bookworm AS build
WORKDIR /src/services/qapaq-correlator
COPY services/qapaq-correlator/go.mod ./
COPY services/qapaq-correlator/ ./
RUN mkdir -p /out \
 && CGO_ENABLED=0 GOOS=linux go test ./... \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w -buildid=' \
    -o /out/qapaq-correlator ./cmd/qapaq-correlator

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/qapaq-correlator /usr/local/bin/qapaq-correlator
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/qapaq-correlator", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/qapaq-correlator"]
CMD ["serve"]
