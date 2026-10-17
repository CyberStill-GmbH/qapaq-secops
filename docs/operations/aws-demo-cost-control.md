# Control de costos reversible: demo AWS

**Estado:** runbook operativo para la cuenta demo `955200662475`, región `us-east-1`.
**Workflow:** `AWS Demo Cost Control` (`.github/workflows/aws-demo-cost-control.yml`).
**Límite de seguridad:** ninguna operación `destroy`, `terminate`, borrado de datos/secretos,
cambio de DNS o modificación de Terraform de recursos persistentes.

## Alcance

| Recurso | Al detener | Datos y reversión |
| --- | --- | --- |
| ECS API, KrakenD y worker | Cambia `desired_count` a 0 mediante `UpdateService` por servicio; espera que no queden tareas activas | Reanudación a 1 tarea por servicio. Se detiene primero el worker y se inicia al final |
| RDS `qapaq-secops-demo-postgres` | `stop-db-instance` después de drenar ECS | Conserva instancia y almacenamiento. RDS puede reiniciar automáticamente tras 7 días seguidos detenida; no es apagado permanente |
| EC2 Wazuh `qapaq-secops-demo-wazuh` | `stop-instances`, nunca `terminate` | Conserva los volúmenes EBS cifrados y adjuntos, EIP, interfaz de red y DNS. RAM y cualquier almacenamiento instance-store no persisten |
| State, S3, Secrets Manager, KMS, ECR | Sin cambios | Se verifica que el bucket de state, los tres buckets configurados y el conjunto de nombres de secretos sigan presentes; el workflow no lee valores de secretos |
| Valkey, ALB, NAT Gateway, VPC endpoints, Route 53 | Sin cambios | No tienen una pausa reversible compatible con este procedimiento o sostienen cola/rutas/egress. Seguirán generando cargos mientras existan |

## Qué cambia para los usuarios

Durante la parada, el dashboard Wazuh, la API y los flujos SOC dejan de responder. Se deben
detener las pruebas/capturas activas antes de iniciar. No se toca el dominio ni sus registros.
Las referencias de trabajos pendientes permanecen en Valkey; el worker permanece abajo hasta
reanudar. La arquitectura documenta PostgreSQL/outbox como fuente duradera y Valkey como transporte.
Al reanudar, el workflow inicia RDS y Wazuh, espera salud de infraestructura y levanta API,
KrakenD y worker en ese orden apropiado para dependencias. Revisar después el dashboard y la
ingesta M365 desde QAPAQ; `instance-status-ok` de EC2 no garantiza por sí solo que cada proceso
de aplicación ya haya completado su bootstrap.

## Ejecución

1. En GitHub, abre **Actions → AWS Demo Cost Control → Run workflow**.
2. Selecciona `main`.
3. Para detener, usa `operation=stop` y escribe exactamente `STOP-QAPAQ-DEMO`.
4. Para reanudar, usa `operation=resume` y escribe exactamente `RESUME-QAPAQ-DEMO`.
5. Espera el resultado y revisa el resumen del job. Un fallo a mitad de parada requiere revisar
   el estado de los tres servicios, RDS y EC2 antes de relanzar. El workflow es idempotente en
   estados ya detenidos o ya reanudados.

El workflow usa OIDC, valida la cuenta/región y los tags, serializa con `Terraform Demo` y
verifica que cada servicio ECS exista en el state remoto antes de llamar `UpdateService` solo
para el `desired_count` indicado. Terraform aún declara una tarea por servicio como baseline;
por eso `Terraform Demo` bloquea applies normales si detecta algún servicio en cero. Primero hay
que reanudar con este runbook para evitar que un apply ordinario levante costos o cambie la pausa.
Esta desviación de desired count es intencional y temporal: se registra en el resumen del job y
se revierte a la configuración declarada con la operación `resume`.

## Cargos que continúan

Esto reduce el cómputo de ECS, RDS y Wazuh EC2, pero **no equivale a una suspensión sin costo**.
Continúan el almacenamiento RDS/EBS, Elastic IP/IPv4, Valkey, ALB, NAT Gateway, endpoints de
interfaz, S3, ECR, KMS y Route 53. Para eliminarlos habría que diseñar y revisar una operación
separada con snapshots/retención, impacto DNS, persistencia BullMQ/idempotencia y plan Terraform;
este runbook no los elimina ni cambia el state.

AWS reinicia automáticamente una instancia RDS detenida después de siete días consecutivos. Si
la demo debe permanecer pausada más tiempo, revisar el costo y la necesidad de un scheduler
aprobado para volver a detenerla tras ese reinicio. No crear un scheduler automáticamente.

## Verificaciones posteriores

El workflow comprueba:

- ECS en `desired=running=pending=0` tras detener y estable en una tarea por servicio tras reanudar.
- RDS existente y `stopped` o `available` según operación.
- Wazuh en EC2 `stopped` o con estado de instancia saludable al reanudar.
- Mismos nombres de secretos QAPAQ demo antes y después, sin recuperar sus valores.
- Bucket remoto de Terraform y buckets S3 raw/evidence/artifacts accesibles.
- Mismos EBS de Wazuh, cifrados y adjuntos después de la parada.

En la reanudación, verificar manualmente HTTPS, estado de manager/indexer/dashboard y retraso de
ingesta antes de declarar el SOC listo.
