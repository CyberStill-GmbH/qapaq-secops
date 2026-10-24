# Ankay Qapaq: catálogo inicial de playbooks SOC

**Estado:** diseño versionado para revisión; no importado en una instancia Ankay ni
conectado a tenants reales. Ankay es Shuffle v2.3.0 con overlay de frontend QAPAQ;
los workflows, backend y apps de ejecución siguen el upstream fijado. Este catálogo
separa enriquecimiento de solo lectura de acciones con efectos.

## Webhook y fronteras de confianza

### Ingreso de detecciones

El adaptador existente `infra/wazuh/shuffle/custom-qapaq-shuffle` puede enviar al
trigger HTTPS de Ankay únicamente metadatos mínimos de alertas Wazuh nivel 12+:
ID/fecha, regla, grupos allowlisted, agente y Manager. El payload no contiene
`full_log`, URLs, correo, IP, usuario, contenido ni evidencia. Ese camino sirve
solo para iniciar triage de metadatos; no concede permisos para recuperar eventos,
consultar APIs ni ejecutar acciones.

El receptor se crea dentro del workflow `QAPAQ · Triage inicial Wazuh` como un
Webhook trigger POST bajo el path moderno `/api/v1/webhooks/webhook_<id>`. Exigir
TLS validado y el header `X-Qapaq-Integration` con al menos 32 caracteres
aleatorios; limitar cuerpo y frecuencia; rechazar esquema/versión desconocidos;
deduplicar por `alert.id`; persistir la recepción antes de ACK; y no imprimir URL,
headers o body en logs. El endpoint real y el token solo existen después de crear
el trigger en una instancia Ankay desplegada. No hay un webhook real configurado
en este checkout.

### Despacho gobernado de acciones

Para cualquier playbook con permisos de proveedor, el origen autorizado es el
despachador QAPAQ del outbox durable, nunca el navegador ni una regla Wazuh directa.
El mensaje debe traer `playbookId` y `playbookVersion` del catálogo, `executionKey`
estable, `incidentRef`/`alertRef` opacos, referencias de evidencia aprobadas,
alcance, aprobaciones y expiración. Firmar el cuerpo con HMAC, validar timestamp,
nonce, firma, tamaño y replay en el primer nodo. El backend QAPAQ es la autoridad
de aprobación y auditoría; Ankay solo ejecuta la versión fijada.

El adaptador Wazuh directo actual **no implementa HMAC, callback ni aprobación**.
No se debe reutilizar como vía de ejecución. El webhook al Manager se mantiene
acotado a triage de solo lectura; para ejecutar acciones, esperar el contrato del
outbox y callback QAPAQ descrito en ADR-028.

## Playbooks de primera etapa

1. **Triage de alerta Wazuh de alta confianza (`triage.wazuh-high-severity`).**
   Trigger: alerta nivel 12+ y regla/grupo permitido. Valida esquema, deduplica,
   registra `alertRef`, severidad y agente; clasifica para revisión humana. No
   consulta ni cambia proveedores.
   La regla endpoint QAPAQ `101100` (Outlook lanza intérprete/LOLBin) permanece en nivel 8 y fuera del forwarder automático nivel 12+. El analista puede abrir un caso y solicitar triage read-only; no se ejecuta una respuesta desde la regla. Ver fixtures y requisitos en [`infra/wazuh/endpoint/`](../../../infra/wazuh/endpoint/README.md).
2. **Triage de URL de phishing (`phishing.m365-url-triage`).**
   Trigger: alerta de correo/M365 en Wazuh y caso admitido por QAPAQ. Usa referencias
   opacas para que un adaptador autorizado recupere solo los campos necesarios.
   Extrae/normaliza URL sin abrirla, vincula eventos de Exchange/Entra y crea un
   resumen con procedencia. No busca ni descarga mensajes completos por defecto.
3. **Enriquecimiento de IOC (`threat-intel.lookup`).** Busca SHA-256, dominio o IP
   en VirusTotal Enterprise y fuentes aprobadas; una URL solo se consulta después
   de revisión de privacidad/contrato. Conserva fuente, fecha y veredicto; trata
   reputación como señal, no como prueba suficiente para bloquear. No sube muestras
   ni consulta IOCs sensibles/PII. El API público de VirusTotal no es admisible para
   un servicio comercial; requiere plan/licencia que permita el uso empresarial.
4. **Correlación de malware Sophos (`malware.sophos-correlate`).** Correlaciona
   `event_id`, endpoint opaco, hash y timestamp con el evento Wazuh/Sophos. Lee
   estado de detección/remediación; no aísla, limpia ni altera políticas.
5. **Correlación de red Cato (`network.cato-correlate`).** Correlaciona IOC y
   evento/marker de `eventsFeed`, site/asset y tiempo. El cursor de Cato se conserva
   tal como viene y fuera de la ejecución puntual del playbook. No cambia firewall,
   Threat Prevention ni reglas.
6. **Anomalía de identidad M365 (`identity.m365-risk-triage`).** Usa eventos ya
   indexados por Wazuh y, si se habilita con permiso mínimo, lecturas autorizadas de
   Graph para sign-ins, auditoría/alertas. No revoca sesiones, cambia roles ni
   deshabilita usuarios.
7. **Aviso y escalamiento (`notification.soc-critical`).** Entrega a Teams por el
   outbox/notificador QAPAQ (ADR-022). Ankay registra referencia de ejecución, pero
   no emite un segundo aviso crítico ni interpreta un ACK de Teams como aprobación.

## Acciones con efectos: deshabilitadas

Las siguientes son solicitudes de acción separadas; no forman parte de los
playbooks de enriquecimiento y permanecen desactivadas hasta completar contratos,
permisos, pruebas y aprobación SoD:

- Aislar/quitar de aislamiento un endpoint con Sophos.
- Bloquear/desbloquear un IOC en Cato.
- Revocar sesiones M365 o deshabilitar una identidad.
- Wazuh Active Response, cuarentena o cambios de agentes/reglas.

Cada acción requiere un actor distinto del aprobador, capability contextual,
alcance explícito, motivo/ticket, vencimiento, idempotency key, dry-run, evidencia
antes/después, comprobación del resultado y rollback/compensación probado. Ni la
severidad por sí sola ni un resultado de VirusTotal autorizan contención automática.

## Credenciales y límites de proveedor

No hay valores ni URIs de credenciales versionados. Cuando los contratos se
aprueben, consumir por identidades administradas/Key Vault, separados por
conector y entorno: `M365_GRAPH_READ`, `SOPHOS_SIEM_READ`, `CATO_EVENTS_READ` y
`VIRUSTOTAL_ENTERPRISE_LOOKUP`. No entregar a Shuffle credenciales de Indexer,
Manager, Azure admin, acciones de escritura o Teams; preferir referencias a datos
y adaptadores QAPAQ de mínimo privilegio.

- Microsoft Graph `security/alerts_v2` es de solo lectura con permiso mínimo
  `SecurityAlert.Read.All`; sign-ins/audit logs requieren permisos/licencias
  correspondientes. El recolector actual de M365 sigue siendo Wazuh; Graph paralelo
  está pendiente de aprobación de scopes y prueba técnica.
- Sophos SIEM Integration API permite leer eventos de las últimas 24 h, pagina con
  `next_cursor` y puede volver al rango de 24 h si el cursor queda fuera; no asumir
  backfill histórico.
- Cato `eventsFeed` exige continuar con el `marker` opaco devuelto y conserva los
  eventos aproximadamente tres días; no parsear ni reconstruir el marker.
- VirusTotal Public API está limitado y sus términos lo excluyen de productos,
  servicios o workflows comerciales. Se necesita acuerdo privado/Enterprise que
  permita el caso financiero. Un lookup puede divulgar el IOC al proveedor/dataset;
  no buscar direcciones internas, URLs con tokens, PII ni adjuntos confidenciales.
  No subir archivos de correo a VirusTotal en la fase inicial.

## Secuencia de habilitación

El inventario de proyectos upstream, automatizaciones priorizadas y controles de
falsos positivos está en [`opensource-roadmap.md`](opensource-roadmap.md). Los
workflows aún no se importaron en Ankay.

1. Desplegar Ankay (frontend overlay más backend/Orborus/workers/OpenSearch de
   Shuffle) en la VM privada prevista; inicializar persistencia y backup/restore.
2. Crear el workflow de triage, emitir URL/credencial en Ankay, guardar el secreto
   en Key Vault y entregarlo al Manager mediante identidad administrada. Aún no hay
   trigger o host real en Azure.
3. Validar primero un evento sintético en entorno aislado: TLS, auth, esquema,
   tamaño, dedupe, retries, ACK, registro y ausencia de datos sensibles en logs.
4. Conectar solo alertas Wazuh nivel 12+; revisar volumen y falsos positivos.
5. Añadir cada proveedor en lectura con permisos mínimos, prueba sintética,
   paginación, 401/403/429/5xx, rate limit, cursor, replay, lag y lineage.
6. Implementar el despachador outbox QAPAQ→Ankay y callback firmado; probar
   duplicados, replay, timeout `UNKNOWN`, reconciliación y revocación.
7. Aprobar las acciones con efectos una a una; comenzar en sandbox/dry-run.

## Referencias oficiales

- [Microsoft Graph: list alerts_v2](https://learn.microsoft.com/en-us/graph/api/security-list-alerts_v2?view=graph-rest-1.0)
- [Microsoft Graph: auditoría y sign-ins](https://learn.microsoft.com/en-us/graph/api/resources/azure-ad-auditlog-overview?view=graph-rest-1.0)
- [Sophos SIEM Integration API](https://developer.sophos.com/siem/)
- [Cato GraphQL API / eventsFeed](https://api.catonetworks.com/documentation/)
- [VirusTotal: API v3 overview](https://docs.virustotal.com/reference/overview)
- [VirusTotal: uso público frente a Enterprise](https://docs.virustotal.com/reference/public-vs-premium-api)
- [VirusTotal: aviso de privacidad de IOCs](https://docs.virustotal.com/reference/rescan-ip)
- ADR-028 de la rama `feature/ankay-qapaq`: Shuffle como motor SOAR; conservar ese
  contrato al portar el documento a la rama de despliegue.
