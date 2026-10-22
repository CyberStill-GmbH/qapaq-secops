# QAPAQ core runtime builds

`build.sh` conserva el artefacto actual de AWS y fija el bundle global de CA de RDS. Para el
artefacto Azure, ejecutar desde un runner Linux con `ca-certificates` instalado:

```sh
bash wazuh/core/build-azure.sh "$RUNNER_TEMP/qapaq-core-azure"
```

El wrapper selecciona `QAPAQ_CORE_CA_MODE=system`; el builder copia el trust store del runner al
archivo que consumen las unidades systemd existentes y conserva intacta la ruta de build AWS. El
bundle aún debe pasar por el workflow de release Azure y por pruebas TLS reales contra Azure Database
for PostgreSQL antes de desplegarlo.

Este cambio solo resuelve el material de confianza TLS del artefacto. `apply-core.sh` sigue usando
AWS Systems Manager y Secrets Manager, y el worker incluido aún no demuestra un consumidor de cola
funcional en Azure. El bootstrap Azure debe materializar referencias de Key Vault de forma segura y
validar API, worker, migraciones y salud antes de llamar operativo al servicio.

`apply-core-azure.sh` instala un archive fijado por SHA-256 usando `/etc/qapaq-core/core.env`, que el
bootstrap Azure materializa desde referencias de Key Vault. No llama a AWS, no obtiene ni rota
secretos y no los imprime. Activa el release de forma atómica, espera `/health/ready` y revierte al
release anterior si la API no está lista; conserva el activo y tres releases previos. El instalador
requiere que el paquete padre haya verificado los SHA del core archive y materializado el entorno con
permisos `root:qapaq-core`.

El worker solo se considera iniciado por systemd; eso no prueba consumo efectivo de BullMQ, migraciones
de PostgreSQL ni procesamiento de jobs. Esas pruebas de integración siguen siendo necesarias antes de
usar este adaptador en un bundle de producción.

`.github/workflows/qapaq-core-azure.yml` compila el archivo en pull requests y verifica que el CA
empaquetado coincide con el trust store del runner. El artefacto CI vence al día siguiente; no se
publica en Blob/ACR ni lo instala en una VM.
