# Correlación e investigación por episodio

Estado: implementación local, 2026-11-15. Sin despliegue ni medición de precisión en producción.

## Decisión de arquitectura

Se conserva el correlador Go existente. No se incorpora otro motor en Rust: en esta revisión no
se ha demostrado un cuello de botella que justifique duplicar resolución de entidades, estado,
reglas y operación. Un lenguaje distinto no elimina investigaciones duplicadas ni convierte
una correlación temporal en evidencia de compromiso. El trabajo prioritario es conectar la
identidad del candidato con la investigación y conservar sus miembros y revisiones.

El código ya tiene deduplicación por ID de observación, resolución de entidades, ventanas,
amortiguación de repetición por regla y candidatos explicables por patrón o umbral. La
agrupación estadística de `DedupAlerts` no es un expediente durable. Varios patrones pueden
producir candidatos superpuestos para una entidad; no deben ocultarse técnicas distintas
por compartir usuario o IP. Una futura consolidación entre candidatos necesita una identidad
de caso persistida y reglas explícitas de fusión, no solamente igualdad del pivote.

## Defectos corregidos

1. La admisión de miembros solo comprobaba límites superiores de tiempo. Una observación
   arbitrariamente antigua podía sumarse a un candidato actual. Ahora se exige pertenecer
   al intervalo desde `FirstSeen`, además del gap y duración máxima existentes. Las llegadas
   tardías dentro del intervalo siguen admitidas sin retroceder `LastSeen`.
2. Un candidato conservaba las fuentes y tácticas originales aunque recibiera nueva evidencia.
   Ahora incorpora fuentes y tácticas no suprimidas de los miembros nuevos. La IA puede
   reconocer corroboración posterior y evitar reutilizar una conclusión benigna obsoleta.
   La actualización copia las listas para no modificar instantáneas previamente entregadas.

No se cambia la severidad, no se cierra una alerta automáticamente y no se elimina evidencia
original del Indexer. El historial de falsos positivos debe servir para evitar inferencia
repetida solo cuando el contexto sigue siendo equivalente y suficientemente cubierto.

## Límites que siguen abiertos

- `QapaqAlertIDs` conserva como máximo 50 referencias; la explicación también limita los IDs.
  Son proyecciones, no una prueba de cobertura exhaustiva. No se debe prometer un informe
  completo sin recuperar y verificar todos los miembros mediante paginación durable.
- Los candidatos se mantienen en memoria. Reinicios y actualización de miembros requieren
  reconciliación con el almacén durable de investigaciones.
- Actualizar fuentes/tácticas no reescribe una notificación ya enviada ni el título histórico.
  El consumidor debe revisar la nueva evidencia y decidir si amerita una revisión del informe.
- Menos grupos no significa menos falsos positivos. La medición exige casos adjudicados,
  recall de verdaderos positivos, cobertura y volumen comparable.

## Validación

Regresión: `internal/risk/candidate_members_test.go`. Comprueba rechazo de eventos históricos,
admisión de evidencia tardía válida, actualización de nuevas fuentes/tácticas, inmutabilidad
de las listas anteriores y deduplicación de relecturas. Ejecución del paquete completo con
detector de carreras en Docker; registrar resultado real antes de considerar validada la entrega.

Para evaluar otra herramienta, primero medir CPU, memoria, demora de correlación, volumen,
calidad de agrupación y coste por investigación en este flujo. Una comparación Rust/Go solo
se acepta con el mismo corpus, presupuesto y semántica de detección; no hay benchmark de
Rust en esta entrega ni ahorro de tokens cuantificado.
