# Decisión de observabilidad autogestionada para evitar tercerización ante SBS

Estado: **BASELINE TÉCNICO-NORMATIVO PARA REVISIÓN LEGAL** · Fecha: 2026-09-28.
Owner propuesto: Security + Compliance + Legal + Platform/SOC.

## Decisión y alcance de la conclusión

QAPAQ adopta **Grafana OSS + Loki + Prometheus**, desplegados y operados en
infraestructura bajo control de la empresa, para la observabilidad operacional del
SOC. La finalidad es conservar control directo sobre acceso, almacenamiento,
retención, borrado, auditoría, continuidad y exportación de la telemetría, y reducir
la dependencia de un SaaS de observabilidad. La decisión busca **evitar contratar
y tercerizar** el procesamiento de logs e información SOC y, por tanto, evitar el
trámite y la carga de control que corresponderían ante la SBS por ese servicio
externo, siempre que el modelo operativo sea efectivamente interno.

Esta es una **decisión de arquitectura y tratamiento de riesgo**, no un mandato de
la SBS. La SBS no exige Grafana, Loki o Prometheus. “OSS” tampoco
prueba por sí solo control interno: la empresa debe operar realmente cómputo,
identidades, llaves, red, backups, soporte y datos. Si un tercero administra el
hosting, cluster, almacenamiento, soporte con acceso privilegiado o procesamiento,
Legal/Compliance debe recalificar el arreglo conforme a los artículos 22–25.

## Norma que regula el supuesto que se busca evitar

La **Resolución SBS N.° 504-2021**, modificada por la **Resolución SBS N.°
1515-2021**, regula los servicios provistos por terceros y los servicios
significativos de procesamiento de datos en sus artículos 22–25. Esa es la norma
que hace relevante evitar la tercerización; no es una norma que ordene el uso del
stack seleccionado.

| Disposición | Obligación relevante | Cómo contribuye el stack autogestionado | Evidencia exigida |
| --- | --- | --- | --- |
| Art. 3 | SGSI-C protege confidencialidad, disponibilidad e integridad | control directo de acceso, cifrado, almacenamiento y recuperación | arquitectura, IAM, cifrado, backup/restore |
| Arts. 10–11 | alcance sobre infraestructura, comunicaciones y perímetro con terceros; capacidades de detección, respuesta y recuperación | inventario y ownership internos reducen fronteras contractuales, sin excluirlas si existen | inventario, RACI, diagramas y matriz de terceros |
| Art. 12.2 | controles de acceso, mínimo privilegio, necesidad de conocer y segregación de funciones | Entra/grupos, red QAPAQ, roles separados y datasources provisionados | matriz de acceso y pruebas allow/deny |
| Art. 12.3 y 12.4 | continuidad, backups, restauración, seguridad y segregación de redes | storage persistente, recovery ensayado y componentes sin exposición pública | restore, RPO/RTO observado, reglas de red |
| Art. 12.6.c | servicio de operaciones de seguridad con detección/respuesta y monitoreo de red e infraestructura | Grafana centraliza señales; Prometheus mide funcionamiento; Loki conserva logs operacionales | dashboards, alertas, runbooks y ejercicios |
| Art. 12.6.g | preservar evidencia para investigación forense | Loki ayuda a investigar, pero no sustituye audit trail/WORM ni SecurityEvent/raw | hashes, audit trail, custodia y export controlado |
| Art. 14 | programa permanente de ciberseguridad con identificar/proteger/detectar/responder/recuperar | el stack materializa principalmente detección y soporte a respuesta/recuperación | cobertura de alertas, incidentes y postmortems |
| Art. 17.1.d y 17.3 | límite de intentos fallidos y registros protegidos de intentos/autenticaciones | Entra Smart Lockout, rate limiting QAPAQ y telemetría agregada | política efectiva y escenarios de ataque |
| Art. 21.1.j y 21.3 | monitoreo de eventos de seguridad en APIs y especificaciones documentadas para auditoría | métricas/logs por operación y contratos versionados | catálogo API, dashboards y pruebas |
| Arts. 22–23 | si hay tercero/nube: evaluar riesgos, contrato, roles, segregación y logs | el hosting interno evita aplicar estos artículos por un SaaS de observabilidad, pero no por otros terceros existentes | dictamen de clasificación y registro de proveedores |
| Art. 24.2 | para servicio significativo de tercero: acceso SBS/auditoría, incidentes, salida, cadena, eliminación y verificación anual | operar por cuenta propia reduce dependencia, facilita acceso y hace ejecutable una salida; no exime controles internos | acceso a evidencia, recovery, inventario y revisiones |
| Art. 24.3 | informar a SBS el servicio significativo contratado y datos del proveedor dentro del plazo normativo | no habría “servicio contratado” de observabilidad si es genuinamente interno; Legal debe confirmarlo según la operación real | memo legal y mapa contractual |
| Art. 25 | autorización previa para servicio significativo desde el exterior solo si presenta limitaciones para cumplir 24.2 | el stack interno evita ese supuesto específico si no existe proveedor exterior; no es una exención general | evaluación Legal previa a cualquier cambio de hosting |

Marco complementario: **Ley N.° 29733, Ley de Protección de Datos Personales**, y
su Reglamento aprobado por **D.S. N.° 016-2024-JUS**. Logs, IP, identificadores de
usuario y trazas pueden contener datos personales; aplican finalidad, minimización,
seguridad, acceso restringido, retención y atención de derechos según la
clasificación que ratifique Privacy/Legal. La selección OSS no elimina esas
obligaciones.

## Posición regulatoria defendible

La formulación aprobada para arquitectura, expediente y auditoría es:

> La empresa selecciona Grafana OSS, Loki y Prometheus como plataforma de
> observabilidad autogestionada para conservar control total operativo y de
> custodia sobre los logs e información del SOC. Al no contratar un servicio
> externo de observabilidad, se busca evitar la tercerización y el trámite
> regulatorio asociado ante la SBS. La conclusión depende de que infraestructura,
> administración, almacenamiento, backups y accesos permanezcan realmente bajo
> control de la empresa.

No deben usarse estas afirmaciones:

- “La SBS obliga a usar Grafana OSS”.
- “Open source significa que no existe tercerización”.
- “On-premise elimina la obligación de proteger datos personales”.
- “Al no usar SaaS no es necesario informar ni consultar a Legal”.
- “Loki constituye por sí solo evidencia forense o auditoría inmutable”.

## Condiciones para sostener que no se terceriza la observabilidad

Antes de presentar esa conclusión a la SBS o auditoría deben cumplirse todas:

1. cómputo, red, storage, backups, llaves y cuentas bajo control de la empresa;
2. operación, parches, cambios, acceso privilegiado y guardia con personal propio,
   o terceros identificados y evaluados si participan;
3. ninguna telemetría ni backup enviado a Grafana Cloud u otro SaaS;
4. repositorios/descargas de paquetes no reciben telemetría y se controlan por
   supply chain; soporte comunitario no obtiene acceso;
5. acceso SBS, Auditoría Interna y Externa disponible en tiempos razonables;
6. retención, eliminación, legal hold, backup y restore aprobados y probados;
7. inventario de subprocesadores/terceros vacío o completo y ratificado;
8. Legal/Compliance emite el dictamen de clasificación del servicio y mantiene
   evidencia ante cambios de datacenter, soporte o administración.

## Controles técnicos de implementación

- Grafana sin acceso anónimo, autenticado por Entra single-tenant y red QAPAQ.
- Loki detrás de proxy autenticado/mTLS; Prometheus y endpoints `/metrics` privados.
- TLS en tránsito, cifrado en reposo, llaves separadas y rotación documentada.
- roles mínimos separados para administración, consulta SOC, auditoría y servicio.
- logs sin secretos/raw/PII innecesaria; labels sin alta cardinalidad ni identidad.
- provisioning versionado, imágenes fijadas, SBOM, scans y parcheo con rollback.
- almacenamiento persistente, cuotas, retención, backup y restore con evidencia.
- Alertmanager y monitor externo capaces de alertar cuando el stack completo cae.
- auditoría administrativa del stack exportada a un plano distinto; Loki no se
  autogarantiza cuando él mismo está indisponible o comprometido.

## Gate de aprobación

La decisión técnica puede entrar a Sprint 2/3. La afirmación regulatoria
“observabilidad no tercerizada” permanece **PENDING LEGAL/COMPLIANCE SIGN-OFF**
hasta completar el cuestionario de terceros, diagrama de despliegue, inventario,
RACI, clasificación de datos, matriz de retención, análisis de artículos 22–25 y
evidencia de los controles anteriores. Todo cambio de hosting, soporte privilegiado,
backup externo o Grafana Cloud reabre el análisis.

## Fuentes oficiales

- [Resolución SBS N.° 504-2021, texto actualizado](https://intranet2.sbs.gob.pe/dv_int_cn/2046/v4.0/Adjuntos/504-2021.R.pdf).
- [Resolución SBS N.° 1515-2021](https://intranet2.sbs.gob.pe/dv_int_cn/2079/v1.0/Adjuntos/1515-2021.R.pdf).
- [Ley N.° 29733](https://www.gob.pe/institucion/congreso-de-la-republica/normas-legales/243470-29733).
- [D.S. N.° 016-2024-JUS](https://www3.congreso.gob.pe/Docs/DGP/DIDP/files/ds_016-2024-jus.pdf).
