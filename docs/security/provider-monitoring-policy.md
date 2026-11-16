# Política de monitoreo QAPAQ por proveedor

Actualizada: 2026-11-03. Perfil: fintech. Esta política es operativa y no constituye certificación PCI ni afirmación de alcance de datos de tarjeta.

## Prioridad de detección

- **P1:** compromiso activo con evidencia de impacto: cuenta privilegiada o break-glass comprometida, ataque de credenciales seguido de inicio exitoso y persistencia, control perimetral de producción deshabilitado con actividad sospechosa, malware activo sin contención o vulnerabilidad crítica explotada y alcanzable en activo productivo. Severidad del proveedor, por sí sola, no asigna P1.
- **P2:** cambio no aprobado de identidad, MFA, auditoría, correo, WAF/Access/DNS o reglas de red; amenaza alta/crítica en endpoint; vulnerabilidad alta/crítica abierta mientras se confirma alcance y explotabilidad.
- **P3:** actividad sospechosa aislada, hallazgos medios, cambios legítimos aún sin ticket relacionado y fallos de autenticación sin éxito posterior.
- **P4:** eventos informativos, bloqueos automáticos y hallazgos bajos.

La salud de conectores se supervisa aparte de la amenaza: permiso revocado, API 401/403, timeout o ausencia de eventos genera estado de fuente degradada; no se convierte en un incidente de intrusión. Toda respuesta automática queda fuera de estos collectors y requiere el flujo de aprobación QAPAQ.

## Estado observado en QAPAQ AWS

- **Cloudflare:** token autenticado y acceso de lectura al Audit Logs v2. La cuenta observada fue 6126f578ae768eec4a97c5c64542aaa6. El collector procesa auditoría de cambios de la cuenta; no ingiere eventos WAF de tráfico. Para estos últimos se requiere Logpush/servicio y destino configurado.
- **Snyk:** el token leyó la organización QAPAQ y sus issues. La organización disponible fue 77db995d-f615-4272-80c7-97c85113e685. El collector conserva estado de paginación/duplicados y reporta issues activos; no recibe código fuente ni archivos del proyecto.
- **Bitdefender GravityZone:** la API key responde 403 en getIncidentsList. La documentación del proveedor indica que hace falta habilitar ese API para la key y tener licencia/suscripción de Incidents. El collector reporta la fuente degradada; no afirmamos que reciba incidentes hasta que la llamada devuelva 200.
- **Microsoft 365:** client credentials consigue token, pero la Management Activity API devuelve 401 al listar suscripciones. El módulo Office 365 de Wazuh no está configurado en el manager. Se requiere Application permission ActivityFeed.Read con consentimiento admin, acceso de Management Activity API y Unified Audit Log activo. Hasta que la prueba de lectura responda 200, el health poll no equivale a ingestión de auditoría.
- **AWS:** el host EC2 no tiene instance profile. GuardDuty y Security Hub CSPM no están suscritos en la cuenta consultada. CloudTrail muestra una referencia organizacional cuyo estado no se puede consultar desde este principal. Las credenciales disponibles son una sesión CLI y no se copian como secreto de ejecución. Para ingestión continua se necesita un rol de lectura asignado por administración de AWS o una ruta de eventos autorizada.
- **Qapaqzito:** QAPAQ conecta con DeepSeek usando la key presente bajo QAPAQ_CLAUDE_API en el entorno local. El host usa el nombre de runtime QAPAQ_QAPAQZITO_API_KEY y el modelo deepseek-flash. Qapaqzito no entrega herramientas con permisos de escritura; sus consultas al SOC heredan la autorización de la sesión.

## Reglas e interpretación por proveedor

### Microsoft 365 / Entra

Reglas existentes: 100503 fuerza bruta, 100504 password spray, 100505 inicio exitoso después de fuerza bruta, 100510ºw^~)Þw100515 reglas de correo y enlaces, 100520ºw^~)Þw100530 cambios de privilegio, OAuth, dominio/federación, MFA y auditoría. Las IDs 100520, 100521, 100523, 100525 y 100529 siguen marcadas como pendientes de evidencia exacta del proveedor. La regla 100530 necesita cargar identidades break-glass reales en la lista CDB. No elevar login fallido aislado a P1. Ver wazuh/office365/README.md.

### Cloudflare

La ingesta cubre eventos de auditoría de cuenta y normaliza actor ID/IP, recurso, acción, resultado y timestamp. Un cambio destructivo que afecta WAF, firewall, Access/Zero Trust, DNS, tokens o membresías genera la regla 101216; otro cambio administrativo genera 101217 y requiere contexto de cambio aprobado. Priorizar P1 solo si el control de producción fue debilitado y hay evidencia adicional de abuso. El token validado debe conservar mínimo permiso Account Settings Read. Audit Logs v2 requiere ventana temporal y admite paginación por cursor.

### Snyk

La ingesta procesa issues REST de la organización, usando paginación y deduplicación por issue, timestamp de actualización y estado. Issues abiertos high/critical generan la regla 101218 (P2 inicial). Snyk no se eleva automáticamente a P1: enriquecer con exposición externa, entorno productivo, reachability, exploit conocido/activo y criticidad del activo. Resolver por excepción requiere dueño, justificación y vencimiento. Evitar convertir cada reescaneo sin cambios en alerta nueva.

### Bitdefender GravityZone

getIncidentsList solo se considera operativo si entrega 200 y el tenant tiene licencia de Incidents. Incidentes abiertos high/critical generan 101219 (P2 inicial); P1 requiere amenaza activa y sin contención con endpoint crítico confirmado. No ejecutar remediación mediante este collector. El 403 actual se reporta como fallo de salud (101220), no como amenaza.

### AWS

La política prevista separa CloudTrail administrativo, GuardDuty threat findings, Security Hub CSPM y eventos AWS WAF. Prioridad P1 exige hallazgo de amenaza crítica confirmado en activo productivo o cambio de control seguido por uso sospechoso; controles CSPM aislados van a P2/P3 según exposición. Esta cuenta no tiene hoy una fuente continua confirmada; no inventar findings ni asumir que CloudTrail Organization Trail es accesible porque aparezca en describe-trails. Requiere rol de solo lectura y suscripción a los servicios antes de habilitar el collector.

## Salud, retención y aceptación

Los collectors de Cloudflare, Snyk, Bitdefender y M365 escriben JSONL normalizado en el manager Wazuh. El collector no escribe en los servicios del proveedor ni ejecuta acciones de respuesta. Los eventos repetidos se deduplican localmente; fallos 401/403 se publican una vez por cambio de estado y vuelven a marcar recuperación al restablecerse el acceso.

Una fuente queda **conectada** solo cuando se cumplen todos estos puntos: timer activo, última consulta exitosa, evento real del proveedor normalizado, alerta visible en wazuh-alerts-* y salud de fuente fresca. Un timer activo sin lectura API es solo instalación; un 200 de autenticación sin eventos de auditoría no prueba cobertura. Los eventos de prueba se etiquetan sintéticos y nunca se presentan como actividad real.

## Referencias oficiales

- Cloudflare Account Audit Logs v2: https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/
- Snyk REST Issues: https://github.com/snyk/user-docs/blob/main/developer-tools/snyk-api/reference/issues.md
- Snyk REST API: https://github.com/snyk/user-docs/blob/main/discover-snyk/snyk-api/rest-api/getting-started-with-the-rest-api.md
- Bitdefender getIncidentsList: https://www.bitdefender.com/business/support/en/77209-1463999-getincidentslist.html
- Bitdefender Public API permissions/errors: https://www.bitdefender.com/business/support/en/77212-125277-public-api.html
- DeepSeek Chat/Messages compatibility: https://api-docs.deepseek.com/guides/anthropic_api/
- Wazuh JSON localfile: https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/localfile.html
