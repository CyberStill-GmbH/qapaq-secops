# Integraciones y adapters

Fronteras, ownership, adapters independientes y orden de pilotos: CONDITIONALLY
ACCEPTED por [ADR-019](../adr/019-source-boundaries-and-authorized-pilots.md).
Entra como IdP humano: ACCEPTED por ADR-017. Contratos concretos de proveedor:
PROPOSAL hasta prueba autorizada. Producto mencionado no equivale a conexión.

## Ports mínimos por necesidad

Microsoft Entra ID mediante IdentityProvider en access autentica humanos;
DirectoryProvider
en connectors consulta usuarios/grupos/equipos para inventario/contexto. No mezclar
login con importación de eventos. SecurityEventProvider entrega lotes/cursor y
semántica de replay. EndpointSecurityProvider entrega inventario/estado/señales;
NetworkSecurityProvider entrega señales de red. No incluyen remediación por defecto.

ThreatIntelligenceProvider pertenece a Threat Intelligence y obtiene indicadores/
contexto con procedencia y vigencia;
SIEMProvider consulta señales/reglas referenciadas/salud disponibles. SecretProvider
resuelve una referencia con privilegio técnico acotado. NotificationProvider es consumido por SOAR, Playbooks & Ticketing y envía
un mensaje mínimo a un destino previamente aprobado, sin incluir raw por defecto.
Estos nombres representan contratos conceptuales; crear una interfaz ejecutable
solo cuando exista consumidor y adapter concreto.

ObjectStoragePort, EventQueryPort y JobQueuePort pertenecen a consumidores de
aplicación. Infrastructure implementa; composition root conecta. Ningún port
expone SDK, connection string, cliente ORM ni un objeto vendor genérico.

## Proveedores

Wazuh, Microsoft, Sophos y Cato son slices independientes dentro del único módulo
`Integrations & Collectors`, no nuevos módulos de negocio. Comparten admisión, pero
no un adapter genérico. La [estrategia de fuentes](source-integration-strategy.md)
define pilotos, semántica, checkpoints, replay, duplicidad y gate; el
[inventario](../integrations/source-inventory.yaml) conserva valores reales pendientes.

### ActiveDirectoryAdapter

Distinguir lectura de directorio de captura de Windows Event Log. Evaluar
directorio con transporte cifrado y cuenta read-only; telemetría preferentemente
por mecanismos existentes Wazuh/forwarding. No asumir LDAP entrega security logs.
AD no sustituye el IdP web Entra aceptado. WinRM solo si se justifica y autoriza; no canal de
ejecución remota genérico en el MVP.

ADR-022 acepta una implementación concreta y acotada del `NotificationProvider`
para el MVP: Microsoft Teams Workflows. El adapter resuelve
`secret://qapaq/notifications/teams-critical`, envía solo el payload permitido y
no expone la URL. El contrato de aceptación de Teams no se interpreta como lectura
o acuse. Office 365/Microsoft 365 Connectors heredados quedan prohibidos.

### MicrosoftGraphAdapter

Usuarios/grupos, identidad, sign-ins y actividad según API, permisos y licencia
verificados. Graph no representa automáticamente toda la auditoría de Microsoft 365;
otros feeds deben evaluarse por separado. Sign-ins v1.0 tiene permisos y límites
de consulta documentados; no asumir que sus datos cubren cualquier tipo de inicio
de sesión. [Referencia Microsoft](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0).

Registrar endpoints/versiones exactos solo en ficha aprobada del conector; usar
permisos mínimos por operación, paginación con validación del destino y throttling.
Lectura de correo requiere caso de detección y alcance autorizado, no permiso
global preventivo. Nunca reutilizar token de login del analista para un collector.
El delta sync de admisión aceptado usa solo atributos mínimos y falla cerrado para
nuevos privilegios; su app permission, licencia y comportamiento real deben probarse.

### CatoAdapter

Fuente prevista para red/VPN, sesiones y seguridad. Evaluar API de eventos/feed,
cursor, ventanas y cuotas con documentación oficial y entorno autorizado.
[Catálogo EventsFeed](https://support.catonetworks.com/hc/en-us/articles/360019839477-Cato-API-EventsFeed-Large-Scale-Event-Monitoring).
La página no pudo recuperarse íntegramente en esta revisión: no se fijan endpoints,
campos, retención ni límites como hechos. La edición y capacidades de Qapaq son UNKNOWN.

### SophosAdapter

Inventario/estado de endpoints, alertas y detecciones según producto contratado.
Sophos Central, firewall y otros productos no se tratan como la misma API. Evaluar
autenticación, región, paginación y capacidades por producto mediante
[portal oficial](https://developer.sophos.com/intro); extracción textual no disponible
en esta revisión. No asumir cuarentena/remediación accesible ni habilitar escritura.
FutureEDRAdapter puede implementar el mismo port si conserva semántica explícita.

### WazuhAdapter

Separar Wazuh Manager API para administración/estado disponible de consultas de
telemetría en Indexer. Agents son parte del ecosistema Wazuh, no módulos dentro
del backend. Consumir alertas existentes y preservar ruleId/origen; no reimplementar
decoders, inventario o capacidades SIEM sin necesidad demostrada. Credenciales y
permisos de Manager/Indexer son independientes.
QAPAQ SecOps continúa siendo propietario de correlación, casos, RBAC, dashboards,
auditoría, reporting y SOAR. `wazuh-alerts-*` produce `WAZUH_ALERT`, no raw original.

### Firewalls, IDS/IPS, servidores y endpoints

Adapters específicos bajo NetworkSecurityProvider o SecurityEventProvider. Syslog,
agentes y APIs comparten normalización, no necesariamente transporte. Documentar
pérdida posible de UDP, framing, timestamps, autenticación y duplicación entre
Wazuh y collector directo. Elegir una ruta primaria por dataset y registrar
procedencia de duplicados, sin deduplicar señales distintas por parecido.

### MISP — siguiente vertical de Threat Intelligence

ThreatIntelligenceProvider encapsula consulta/ingesta IOC, reputación y contexto.
Mantener distribución, clasificación, expiración, confidence de origen y permisos
de indicadores. No enviar indicadores internos a terceros por enrichment automático.
No convertir coincidencia de IOC por sí sola en compromiso confirmado.

## Ficha de habilitación por conector

Antes de activar: dueño funcional/técnico, producto/versión, dataset, contrato
real, scopes, secretRef, destinos permitidos, límites/paginación, checkpoints,
retención del origen, raw y clasificación, health, retry/replay, mapping versionado,
pruebas sintéticas y prueba autorizada controlada. Estado: planned → configured →
validated → enabled; degradado/paused con motivo y auditoría. Nunca enabled solo
porque el SDK importa.

Pilot A valida Wazuh; Pilot B valida un dataset directo Microsoft y correlación
multifuente. Sophos y Cato se incorporan después de demostrar el contrato común.

Configurar timeouts, tamaño máximo y circuit breaker si aporta aislamiento.
No permitir URL arbitraria con credenciales: validar esquema, hostname, puerto,
resolución y redirecciones frente al allowlist específico, incluso para destinos
internos aprobados. Un collector comprometido no debe alcanzar metadata services.

Los tests unitarios/contract con fakes no prueban acceso real. Reportar aparte
conectividad, alcance y observación de cursor/replay en el entorno autorizado.

[Diagrama de adapters](../diagrams/08-integrations.mmd).
