# Contexto del sistema

Actores/identidad: ACCEPTED por ADR-015/017; fronteras de fuentes: CONDITIONALLY
ACCEPTED por ADR-019; vertical MVP ACCEPTED / IMPLEMENTATION REQUIRED por ADR-024.
La visión de Qapaq SecOps como plataforma SIEM/XDR se rige por
[ADR-029](../adr/029-qapaq-secops-product-direction.md); el despliegue resiliente
es objetivo gated por [ADR-030](../adr/030-resilient-platform-architecture.md).

## Actores

Analistas SOC realizan triage, investigación y seguimiento. Administradores SOC
gestionan reglas y capacidades operacionales. Auditores consultan evidencia
autorizada; administradores de plataforma operan dependencias sin obtener por
defecto acceso a toda evidencia. Infraestructura provisiona redes, almacenamiento,
identidad técnica y backups conforme a requisitos acordados.

Riesgos/Antifraude gobierna reglas, criterios, casos y decisiones antifraude según
U-001; usa capacidades compartidas sin perder su ownership. Los bundles de roles
están aceptados por ADR-017; no representan usuarios ni asignaciones existentes.
Financiera Qapaq es la organización destinataria; no hay datos personales en estos
documentos.

## Sistemas fuera del límite de la aplicación

Microsoft 365 y Wazuh son los sistemas externos de la vertical MVP: Wazuh recolecta
la actividad Microsoft, aplica ruleset y expone alertas; QAPAQ consume el Indexer
read-only a través de KrakenD CE on-premises. KrakenD no se ubica entre Microsoft
365 y Wazuh. Cato, Sophos, MISP y rutas directas son post-MVP. La disponibilidad
pública de una API no prueba edición, licencia, dataset, permiso, cuota ni conectividad.

QAPAQ SecOps es la plataforma SIEM/XDR y la consola principal del SOC. Wazuh aporta
agentes, HIDS, FIM, SCA, inventario, vulnerabilidades, decoders, reglas y alertas
integradas. QAPAQ añade contrato canónico, priorización/correlación complementaria,
investigación colaborativa mediante Ayni Qapaq, casos, RBAC, reporting, auditoría y
respuesta gobernada. No configura automáticamente Active Response ni administra
endpoints de fabricantes. Después del MVP no se define un Wazuh Dashboard separado
como destino de la experiencia SOC; una transición solo se completa tras probar
paridad operativa en la consola QAPAQ.

PostgreSQL, Redis, indexador y object storage son dependencias provisionadas por
otro equipo; despliegue concreto UNKNOWN. Microsoft Entra ID es el IdP humano
aceptado. Configuración, licencias y pruebas permanecen pendientes del gate de ADR-017.

## Fronteras de confianza

1. Navegador → BFF/API: cookie opaca y CSRF; datos, IDs, headers y campos de rol son no confiables. Autorización del backend sobre el objeto real.
2. API/jobs → módulos: contexto de actor explícito, no ambient global; un job no hereda privilegios ilimitados.
3. Proveedores → collectors: identidad de fuente, TLS y validación; contenido de logs no es código.
   APIs directas atraviesan LB/KrakenD allowlisted; el gateway no acepta upstreams
   arbitrarios, no almacena raw y no publica directamente en BullMQ.
4. Workers → stores: cuentas con permisos por función; acceso a raw separado de búsqueda.
5. Administración → configuración/secretos: autorización reforzada, razón y auditoría; referencias de secretos, no valores.
6. Plataforma → evidencia/exportaciones: controles de descarga y caducidad, sin links públicos ni envío no autorizado.

## Consola QAPAQ SOC

Vistas previstas: resumen operativo, alertas, incidentes, casos, activos, usuarios,
integraciones, detecciones/reglas, inteligencia, playbooks/tickets, antifraude,
reportes, auditoría y configuración.
Las capacidades efectivas determinan navegación y acciones; backend revalida cada
solicitud. Mostrar estados desactualizado, parcial, restaurando y degradado; nunca
traducir «fuente desconectada» a «cero amenazas».

No llamar vendors ni stores desde React; no entregar tokens de integraciones al
navegador. La UI presenta raw solo con permiso específico, contenido escapado y
límites, nunca como HTML confiable.

Ver [diagrama de contexto](../diagrams/01-system-context.mmd) y
[contenedores conceptuales](../diagrams/02-containers.mmd).
