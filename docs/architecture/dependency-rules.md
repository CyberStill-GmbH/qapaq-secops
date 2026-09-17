# Reglas de dependencia

Estado: PROPOSAL de enforcement; invariantes requeridas por arquitectura hexagonal.

## Dentro del módulo

domain depende solo del lenguaje/librerías puras aprobadas; no NestJS, decoradores
de ORM, PostgreSQL, Redis/BullMQ, SDK Graph/Wazuh/Sophos/Cato, HTTP ni filesystem.
application depende de domain y ports propios; no implementaciones concretas.
infrastructure implementa ports y traduce contratos externos.
presentation traduce HTTP/WebSocket/jobs a casos de uso; sin consultas directas a
bases ni decisiones de negocio. composition root conoce adapters para ensamblar,
sin convertirse en service locator accesible desde dominio.

DTO, entidad ORM y agregado de dominio son distintos. Reutilizar una forma solo
si conserva semántica y no filtra dependencias; no copiar ciegamente cada campo.

## Entre módulos

Ningún módulo importa domain/infrastructure internos de otro ni escribe sus tablas.
Importar solo contratos públicos estables o invocar casos de uso expuestos con
contexto de autorización explícito. Reexports, aliases e imports type-only también
cuentan. shared no permite evadir ownership.

Contratos de colaboración evitan ciclos: access evalúa capabilities, no depende
de soc; el caso de uso soc combina esa evaluación con sus reglas del recurso.
audit recibe registros, no llama de vuelta a módulos para reconstruir snapshots.
workspace consume consultas/proyecciones, no obliga a productores a depender de UI.

Para consultas inmediatas, llamada síncrona tipada; para side effects recuperables,
outbox con evento versionado. Eventos no cargan entidades ORM ni secretos. No usar
eventos en memoria para afirmar entrega durable. No imponer transacciones
distribuidas; definir consistencia y compensación por flujo.

## Enforcement futuro

Configurar reglas de lint/imports o un dependency checker adecuado al toolchain:
prohibir imports de infraestructura/framework desde domain/application, internals
cruzados, ciclos y dependencias de apps desde contracts. Definir ownership de schemas
de base con permisos/migraciones por módulo, aunque comparta una instancia.

El gate ejecuta fixtures de violación para demostrar que la regla detecta bypasses;
no basta que pase un repositorio vacío. Revisar imports dinámicos/DI, consultas
cruzadas y aliases manualmente. Excepciones específicas requieren ADR con alcance
y justificación, no comentarios «temporary» permanentes.
