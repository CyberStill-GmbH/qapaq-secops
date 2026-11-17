# Benchmark opt-in de la inbox push Wazuh

Este benchmark mide dos componentes del punto 1 con datos sintéticos y PostgreSQL real:

1. Latencia p50/p95/p99 desde la invocación autenticada del controlador `POST /api/ingest/wazuh`
   hasta que `PrismaWazuhPushInboxStore.enqueue()` confirma el commit.
2. Capacidad y latencia de `createWazuhPushInboxPass()` con búsqueda y promoción sintéticas,
   incluyendo claim, transición de estado y finalización en PostgreSQL.

No levanta HTTP/Fastify, AWS, Wazuh ni Indexer. Tampoco persiste alertas SOC reales. Por ello,
`endToEndIndexerSocSlo` siempre es `NOT_MEASURED`: un resultado PASS solo informa del controlador,
PostgreSQL y consumidor sintético en la máquina y configuración donde se ejecutó. No demuestra el
SLO extremo a extremo `t2 - t0` ni debe publicarse como tal.

## Perfil de carga

| Perfil | Fase sostenida | Burst | Uso |
| --- | --- | --- | --- |
| `smoke` | 10 eventos/s durante 5 s | 50 eventos/s durante 5 s | Comprobar configuración, conexión y salida del benchmark |
| `acceptance` | 10 eventos/s durante 10 min | 50 eventos/s durante 60 s | Medir el perfil documentado del punto 1; tarda aproximadamente 11 min |

El perfil `acceptance` queda fuera de los tests predeterminados. El umbral local de commit es
p95 < 1.000 ms. El consumidor debe completar todos los receipts, dejar la cola sin pendientes y
mantener p95 sintético recepción-a-procesado < 10.000 ms. El script emite `PASS_LOCAL_COMPONENT_BENCHMARK`
solo si cumple estos controles; no es una garantía de capacidad en producción.

## Preparación y ejecución

Usa una base PostgreSQL desechable, exclusiva para el benchmark, cuyo nombre incluya `bench` o
`benchmark`; por ejemplo, `qapaq_wazuh_benchmark`. Créala mediante el procedimiento local habitual.
No apuntes a una base compartida ni a producción. La base debe estar vacía y contener las
migraciones actuales de `platform/database`.

En PowerShell, desde la raíz del repositorio:

```powershell
$env:DATABASE_URL = 'postgresql://usuario:clave@localhost:5432/qapaq_wazuh_benchmark'
$env:QAPAQ_WAZUH_BENCHMARK_ALLOW_DATABASE_MUTATION = '1'
pnpm.cmd --filter @qapaq/database exec prisma migrate deploy --schema prisma/schema.prisma
pnpm.cmd --filter @qapaq/api exec tsx --conditions=development scripts/measure-wazuh-push-load.ts smoke
```

Una vez que `smoke` termina correctamente, ejecuta el perfil de aceptación:

```powershell
pnpm.cmd --filter @qapaq/api exec tsx --conditions=development scripts/measure-wazuh-push-load.ts acceptance
```

El programa exige la variable explícita de mutación, que el nombre de la base tenga el marcador
de benchmark y que la inbox esté vacía antes de comenzar. Escribe receipts sintéticos en esa base;
no crea ni elimina bases de datos. Conserva el JSON de salida junto al commit, configuración de
PostgreSQL, versión de Node y recursos de la máquina para poder comparar ejecuciones.

## Interpretación

- `authenticatedControllerToDurableCommitMs` incluye validación de hint, HMAC y llamada al adapter;
  empieza en la llamada al método de controlador y termina tras su respuesta. No incluye red,
  Fastify, balanceador, TLS ni autenticación del Manager fuera del HMAC de este endpoint.
- `syntheticConsumerPath.receiptToProcessedP95Ms` usa `received_at → processed_at` persistidos por
  PostgreSQL. El lookup devuelve un `ProviderRecord` de prueba y `promote` no persiste una alerta.
- Un error, receipt perdido, cola pendiente, métrica nula o umbral incumplido produce `FAIL` y
  salida distinta de cero. Revisa primero la conectividad y recursos de la base; no reutilices una
  inbox con datos, porque el script la rechaza.
- Ejecuta varias veces en una máquina representativa y registra CPU, memoria, versión/PostgreSQL,
  pool/conexiones, latencias y carga concurrente externa. Este benchmark no sustituye el canario
  autorizado de Indexer ni la medición `t0 → t2` en un entorno integrado.

## Resultado de referencia local

El 12 de noviembre de 2026 se ejecutó `acceptance` en PostgreSQL 18.6 dentro de un contenedor
temporal local y Node.js 24.21.0. El host era Windows; no se registraron modelo de CPU, memoria ni
carga externa, por lo que estos números solo sirven como verificación funcional reproducible, no
como línea base de capacidad:

| Medición | Resultado | Control |
| --- | ---: | ---: |
| Receipts autenticados y confirmados | 9.000/9.000 | 6.000 sostenidos + 3.000 burst |
| p95 autenticación/controlador → commit, total | 11,86 ms | < 1.000 ms: PASS |
| p95 sostenido / burst | 13,38 ms / 9,42 ms | Medición descriptiva |
| p95 receipt → procesado sintético | 49 ms | < 10.000 ms: PASS |
| Procesados / pendientes / en proceso | 9.000 / 0 / 0 | Cola drenada: PASS |
| Estado extremo a extremo Indexer/SOC | No medido | `NOT_MEASURED` |

La corrida smoke previa procesó 300/300 receipts con p95 commit de 9,92 ms y p95 sintético de
44 ms. La aceptación cubrió 659,91 s de generación (10/s durante 600 s y 50/s durante 60 s).
Ambos resultados validan el código del controlador y del consumer contra PostgreSQL en este host;
no cubren Fastify, red, Indexer, persistencia de alertas ni notificaciones.
