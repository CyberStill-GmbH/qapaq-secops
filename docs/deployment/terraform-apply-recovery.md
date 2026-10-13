# Recuperación del apply demo del 12 de octubre

## Evidencia y alcance

El [run Terraform Demo #50](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/38340620623)
ejecutó fmt, init, validate y plan correctamente, pero el apply terminó con dos errores:

- ACM: certificado de `api.jappi.net.pe` en `FAILED`, motivo `CAA_ERROR`.
- ECS: el target group de KrakenD no estaba asociado a un load balancer al crear el servicio.

El log confirma creación de RDS, Valkey, ALB, NAT, EC2 Wazuh y servicios API/worker.
No acredita salud de contenedores, inicialización funcional de Wazuh ni migraciones.
No se debe interpretar el fallo como rollback del despliegue completo.

Las consultas públicas a Google DNS realizadas durante la recuperación devolvieron
`NOERROR`, delegaciones Route 53 para `jappi.net.pe` y `api.jappi.net.pe`, y ningún
CAA en esos nombres ni en `net.pe` o `pe`. El error original no demuestra un
bloqueo CAA que siga vigente; su causa DNS exacta sigue sin verificarse.

## Reparación

- Declarar CAA `0 issue "amazon.com"` solo en el hostname del API. Solicitar el
  certificado después de publicar ese registro y la delegación de la zona hija.
- Hacer que el servicio KrakenD espere a los listeners HTTP y HTTPS: con TLS,
  el listener HTTP redirige y solo HTTPS asocia el target group al ALB.
- En cada plan completo, consultar el certificado administrado ya presente en
  el state. Solo si ACM informa `FAILED` o `VALIDATION_TIMED_OUT`, incluir
  `-replace=aws_acm_certificate.public_api[0]`. Un certificado emitido o pendiente
  no se reemplaza por este mecanismo. Apply sigue siendo un despacho manual y
  ejecuta exactamente el plan guardado.

## Ejecución y aceptación

1. Integrar la reparación con CI requerida en verde.
2. Ejecutar `Terraform Demo` desde `main`, `action=plan`. Revisar el delta contra
   el state remoto del apply parcial. La sustitución esperada es únicamente el
   certificado fallido; detenerse ante reemplazos de Wazuh/RDS, destrucciones
   ajenas o un intento de recrear toda la infraestructura.
3. Ejecutar nuevamente desde `main`, `action=apply`. El workflow genera un plan
   fresco y lo aplica. Comparar ese delta con el revisado; no usar el botón de
   reintentar el run #50, que conserva el commit anterior a esta reparación.
4. Confirmar certificado `ISSUED`, listener 443 creado, servicio KrakenD creado
   y target healthy. Comprobar por separado tareas API/worker y Wazuh: creación
   de recursos no equivale a aceptación funcional.
5. Seguir [el checklist de release](release-demo-checklist.md) y
   [el rollout PostgreSQL](soc-postgres-rollout.md) para publicar los digests y
   ejecutar bootstrap/migraciones antes de activar `soc_database_enabled`.
   Los PR #27 (digests) y #28 (persistencia) son cambios distintos de esta reparación.

Estado de esta nota: reparación preparada; apply de recuperación pendiente.
