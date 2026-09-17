# ADR-011 — SecurityEvent normalization strategy

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-08 exige modelo común, raw y evaluación de ECS/OCSF sin copia ciega.

## Decision

Proponer núcleo SecurityEvent propio v1 con semántica de campos inspirada en ECS; mantener mapping hacia clases/categorías OCSF como evaluación de interoperabilidad. rawEvent referencia bytes originales con digest y acceso restringido. No declarar conformidad ECS/OCSF.

## Alternatives

Adoptar ECS completo favorece su ecosistema pero amplía superficie. OCSF completo estandariza clases de seguridad con mayor mapping. Ad hoc sin diccionario deriva y rompe reglas.

## Consequences

Separar IDs nativos/internos y tiempos; validar schema/versiones; preservar desconocidos y calidad sin inventar valores. Detection no consume formatos de vendors.

## Trade-offs

Núcleo pequeño reduce fricción inicial pero Qapaq asume mantenimiento del schema y mappings. Se necesita corpus representativo antes de congelarlo.

## Validación y revisión

Comparar clases de autenticación, red y endpoint con fixtures; fijar versiones de referencias y schema completo antes de aceptar v1.

[Diseño relacionado](../architecture/event-model.md) · [Preguntas abiertas](../decisions/unresolved.md).
