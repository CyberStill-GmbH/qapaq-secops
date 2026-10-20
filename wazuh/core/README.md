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
