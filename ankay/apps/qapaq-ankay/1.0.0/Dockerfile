# App Shuffle «QAPAQ Ankay». Contexto de build: el directorio ankay/ del repositorio.
# El worker la ejecuta como ankay/apps:qapaq-ankay_1.0.0 (el host la etiqueta desde su
# digest ACR); también lleva el importador idempotente de playbooks.
ARG PYTHON_RUNTIME_IMAGE
FROM ${PYTHON_RUNTIME_IMAGE}

ARG APP_SDK_SHA
ARG APP_SDK_FILE_SHA256
ARG APP_SDK_LICENSE_SHA256

COPY apps/qapaq-ankay/1.0.0/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check --require-hashes \
      --only-binary=:all: -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    # La app no instala nada en runtime: fuera pip, ensurepip y setuptools de la base, que
    # traen copias vendorizadas de certifi/urllib3/msgpack con CVE.
    && python -m pip uninstall --yes --disable-pip-version-check pip \
    && find /usr/local/lib/python3.13 -depth \( -name 'setuptools*' -o -name 'pip' -o -name 'pip-*' -o -name 'ensurepip' \) -exec rm -rf {} + \
    && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.13

ADD --chmod=0644 --checksum=sha256:${APP_SDK_FILE_SHA256} https://raw.githubusercontent.com/Shuffle/app_sdk/${APP_SDK_SHA}/shuffle_sdk/shuffle_sdk.py /app/walkoff_app_sdk/app_base.py
ADD --chmod=0644 --checksum=sha256:${APP_SDK_LICENSE_SHA256} https://raw.githubusercontent.com/Shuffle/app_sdk/${APP_SDK_SHA}/LICENSE /usr/share/licenses/shuffle-app-sdk/LICENSE
COPY apps/qapaq-ankay/1.0.0/src/ /app/
COPY playbooks/generated/ankay-catalog.json /app/ankay-catalog.json
COPY playbooks/generated/workflows/ /opt/ankay/playbooks/workflows/
COPY playbooks/import_playbooks.py /opt/ankay/import_playbooks.py

RUN touch /app/walkoff_app_sdk/__init__.py \
    && chmod -R a+rX /app /opt/ankay /usr/share/licenses/shuffle-app-sdk \
    && python -c "import json; json.load(open('/app/ankay-catalog.json'))" \
    && addgroup -S -g 10003 ankay-app \
    && adduser -S -D -H -u 10003 -G ankay-app ankay-app
USER 10003:10003
WORKDIR /app
CMD ["python", "app.py", "--log-level", "INFO"]
