# Evaluación Docker del correlador · 2026-11-13

## Conclusión

La reducción adicional de falsos positivos **no está demostrada**. Los controles sintéticos de
ruido y preservación de señales pasan tanto en el commit base como en el código actual. El cambio
actual mejora la integridad y continuidad de lectura; no cambia el motor de riesgo ni sus umbrales.
No se encontró un corpus adjudicado por analistas con predicciones comparables en el repositorio.
Esto significa «no medido», no «0 %» ni una autorización para suprimir alertas.

## Entorno y reproducción

Base: `ba212c97f6092c702875653938e69fc15aa2d290`, extraída con `git archive HEAD services/qapaq-correlator`.
Candidato: worktree sin commit; los hashes individuales están en `source-sha256.json`.
Imagen: `golang:1.23.12-bookworm`, ID
`sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db`.
Ambas ejecuciones usaron contenedores efímeros, `--network none`, entrada de solo lectura y:

```sh
go test -count=1 -race -json ./...
```

Se ejecuta desde la raíz del servicio Go. El baseline se extrae dentro de `/tmp` del contenedor;
el candidato se monta en `/work`. No se reutilizó caché de resultados. La comunicación de las
pruebas HTTP ocurre mediante `httptest` dentro del contenedor. No se modificaron los contenedores
Wazuh existentes ni se consultaron sus datos. Esta ejecución no acredita integración con Indexer real.

## Resultados observados

| Comprobación | Base | Candidato |
| --- | --- | --- |
| Pruebas/subpruebas aprobadas según eventos JSON | 62 | 83 |
| Paquetes con pruebas aprobadas | 6 | 7 |
| Fallos, incluido detector de carreras | 0 | 0 |
| Una regla repetida 50 veces no genera candidato | PASS | PASS |
| Replay de 67 observaciones; tres patrones esperados presentes | PASS | PASS |
| Patrón credential-to-privilege conserva P1 | PASS | PASS |
| Agrupación sintética de 22 alertas en 5 grupos | PASS | PASS |
| Nuevas regresiones de respuesta parcial, cursor y ventana | No presentes | PASS |

El replay conserva patrones edge-to-ssh, credential-to-privilege y endpoint-protection-and-malware.
Los 22 avisos agrupados en 5 representan 77,27 % menos unidades de revisión en ese fixture y un
factor 4,4. **No son 77,27 % menos falsos positivos**, y el resultado ya existía en la base.
El fixture activa explícitamente una política de feedback para probarla; no demuestra que esa
política esté habilitada o aprobada en un SOC real.

Las pruebas nuevas verifican que una respuesta parcial no entregue evidencia parcial, que los
eventos de igual timestamp mantengan el cursor, que un poll limitado continúe su ventana y que
un error no borre el progreso anterior. No se ejecutaron esas pruebas contra la base, cuya API
interna no contiene todos los campos nuevos; el mayor conteo no es una métrica de precisión.

## Evidencia y siguiente medición

`baseline-tests.jsonl` y `correlator-tests.jsonl` conservan la salida completa; `summary.json` incluye
conteos y hashes SHA-256. `source-sha256.json` identifica el código evaluado.

El comando `evaluate-corpus` consume etiquetas y predicciones precalculadas: no ejecuta el matcher.
Sus pruebas verifican cálculos y barreras de preservación; no demuestran efectividad operativa.
Para medirla hacen falta ventanas emitidas y no emitidas, etiquetas positive/negative/ambiguous
adjudicadas independientemente, snapshots y versiones identificadas, y predicciones de ambas
versiones sobre el mismo conjunto temporal reservado. El evaluador exige por familia al menos
200 ejemplos etiquetados, 20 positivos y 20 negativos; estos mínimos no garantizan representatividad.
Se reportarán TP/FP/TN/FN, precisión, recall, FP por 1.000 eventos elegibles, diferencias pareadas y
preservación de P1/TP. No se ajustarán reglas usando el conjunto reservado para evaluar.
