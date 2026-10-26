# Readiness operativa QAPAQ SecOps Azure — 2026-10-26

Este registro separa los recursos comprobados en Azure de los perfiles que siguen
apagados. No certifica el SOC como operativo.

## Evidencia confirmada

| Área | Evidencia | Estado |
| --- | --- | --- |
| Terraform EUS2 | PR [#165](https://github.com/CyberStill-GmbH/qapaq-secops/pull/165), commit `46fc5bd`, workflow [40421595800](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40421595800) | Apply `foundation` exitoso; plan guardado: 3 altas, 0 destrucciones, 0 reemplazos. |
| PostgreSQL | Azure CLI: `psql-qapaqsecopsdemoeus-3a2405f3`, East US 2, PostgreSQL 16, `Standard_D2s_v3`, estado `Ready` | Las bases `qapaq_secops` y `qapaq_jobs` existen. La segunda es una base PostgreSQL; no acredita un consumidor BullMQ. |
| Key Vault | ARM confirma `kv-qapaqsecopsd-3a2405f3`, `Succeeded`, `PublicNetworkAccess=Disabled` | Se preservó el acceso privado. La lista de nombres no se pudo leer desde esta máquina porque no estaba dentro del private endpoint; no se consultaron valores. |
| Detecciones AD | PR [#159](https://github.com/CyberStill-GmbH/qapaq-secops/pull/159), commit `c96e35f`; Wazuh Manager 4.14.8 `logtest` y CI pasaron | Reglas locales 101300–101307, en modo observación. No se aplicaron al Manager ni a un dominio y no se instaló/configuró ningún agente o GPO. |
| DNS | No hubo cambios en Route 53, Azure DNS ni `app.jappi.net.pe` | Sin cutover. |

## No desplegado / no comprobado

- `siem_host=null`, `ankay_host=null` y `enable_runtime=false` en el environment
  `azure-demo-eus2`.
- `AZURE_EUS2_CONTAINER_IMAGES_JSON={}` y ACR sin repositorios al consultar el
  2026-10-26; no hay imágenes runtime para instalar.
- `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON={}`. No se cargaron ni leyeron secretos;
  tampoco se verificó desde el private endpoint qué nombres ya existen en el vault.
- Sin Manager, Indexer, Dashboard QAPAQ, QAPAQ Core, KrakenD, Valkey, host Ankay,
  OpenSearch de Ankay, agentes, Sophos, Cato, Graph/M365 o webhook real de Teams
  desplegados en EUS2.
- No hay prueba de login, permisos de usuarios, roles administrativos ni panel de
  gestión contra un runtime Azure.
- No hay estimación total validada del perfil SIEM/Ankay. Los USD 200/mes son
  alertas, no un límite que detenga o destruya recursos.

## Siguiente secuencia verificable

1. Generar artefactos inmutables y fijar sus digests en ACR; confirmar que las
   versiones son Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 y que el overlay QAPAQ
   y el Core incluidos coinciden con el commit de release.
2. Proveer referencias a secretos ya existentes mediante el private endpoint de
   Key Vault. Verificar únicamente metadatos requeridos, permisos mínimos y
   conectividad desde los hosts; no publicar valores en GitHub, Terraform ni logs.
3. Preparar perfil Terraform de `siem_host` y luego `ankay_host`, con CIDR, egress,
   discos y health checks explícitos. Revisar el plan remoto exacto, costo de lista,
   state y cualquier alta/cambio/destrucción antes del apply.
4. Desplegar primero Wazuh/QAPAQ y verificar TLS, login, rol, API, migraciones,
   PostgreSQL y recepción de un evento sintético. Después probar M365, Sophos, Cato
   y Teams con aceptación real de cada proveedor.
5. Desplegar Ankay solo con imágenes y Compose fijados, secretos privados,
   persistencia y playbooks gobernados por QAPAQ; probar autorización por rol,
   SoD, idempotencia, callback y rollback.
6. Habilitar la colección de DC en un piloto autorizado, medir ruido y cobertura
   antes de extender reglas o agentes. DNS/TLS solo después de aprobar los smoke
   tests del runtime y el plan específico de cutover.
