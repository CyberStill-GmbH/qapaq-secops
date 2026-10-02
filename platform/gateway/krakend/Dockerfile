FROM krakend:latest@sha256:e93eed25554145dc4f2727d203e96c655bd2e609459f05e13afcbf590582496f
USER 1000:1000
COPY --chown=1000:1000 krakend.tmpl /etc/krakend/krakend.tmpl
ENV FC_ENABLE=1
ENTRYPOINT ["/usr/bin/krakend"]
CMD ["run", "-c", "/etc/krakend/krakend.tmpl"]
