FROM krakend:2.13.11
USER 1000:1000
COPY --chown=1000:1000 krakend.tmpl /etc/krakend/krakend.tmpl
ENV FC_ENABLE=1
ENTRYPOINT ["/usr/bin/krakend"]
CMD ["run", "-c", "/etc/krakend/krakend.tmpl"]
