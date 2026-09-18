# Analítica Python dormante

Estado: decisión **ACCEPTED — DORMANT CAPABILITY** por
[U-007/ADR-007](../adr/007-python-analytics.md). Runtime MVP: **NOT ENABLED**.
Activación: **BLOCKED UNTIL USE CASE AND BENCHMARK PASS**.

## División de responsabilidades

| Necesidad | Tecnología principal |
| --- | --- |
| Decoders, reglas, FIM, SCA y vulnerabilidades propias de Wazuh | Wazuh |
| Queries y agregaciones temporales | OpenSearch |
| Reglas determinísticas multifuente | TypeScript |
| Ventanas, thresholds y listas | TypeScript/OpenSearch |
| Alertas, incidentes, orquestación y SOAR | TypeScript |
| Estadística avanzada y procesamiento vectorizado | Python, después del gate |
| Anomalías y grafos | Python, con caso aprobado |
| Entrenamiento o inferencia ML | Python, después del MVP |

Llamar APIs, transformar JSON, renombrar campos, aplicar regex o thresholds,
consultar OpenSearch, contar eventos, enriquecer con listas, crear alertas,
gestionar incidentes, ejecutar playbooks y producir reportes simples no justifican
Python. “Es más cómodo” tampoco es una justificación.

Puede evaluarse Python para baselines conductuales, anomalías multivariables,
clustering, reducción de dimensionalidad, series temporales, correlación
probabilística, grafos, feature engineering vectorizado y backtesting.

## Primer caso candidato

`Authentication Behavior Anomaly Scoring` buscará comportamientos inusuales en
Microsoft Entra ID frente a una baseline histórica. Puede considerar hora/día,
frecuencia de fallos, éxito posterior, dispositivo, red, categoría geográfica,
aplicación, privilegio, activos distintos y distancia al comportamiento previo.

Entrada: `NORMALIZED_AUTHENTICATION_EVENT`. Salida: `ANALYTICS_CANDIDATE`.
El score se combina en TypeScript con contexto determinístico, criticidad del
activo, privilegio y supresión. No genera por sí solo una alerta crítica y nunca
ejecuta SOAR.

## Gate de valor

Cada propuesta registra owner, pregunta de negocio, dataset, output, baseline,
razón por la que Wazuh/TypeScript/OpenSearch no bastan, dataset histórico,
metodología, presupuesto, latencia, privacidad, fallos y rollback. Compara el
método determinístico actual con la alternativa Python.

Debe demostrar hallazgos adicionales relevantes, menor trabajo manual o mejor
priorización, explicaciones útiles, falsos positivos acotados, reproducibilidad,
estabilidad ante faltantes y ausencia de bloqueo de ingesta.

Métricas mínimas:

```text
precision_at_k
false_positives_per_day
alerts_accepted_by_analysts
additional_true_findings
duplicate_findings
processing_duration_seconds p50/p95/p99
peak_memory_bytes
cpu_seconds
input_records
output_candidates
failure_rate
```

Sin ground truth se usa revisión humana de una muestra estratificada; no se informa
“precisión” como hecho.

## Primera validación y presupuesto

La primera evaluación es `OFFLINE / BATCH / BOUNDED` sobre fixtures sintéticos,
datasets sanitizados, replay histórico aprobado o una ventana acotada. No es inline,
bloqueante, síncrona para usuarios ni respuesta autónoma; no recibe tráfico
completo de producción durante el experimento.

| Recurso | Límite inicial |
| --- | ---: |
| Concurrencia | 1 job |
| CPU | 2 vCPU |
| Memoria | 2 GiB |
| Timeout | 10 minutos |
| Input | 250 000 eventos o 500 MiB |
| Output | 10 000 candidatos o 10 MiB |
| Frecuencia | 1 ejecución por hora |
| Retries | 2 |

Se aplica el primer límite alcanzado. Es presupuesto de seguridad experimental,
no capacidad productiva. Un exceso termina el job; no aumenta recursos de forma
automática y exige análisis y nuevo benchmark.

## Frontera y estructura

Mientras esté dormante solo puede existir:

```text
research/analytics/              # documentación, fixtures y benchmarks no desplegados
```

Después de aprobar activación:

```text
apps/analytics/
  pyproject.toml
  uv.lock
  src/qapaq_analytics/
    application/
    algorithms/
    contracts/
    cli.py
  tests/
    unit/
    contract/
    benchmark/
```

Los contratos se ubican en `packages/contracts/analytics/v1/`: job request, evento
de autenticación normalizado, candidate y job result. Control plane usa JSON
versionado; batch usa inicialmente NDJSON comprimido. Parquet, Protobuf, gRPC,
Kafka u otro transporte requieren revisar la decisión.

## Ownership y contratos

Python no accede directamente a PostgreSQL, Redis, Wazuh Indexer, índices internos
de OpenSearch, secretos o endpoints administrativos. El módulo TypeScript dueño
del dataset prepara una entrada mínima, sanitizada y versionada.

El request contiene descriptor de job, referencia opaca al artifact, checksum,
schema, algoritmo allowlisted, ventana, límites, correlation ID y `traceparent`.
Nunca incluye SQL, código, shell, rutas arbitrarias, credenciales, URLs aportadas
por usuarios o módulos ejecutables dinámicos.

El resultado devuelve referencia y checksum, schemas, versiones, conteos, estado y
métricas. Cada candidate contiene algoritmo/versión, sujeto, ventana, score,
`reasonCodes`, características contribuyentes, eventos fuente y versión de
modelo/baseline. Un score sin explicación o evidencia de soporte se rechaza.

TypeScript valida schema, versión, job ID, checksum, límites, conteos, scores
finitos/rangos, reason codes, referencias, timestamps y duplicados. Un resultado
inválido va a cuarentena y nunca inserta una alerta directamente.

## Reproducibilidad y seguridad

Cada ejecución conserva commit SHA, versiones de Python/dependencias/algoritmo y
schema, hashes de input/configuración/modelo, seed, tiempo y recursos. Con
aleatoriedad se fija y registra la seed; igual input, versión y configuración debe
reproducir el resultado dentro de una tolerancia documentada.

El proceso se ejecuta sin privilegios, con filesystem read-only, temporal acotado,
sin shell, secretos, acceso directo a producción o egress por defecto, y con CPU,
memoria y timeout. Dependencias quedan bloqueadas y escaneadas. Ningún job ejecuta
`pip install`, `uv add`, descargas de modelo, `curl` o `wget`.

## Fallos, observabilidad y auditoría

Estados: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED_RETRYABLE`,
`FAILED_TERMINAL`, `TIMED_OUT`, `REJECTED`, `CANCELLED`. Tras dos retries pasa a
dead-letter. Un fallo no bloquea ingesta, Wazuh o TypeScript, no pierde el dataset
fuente y no crea alertas con resultados incompletos.

Métricas: `analytics_jobs_total`, `analytics_jobs_failed_total`,
`analytics_job_duration_seconds`, `analytics_input_records_total`,
`analytics_output_candidates_total`, `analytics_rejected_records_total`,
`analytics_contract_validation_failed_total`, `analytics_resource_limit_total` y
`analytics_timeout_total`. Logs sanitizados incluyen job/algoritmo/versiones,
conteos, duración, `errorCode` y `traceId`, nunca raw completo.

Auditar registro, habilitación, deshabilitación y cambio de versión del algoritmo;
solicitud, aceptación/rechazo de resultado y cambio de presupuesto. Durante piloto,
un analista clasifica utilidad y compara con la baseline; no se crean incidentes ni
SOAR automáticamente.

## Pruebas de aceptación

1. El input cumple el schema versionado.
2. Python no accede directamente a bases de datos.
3. Se verifica el checksum del input.
4. Se rechaza un schema desconocido.
5. Se rechaza un algoritmo no autorizado.
6. Se rechaza un resultado fuera de rango.
7. Un timeout termina el proceso.
8. Exceder memoria termina el job sin afectar ingesta.
9. Reiniciar el proceso no duplica candidates.
10. El mismo input produce resultados reproducibles.
11. El output contiene reason codes.
12. Cada candidate referencia eventos fuente.
13. El fallo de Python no bloquea reglas TypeScript.
14. El benchmark permanece dentro del presupuesto.
15. El caso supera o complementa la baseline determinística.
16. El SOC confirma que los resultados aportan valor.
17. El proceso no tiene secretos ni egress innecesario.
18. La versión puede deshabilitarse sin desplegar todo el SOC.

## Estado del MVP y activación

En el MVP, runtime Python, worker productivo, ML y behavioral analytics están
deshabilitados. Se permiten fixtures, investigación offline, scripts de benchmark
y definiciones de contrato; no se presentan como funcionalidad operativa.

Para activar se exige dataset real autorizado, baseline determinística, aprobación
SOC, benchmark de valor, contract tests, presupuesto, aislamiento, rollback,
transporte, actualización C4 y aprobación de despliegue del worker.
