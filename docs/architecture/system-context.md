# Contexto del sistema

Estado: PROPOSAL, salvo hechos explícitos de [R-01/R-10](../requirements.md).

## Actores

Analistas SOC realizan triage, investigación y seguimiento. Administradores SOC
gestionan reglas y capacidades operacionales. Auditores consultan evidencia
autorizada; administradores de plataforma operan dependencias sin obtener por
defecto acceso a toda evidencia. Infraestructura provisiona redes, almacenamiento,
identidad técnica y backups conforme a requisitos acordados.

Los nombres de roles son plantillas de diseño, no usuarios ni asignaciones reales.
Financiera Qapaq es la organización destinataria; no hay datos personales en estos
documentos.

## Sistemas fuera del límite de la aplicación

Microsoft 365, Cato y Sophos son productos informados por la solicitud. AD, Wazuh,
firewalls, IDS/IPS y fuentes Windows/Linux/cloud se contemplan con alcance por
confirmar. MISP y otros proveedores son futuros. La disponibilidad de una API o
un producto no prueba que la cuenta disponga de licencia, permisos o conectividad.

Wazuh sigue siendo responsable de sus agentes, decoders y detecciones propias.
Qapaq añade gestión transversal, contextualización, casos y auditoría. No configura
automáticamente Active Response ni administra endpoints de fabricantes.

PostgreSQL, Redis, indexador y object storage son dependencias provisionadas por
otro equipo; despliegue concreto UNKNOWN. Un proveedor corporativo de identidad
es preferible a credenciales locales; su selección está pendiente.

## Fronteras de confianza

1. Navegador → API: datos, IDs, headers y campos de rol son no confiables. Autorización del backend sobre el objeto real.
2. API/jobs → módulos: contexto de actor explícito, no ambient global; un job no hereda privilegios ilimitados.
3. Proveedores → collectors: identidad de fuente, TLS y validación; contenido de logs no es código.
4. Workers → stores: cuentas con permisos por función; acceso a raw separado de búsqueda.
5. Administración → configuración/secretos: autorización reforzada, razón y auditoría; referencias de secretos, no valores.
6. Plataforma → evidencia/exportaciones: controles de descarga y caducidad, sin links públicos ni envío no autorizado.

## Frontend SOC

Vistas previstas: resumen operativo, alertas, incidentes, casos, activos, usuarios,
integraciones, detecciones/reglas, inteligencia, reportes, auditoría y configuración.
Las capacidades efectivas determinan navegación y acciones; backend revalida cada
solicitud. Mostrar estados desactualizado, parcial, restaurando y degradado; nunca
traducir «fuente desconectada» a «cero amenazas».

No llamar vendors ni stores desde React; no entregar tokens de integraciones al
navegador. La UI presenta raw solo con permiso específico, contenido escapado y
límites, nunca como HTML confiable.

Ver [diagrama de contexto](../diagrams/01-system-context.mmd) y
[contenedores conceptuales](../diagrams/02-containers.mmd).
