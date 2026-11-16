# 21 · Postura de seguridad y limitaciones conocidas

> Estado (2026-11-08). Postura del despliegue vigente ([02](02-arquitectura.md)). Lo que es un plan
> de mejora está en [19](19-brechas-y-roadmap.md).

## Controles vigentes

| Área | Control | Dónde |
| --- | --- | --- |
| Borde | ALB con TLS 1.3/1.2 (ACM) y WAFv2 (IpReputation, KnownBadInputs, CommonRuleSet, 2000 req/5 min por IP); el nodo solo acepta 443 desde el ALB | `public.tf` |
| Acceso administrativo | SSH solo desde `allowed_admin_cidrs` (una IP /32; Terraform rechaza `0.0.0.0/0`) y con clave ed25519 | `variables.tf`, `dev.tfvars` |
| Agentes | 1514/1515 abiertos a Internet (decisión del dueño, 2026-11-03); enrolamiento con contraseña obligatoria y clave por agente | `AGENTS.md` |
| Identidad | Un solo login (QAPAQ) con proxy auth; el indexer confía en las cabeceras solo desde la IP fija del dashboard; el formulario del Security plugin no es accesible | [04](04-identidad-y-acceso.md) |
| Sesión | Cookie `HttpOnly; Secure; SameSite=Strict`, 8 h máx., 30 min de inactividad, sesión única por cuenta, revocación inmediata | `apps/api` |
| Autorización | Denegación por defecto, 4 roles, negaciones auditadas; SoD en cambios de rol | `modules/access` |
| Auditoría | Cadena SHA-256 append-only en PostgreSQL con verificación desde la consola | `platform/audit` |
| Datos | EBS y bucket de evidencia con CMK (rotación); PostgreSQL con TLS; buckets sin acceso público y TLS obligatorio | `main.tf` |
| Secretos | Generados en el host (`/opt/qapaq/secrets`, 0700/0600); nunca en Git, estado ni user_data | [06 §5](06-operacion.md#5-secretos-en-el-host) |
| Ingesta | Lector `qapaq_reader` de solo lectura (autoprueba: búsqueda 200, escritura 403) detrás de un gateway con token | `setup-ingestion.sh` |
| Respuesta | Active Response de Wazuh apagada; contención en Ankay deshabilitada por defecto y con aprobación del Líder | [16](16-politicas.md), [10](10-decisiones.md) B12 |
| Monitoreo de la propia cuenta | EventBridge → SNS → Wazuh en 17 regiones, con detección de manipulación del pipeline | [18](18-integraciones.md#aws-cuenta-061098277310) |

## Limitaciones por no tener IAM

El operador solo tiene `SOC-PowerUser`: no puede crear roles ni hacer `iam:PassRole`. Por eso:

- **Sin Bedrock.** Qapaqzito usa la API directa de Anthropic con una clave en `services.env`; los datos
  del SOC (seudonimizados) salen a Anthropic en lugar de quedarse en la cuenta.
- **Sin módulo AWS de Wazuh.** Necesita credenciales en el host. Se reemplazó por el push
  EventBridge → SNS (políticas de recurso). Consecuencias: solo eventos de **escritura** de gestión;
  sin eventos de datos, sin Flow Logs, sin CloudWatch Logs.
- **Sin Secrets Manager / SSM ni Session Manager:** secretos en archivos del host y acceso por SSH.
- **Sin DLM ni respaldo automático a S3:** respaldos manuales ([06 §6](06-operacion.md#6-respaldos-y-restauración)).
- **Sin Entra real:** identidad fija de demo con cuentas de contraseña sin MFA (excepción N13 con
  vencimiento ≤ 30 días). Ver modelo de amenaza en [04](04-identidad-y-acceso.md).

## Servicios de seguridad de AWS apagados

GuardDuty y Security Hub están **apagados** (son de pago y opcionales). Las reglas EventBridge y las
reglas Wazuh de sus hallazgos (101663–101673) están listas: si QAPAQ los activa, los hallazgos medios,
altos y críticos llegan solos sin cambios en el SOC.

## Límites de la cuenta de administración

- El trail de la organización vive en la cuenta de administración (258231095330) y no entrega a
  EventBridge de la cuenta 061098277310; por eso se creó un trail propio de la cuenta.
- Identity Center (permission sets, asignaciones) se administra en la cuenta de administración: esos
  cambios **no** llegan al SOC.
- Las SCP y cambios de Organizations solo se ven si ocurren desde esta cuenta.
- Reenviar a un bus central exigiría un rol IAM: cada región tiene su propio tema (centinela).

## Riesgos aceptados (demo)

| Riesgo | Mitigación actual |
| --- | --- |
| Nodo único: fallo de EC2, disco o Docker detiene todo el SOC | Despliegue idempotente desde el repo; respaldos manuales; brecha #8 |
| Cuentas demo de un solo factor | Contraseñas largas y únicas, vencimiento, tope de intentos, bloqueo, auditoría, revocación; ninguna cuenta demo aprueba roles |
| Token estático del gateway sin vencimiento | Alcance de solo lectura; no publicado fuera de la red Docker; rotación documentada |
| Puertos de agentes abiertos a Internet | Contraseña de enrolamiento y clave por agente; restringir `agent_cidrs` cuando se conozcan los orígenes |
| Fuentes clave bloqueadas (M365, correo) | Estado visible en «Integraciones»; brecha #9 |
| Respond basado en un upstream AGPL con muchas piezas (backend, orborus, OpenSearch propio) | Solo detrás de la sesión QAPAQ, sin puertos, cookies acotadas a `/ankay`; código fuente publicado dentro de la imagen (AGPL §13) |

## Decisión: Claude en lugar de DeepSeek

Para Qapaqzito se evaluó DeepSeek y se **descartó en favor de Claude (Anthropic)** por residencia y
tratamiento de los datos del SOC. El código rechaza `QAPAQ_QAPAQZITO_PROVIDER=deepseek` desde el arranque
(`platform/configuration/test/assistant-config.spec.ts`, `apps/api/test/assistant-anthropic.spec.ts`).
Proveedores admitidos: `anthropic` (vigente, modelo por defecto `claude-sonnet-5-5`) y `bedrock`
(cuando haya IAM). El envío de datos a Anthropic requiere el visto bueno de Legal (N1/N2,
[15](15-qapaqzito-asistente.md)).
