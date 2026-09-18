# Seguridad de la arquitectura

Identidad/autorización: ACCEPTED por ADR-017. Los demás controles técnicos
permanecen PROPOSAL. No constituye certificación de cumplimiento.
[Threat model](../threat-model.md), [RBAC](rbac.md), [API](../api-guidelines.md).

## Identidad y sesión

Microsoft Entra ID es el único IdP humano ordinario. Usar tenant corporativo
explícito, OIDC Authorization Code con PKCE S256 y BFF NestJS. No construir IdP
propio ni almacenar passwords. La decisión está aceptada; producción sigue
bloqueada hasta el [gate de federación](identity-and-authorization.md).

La web usa sesión opaca server-side y cookie `__Host-qapaq_session` Secure,
HttpOnly, SameSite=Lax, Path=/ y sin Domain. Proteger mutaciones con CSRF y
Origin/Referer; React no recibe ni almacena tokens. Validar firma, issuer,
audience, `tid`, expiración/not-before, state, nonce, PKCE y redirect exacta.

Revocación y cambios de rol invalidan capacidades cacheadas mediante versión de
política/sesión; comportamiento ante fallo es deny para decisiones no verificables.
No delegar autorización a claims de rol no mapeados ni al botón visible en React.

## Autorización en profundidad

Capacidades explícitas, scope de datos y restricciones de objeto/campo en aplicación.
Backend valida también descargas, exportaciones, WebSocket y jobs. Un actor técnico
tiene permisos mínimos; un job guarda identidad/procedencia y revisa vigencia de
permiso cuando representa acción humana demorada. Acciones técnicas continuas
usan su propia política, no requieren sesión humana viva ni privilegio universal.

Aislar acceso a raw de búsqueda y a administración de plataforma de evidencias.
No crear multitenancy: QAPAQ es una organización y sus unidades son scopes.
Cambios de asignaciones no permiten autoescalada; JIT, doble aprobación y
segregación se aplican según ADR-017.

## SecretProvider

Integraciones guardan secretRef opaca, versión y metadatos no sensibles.
Provider resuelve bajo identidad del workload; nunca devuelve secretos a React,
API general, logs o auditoría. Azure Key Vault, Vault y proveedor de entorno son
alternativas; entorno solo para desarrollo local controlado/CI autorizado, sin
.env versionado. No asumir proveedor productivo. Rotación/revocación y fallo seguro
deben probarse; cache corta en memoria con redacción de excepciones.

SecretProvider no elimina secretos de los dumps de memoria ni sustituye controles
del host. Aplicar mínimo acceso, cifrado de tránsito/reposo con llaves administradas
por Infraestructura y separación entre operadores/lectores.

## Datos hostiles y evidencia

Validar tamaños antes de parseo; tipos runtime y campos permitidos; límites de
expansión de comprimidos; timestamps no confiables. SQL parametrizado, query DSL
controlada, encoding contextual en UI. Prohibir eval, pickle y shell interpolado.
Raw se muestra como texto escapado o descarga segura; no ejecutar adjuntos.
No incorporar datos reales a fixtures ni enviar payloads a servicios no autorizados.

Integraciones pueden necesitar direcciones privadas legítimas; la defensa SSRF
es allowlist por destino/operación y control de egress, no bloquear toda IP privada.
Bloquear destinos no autorizados y cambios por redirección/DNS que evadan política.

## Operaciones críticas y SOAR de implementación incremental

Activar reglas, cambiar retención, exportar evidencia, cambiar RBAC y configuraciones
requiere razón y auditoría durable. ADR-017 exige doble control para grants
privilegiados y SOAR alto/crítico; purga/hold continúa pendiente de U-004.

SOAR, Playbooks & Ticketing es un módulo de alcance aceptado por ADR-015.
PlaybookVersion, Trigger, ActionDefinition, Execution y Approval son contratos
técnicos propuestos para ese límite; no se implementa motor en esta tarea. Una ejecución fija versión, targets, parámetros,
capability, razón y aprobación con caducidad; se reautoriza antes de la acción.
Separar leer alertas de aislar un endpoint. Timeout tras acción externa puede
significar resultado UNKNOWN; no reintentar una acción destructiva ciegamente.

## Auditoría y degradación

Mutaciones críticas fallan si no se puede persistir su auditoría local. Caída del
archivo remoto no obliga a tumbar lecturas si hay buffer durable, controles y
alertas de atraso. Límites del buffer y política fail-closed deben acordarse.
Raw y AuditEvent no son ApplicationLog. Ver [auditoría](audit.md).

## Desarrollo y controles operacionales

SAST, dependency/secret scanning, revisión de cambios, SBOM y container scanning
si aplica. Dependencias y acciones CI fijadas/revisadas; PR no confiable sin secretos.
TLS, cuentas por función, backups probados, límites de recursos y observabilidad
externa acordados con Infraestructura. No asumir acceso interno equivale a confianza.

OWASP API se usa como checklist para flujos reales, especialmente autorización de
objeto/campo/función, consumo, SSRF y confianza en proveedores; no como garantía
automática. [Fuente primaria](https://api-security.owasp.org/editions/2023/en/0x11-t10/).
