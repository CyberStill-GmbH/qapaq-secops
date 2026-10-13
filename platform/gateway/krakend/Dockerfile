FROM krakend:3.0.0@sha256:e93eed25554145dc4f2727d203e96c655bd2e609459f05e13afcbf590582496f
COPY --chown=1000:1000 --chmod=0555 entrypoint.sh /usr/local/bin/qapaq-krakend-entrypoint
USER 1000:1000
COPY --chown=1000:1000 krakend.tmpl /etc/krakend/krakend.tmpl
ENV FC_ENABLE=1
# El entrypoint solo materializa la CA del Indexer cuando llega como secreto (Sprint 5).
ENTRYPOINT ["/usr/local/bin/qapaq-krakend-entrypoint"]
CMD ["run", "-c", "/etc/krakend/krakend.tmpl"]
