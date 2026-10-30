# Ingeniería de detección QAPAQ: incorporación de reglas abiertas y control de falsos positivos

**Estado:** método y backlog de detección para revisión; no equivale a políticas
instaladas en Azure ni a una certificación del tenant. La base de detección es el
ruleset versionado de Wazuh. Las reglas locales QAPAQ de Microsoft 365 viven en
`infra/wazuh/office365/rules/qapaq_office365_rules.xml`; no
se modifica el ruleset upstream directamente.

## Fuentes abiertas evaluadas

| Fuente | Uso en QAPAQ | Control de incorporación |
|---|---|---|
| Rules/decoders oficiales de Wazuh | Primera capa de decodificación y detección para fuentes ya recogidas. Wazuh mantiene estos archivos por versión. | No editar `/var/ossec/ruleset`; crear archivos locales versionados bajo `/var/ossec/etc/rules` y validar contra la versión exacta del Manager. |
| SigmaHQ | Fuente de hipótesis portables para Windows, Linux, identidad, cloud y hunting. | Comenzar por reglas genéricas `stable`/`testing` de severidad alta/crítica; traducir campos y lógica al decoder real de Wazuh; no copiar reglas masivamente ni importar búsquedas sin validar cobertura. La licencia de sus reglas es DRL 1.1: conservar atribución/avisos requeridos y registrar origen/revisión antes de redistribuir. |
| Wazuh Active Response y playbooks Shuffle | Referencias para la automatización operativa. | Usar Ankay/Shuffle para secuencias gobernadas. Active Response tiene efectos directos en endpoint; mantener deshabilitado para estas detecciones hasta obtener aprobación de cada acción, alcance, rollback y evidencia de sandbox. |

No se ha convertido ni cargado un paquete Sigma en el Manager. La conversión automática
no es una prueba de equivalencia: los nombres de campos, normalización, severidad y
eventos requeridos pueden diferir entre Sigma y el decoder Wazuh.
### Primera adaptación de fuente abierta

`infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml` adapta manualmente la regla SigmaHQ “Suspicious Outlook Child Process” (UUID `208748f7-881d-47ac-a29c-07ea84bf691d`, status `test`) a los campos `win.eventdata.*` de Wazuh Sysmon 4.14.x. El padre oficial `sysmon_event1`/61603 confirma el evento de creación de proceso. La regla QAPAQ `101100` alerta en nivel 8 cuando Outlook inicia un intérprete/binario seleccionado; omite `rundll32.exe` por falsos positivos documentados. Cuatro fixtures cubren dos positivos y dos negativos cercanos; el workflow `wazuh-endpoint-detection.yml` ejecuta `wazuh-logtest` sobre Manager 4.14.8.

**Estado operativo: CANDIDATA / NO INSTALADA.** No hay Docker local, por lo que no ejecuté el motor ni comprobé recepción Sysmon en agentes. El workflow CI está preparado, pero no se declara validada hasta ver un run verde. Aun con CI verde, faltará medir volumen y falsos positivos en endpoints de prueba autorizados. Procedencia, versión, requisitos y guardrails: [`infra/wazuh/endpoint/README.md`](../../infra/wazuh/endpoint/README.md).
## Capa de detección existente y backlog útil

La rama del overlay Wazuh ya trae reglas QAPAQ de Office 365 en el rango local
`100500–100549`, sobre las reglas base de Wazuh 4.x. Entre sus señales están fuerza
bruta/password spray, éxito después de fallos, creación/cambio de reglas de inbox,
reenvío SMTP, consentimiento de aplicaciones, métodos MFA, roles privilegiados,
cambios de Conditional Access/federación y alteración de auditoría. Las reglas con
strings de operación que carecen de una muestra real del tenant llevan marca de
`qapaq_pending_provider_evidence`: no se presentan como cobertura confirmada hasta
verificar una muestra redactada.

Prioridad adicional para el overlay, una vez comprobado que el agente genera la
telemetría necesaria:

1. **Identidad/correo:** correlacionar autenticación, cambio de regla de inbox,
   OAuth/credenciales de aplicación y privilegios en una ventana corta. Mantener
   cada evento base en nivel informativo; elevar la cadena corroborada.
2. **Endpoint/malware:** FIM acotado a rutas de persistencia/configuración críticas,
   logs de Sophos/Wazuh y hash SHA-256; enriquecer el hash antes de priorizar. No
   tratar cualquier cambio FIM como malware.
3. **Red/Cato:** usar el feed de seguridad con su `marker` durable y asociar el
   evento al activo/sitio y al mismo IOC/intervalo. Separar eventos de conectividad
   normales de veredictos de seguridad.
4. **Agente/telemetría:** detectar agente desconectado, módulo Office365 que deja
   de leer y huecos por workload. Una fuente sin eventos se marca desconocida o
   degradada, nunca saludable por silencio.
5. **Linux/Windows:** usar Sysmon/Windows Security y audit/journald según perfiles
   de activo; habilitar SCA, vulnerability detection y rootcheck donde el sistema
   operativo, carga y capacidad del nodo lo permitan. Evitar FIM recursivo sobre
   datos voluminosos y directorios temporales.

## Método de reducción de falsos positivos

1. **Verificar telemetría y versión primero.** Confirmar que el decoder extrae los
   campos necesarios en Wazuh 4.14.x y que el servicio realmente produce ese evento.
2. **Reglas en capas.** Usar una regla base informativa y reglas de correlación con
   `if_sid`/grupos, ventana y entidad común. Para spray, agrupar por IP/identidad y
   usuario distinto; para éxito tras fallos, exigir la misma identidad y una ventana
   delimitada. Ajustar umbrales con distribución del tenant, no por intuición.
3. **Fixtures pareados.** Por regla incluir positivos, negativos cercanos, borde del
   umbral, campos ausentes, reintento duplicado y operación legítima de administrador.
   Los ejemplos usan `.example`, RFC 5737 y personas sintéticas.
4. **Prueba del motor real.** Ejecutar `wazuh-logtest` sobre la versión objetivo.
   Probar la secuencia temporal en una sola sesión cuando se usen contadores; el
   test de XML por sí solo no valida qué regla gana.
5. **Shadow antes de subir severidad.** Mantener nivel bajo/etiqueta de evaluación,
   medir por grupo de activo y revisar muestras con SOC. Promover solo cuando la
   señal tenga contexto, tasa de falsos positivos conocida y una acción de analista
   definida.
6. **Excepciones estrechas y con vencimiento.** Vincular a actor, activo, regla,
   ventana/cambio aprobado y owner. No excluir rangos de IP, dominios, cuentas
   administrativas, operaciones de proveedor o grupos enteros como solución global.
7. **No ocultar cobertura.** No usar `ignore`, `noalert`, `level 0` o allowlists para
   apagar alertas sin registrar qué evidencia justifica la excepción, cuánto dura y
   cómo se mide que la detección sigue funcionando.
8. **Revisión periódica.** Medir alertas por regla, duplicados, ratio triage/cierre,
   FP confirmados, tiempo al primer análisis y frescura de fuente. Revalidar cada
   actualización Wazuh, cambios de schema del proveedor y cambios de las reglas.

## Automatización conectada al ciclo de detección

- Las alertas de alto nivel pueden iniciar `triage.wazuh-high-severity` en Ankay, con dedupe por `alert.id` y solo metadatos mínimos.
- Los playbooks M365/Graph, Sophos, Cato y VirusTotal están descritos en [`ankay-playbooks/README.md`](ankay-playbooks/README.md). Hasta completar cada conector, licencia, secreto y prueba del proveedor, su estado es diseño/bloqueado.
- Teams crítico se envía desde el outbox de QAPAQ, evitando que una regla de Wazuh y un workflow dupliquen la misma notificación.
- La alerta `101100` no rebaja el umbral global del adaptador Wazuh→Ankay (nivel 12). Para automatizar triage, debe admitirse después por caso QAPAQ y allowlist versionado; solo genera contexto para analista y no autoriza comandos ni contención.
- Aislar endpoints, bloquear IOC, revocar sesiones y ejecutar Active Response requieren una acción QAPAQ aprobada, SoD, clave idempotente, verificación del efecto y compensación/rollback.
## VirusTotal

Wazuh integra FIM con consultas de hashes para enriquecer eventos. Para esta
financiera se habilitará únicamente con una licencia/API que permita uso comercial
y el tratamiento de IOCs aprobado. El API público no se usa en servicios/workflows
comerciales; tampoco se subirán muestras. El primer piloto será consulta controlada
de SHA-256, con límite y caché, rotación de credencial, registro de cuota y una
ventana de fallo que no interrumpa FIM ni ingestión. Una respuesta de reputación es
una señal adicional, no una orden para borrar/aislar. El secreto se referenciará
desde Key Vault al runtime; nunca en `ossec.conf`, Terraform state, CI logs ni Git.

**Decisión del dueño (2026-10-27): consulta manual con la clave pública.** Mientras no
exista licencia comercial, la única vía es el botón «Consultar en VirusTotal» del detalle
de alerta (`POST /api/alerts/:id/enrichment/virustotal`, capability
`enrichment.virustotal`, analista y admin). Solo hashes MD5/SHA-1/SHA-256 que la alerta ya
trae (mapping Wazuh 1.2.0: `syscheck.*_after` y Sysmon `hashes`), con
`GET /api/v3/files/{hash}`; nunca subidas, URLs, dominios ni IPs. El núcleo aplica 4
consultas/min y 500/día por tenant, caché de 24 h en PostgreSQL y audita cada intento. La
integración VirusTotal de Wazuh, Ankay y cualquier playbook siguen deshabilitados. La clave
llega por `QAPAQ_VIRUSTOTAL_API_KEY_REF` (Key Vault `qapaq-virustotal-api-key`); sin clave,
el endpoint responde `INTEGRATION_NOT_CONFIGURED` y el API arranca igual.

## Criterio para mover una regla a producción

- Origen/commit/licencia atribuidos; versión de Wazuh/decoder fijada.
- Campos y cobertura del proveedor demostrados con evento sintético y muestra real
  redactada si está autorizada.
- Positive/negative/boundary fixtures pasan `wazuh-logtest` del Manager destino.
- Falsos positivos conocidos, severidad, umbral, excepción, propietario y expiración
  documentados.
- Cambio desplegable por CI con rollback y evidencia; no se aplican reglas mediante
  edición manual no versionada en el host.

## Fuentes primarias
- [SigmaHQ: hijo sospechoso de Outlook (UUID y notas de falsos positivos)](https://github.com/SigmaHQ/sigma/blob/master/rules/windows/process_creation/proc_creation_win_office_outlook_susp_child_processes.yml)
- [Wazuh ruleset: Sysmon Event ID 1 y grupo `sysmon_event1`](https://github.com/wazuh/wazuh-ruleset/blob/master/rules/0595-win-sysmon_rules.xml)

- [Wazuh: reglas locales y `wazuh-logtest`](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html)
- [Wazuh: probar decoders y reglas](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)
- [Wazuh: sintaxis de reglas y correlación](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html)
- [Wazuh: malware, FIM e inteligencia de amenazas](https://documentation.wazuh.com/current/user-manual/capabilities/malware-detection/index.html)
- [Wazuh: integración VirusTotal](https://documentation.wazuh.com/current/user-manual/capabilities/malware-detection/virus-total-integration.html)
- [Wazuh: Active Response](https://documentation.wazuh.com/current/user-manual/capabilities/active-response/index.html)
- [SigmaHQ: reglas](https://github.com/SigmaHQ/sigma)
- [SigmaHQ: release packages y calidad por status](https://github.com/SigmaHQ/sigma/blob/master/Releases.md)
- [SigmaHQ: Detection Rule License 1.1](https://github.com/SigmaHQ/Detection-Rule-License)
