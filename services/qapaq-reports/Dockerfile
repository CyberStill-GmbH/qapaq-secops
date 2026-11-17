# QAPAQ reports: microservicio de informes (PDF/XLSX/CSV). Contexto de build: services/qapaq-reports
# (compose: context /opt/qapaq/src/services/qapaq-reports). Red interna, sin puertos publicados.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLCONFIGDIR=/tmp/mpl XDG_CACHE_HOME=/tmp/cache HOME=/tmp
# Pango/HarfBuzz para WeasyPrint; Noto Sans (solo la familia Sans) como tipografia libre.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b \
      libharfbuzz-subset0 libfontconfig1 fonts-noto-core fonts-dejavu-core \
 && (find /usr/share/fonts -type f -path '*noto*' ! -name 'NotoSans-*' -delete || true) \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
WORKDIR /srv
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements.txt
COPY app ./app
COPY assets ./assets
RUN useradd --system --uid 10089 --no-create-home --shell /usr/sbin/nologin qapaq

# Etapa de pruebas: docker build --target test -t qapaq-reports:test .
FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && pip install -r requirements-dev.txt
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q", "tests"]

FROM base AS runtime
USER 10089:10089
EXPOSE 8090
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3).status == 200 else 1)"]
CMD ["python", "-m", "app.server"]
