# ADR-025 — Endurecimiento de acceso, secretos y observabilidad SOC

Estado: Conditionally Accepted · Fecha: 2026-09-28 · Origen: requerimientos de Franco Clavo.

Decision owners: Product Owner + Security + Identity + Platform/SOC.

## Context

ADR-017 permitía tres sesiones, dejaba ubicación de red y passkey como condiciones
por confirmar, y ADR-021 conservaba el backend de observabilidad sin seleccionar.
La incorporación futura de APIs requería `secretRef`, pero no estaba definido el
flujo humano write-only ni un catálogo de errores operable por usuarios.

## Decision

Adoptar el baseline de
[acceso, credenciales y observabilidad SOC](../architecture/security-access-observability-baseline.md):

- una sesión humana activa por usuario, con rechazo del segundo login y garantía transaccional;
- sin `SUPERADMIN`; conservar SoD y break-glass gobernado en Entra;
- Smart Lockout de Entra y rate limiting anónimo genérico en QAPAQ;
- acceso humano solo desde red QAPAQ mediante Conditional Access e ingress/BFF;
- passkey FIDO2 en Entra dentro del flujo OIDC existente, sin credencial local;
- credenciales de adapters ingresadas una vez por control plane QAPAQ write-only,
  custodiadas por SecretProvider externo y materializadas en KrakenD/adapter solo en runtime;
- Grafana OSS + Loki + Prometheus autogestionados, manteniendo OpenTelemetry Collector y separación de auditoría;
- catálogo de errores estable y accionable para UI/API.

La selección de observabilidad busca conservar control directo y reducir la
tercerización frente a las obligaciones del SGSI-C de la Resolución SBS N.°
504-2021. No se interpreta como mandato de marca ni exención automática. El
[sustento técnico-normativo](../compliance/sbs-observability-rationale.md) define
los artículos aplicables y el gate obligatorio de Legal/Compliance.

## Consequences

Identity e Infraestructura deben entregar datos de red, políticas Entra, proxy,
secret manager y plataforma observable. La sesión única exige coordinación
transaccional. El stack OSS exige sizing, parches, backups, seguridad y guardia; no
es “gratis” operacionalmente. Loki/Prometheus no se exponen directamente. El stack
no almacena traces: se conserva contexto correlacionable y se evalúa Tempo aparte.

La centralización de secretos simplifica alta/rotación, pero cada proveedor todavía
requiere contrato, mapping y pruebas reales. Un secreto write-only sigue siendo
resoluble por la identidad técnica; “no visible” no significa “irrecuperable para el runtime”.

## Alternatives rejected

- Un `SUPERADMIN` universal elimina separación de funciones y amplía el blast radius.
- Bloqueo local por username duplica al IdP y facilita DoS dirigido.
- IP como único autenticador es insuficiente fuera de un borde confiable.
- WebAuthn propio duplica lifecycle, recuperación y custodia ya delegados a Entra.
- Guardar API keys cifradas en PostgreSQL de negocio crea un vault casero.
- Exponer Loki/Prometheus o habilitar Grafana anónimo filtra topología y telemetría.
- Llamar “tracing completo” al trío solicitado sería falso sin backend de trazas.

## Validation

Los gates y evidencia están en el baseline. La decisión permanece condicionada
hasta que las pruebas de federación, red, sesión única, rotación, no revelación,
observabilidad y recovery pasen en ambiente autorizado.
