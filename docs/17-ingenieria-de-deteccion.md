# 17 · Ingeniería de detección y operación del Blue Team

> Leyenda: **[verificado]** hecho y comprobado contra el manager real; **[sin verificar]** existe en el repo
> pero no se probó de extremo a extremo; **[propuesto]** diseño sin implementación. Estado al 2026-11-04.

QAPAQ SOC detecta con Wazuh (reglas, capa 1 y 1b de [07](07-deteccion-ml-y-soar.md)), prioriza con QAPAQ Core
(P1–P4 con razones, `modules/detection`) y responde con Ankay bajo aprobación humana
([13](13-ankay-qapaq.md), [14](14-ankay-conexion-qapaq.md)). Este documento define el **programa** que
hace que eso funcione como una disciplina: cómo nace, se prueba, se despliega, se mide y se retira una
detección, quién opera las alertas y con qué tiempos, y qué falta para cerrar las brechas.

## Mapa del programa

| Pieza | Dónde | Estado |
| --- | --- | --- |
| Ciclo de vida, flujo de ramas/PR y estándar de metadatos | [detection-engineering/01](detection-engineering/01-ciclo-de-vida.md) | Vigente |
| Contenido como código: `detections/<fuente>/<caso-de-uso>/` | [`detections/`](../detections/README.md) | 23 casos de uso, 71 reglas del SOC, 24 nuevas **[verificado]** |
| Cobertura MITRE ATT&CK generada desde el XML + brechas | [detection-engineering/02](detection-engineering/02-cobertura-mitre.md), [`detections/reports/mitre-coverage.md`](../detections/reports/mitre-coverage.md) | 49 → 60 técnicas, 12 → 13 tácticas **[verificado]** |
| Runbooks de triage e investigación | [detection-engineering/runbooks](detection-engineering/runbooks/README.md) | Vigente |
| Modelo operativo del Blue Team (turnos, SLA, escalamiento, métricas) | [detection-engineering/03](detection-engineering/03-modelo-operativo.md) | Propuesto; objetivos sin publicar hasta medir (N8) |
| Playbooks de Ankay (triage, contención con aprobación) | [detection-engineering/04](detection-engineering/04-playbooks-ankay.md), [`ankay/playbooks/`](../ankay/playbooks/) | Exportables, **no importados**; contención apagada |
| Backlog y hoja de ruta de ingeniería de seguridad | [detection-engineering/05](detection-engineering/05-backlog.md) | Priorizado |
| Ajuste y reducción de falsos positivos (allowlists CDB, contexto, corroboración, anomalías, registro) | [detection-engineering/07](detection-engineering/07-ajuste-falsos-positivos.md), [`detections/lists/`](../detections/lists/) | 16 reglas de ajuste, 6 listas versionadas; 328 FP de 521 cerrados con auditoría **[verificado]** |
| Vistas de análisis (OSD) | [detection-engineering/06](detection-engineering/06-vistas-de-analisis.md), `wazuh/dashboard/saved-objects/detection/` | 6 dashboards importados en AWS **[verificado]** |

## Qué quedó desplegado en AWS (dev.security.qapaq.pe, 2026-11-04)

- **Reglas:** 14 archivos instalados con `detections/tools/deploy-detections.sh` (respaldo
  `etc/qapaq-backup-20261104T201808Z-detections`, `wazuh-analysisd -t` OK, manager reiniciado, agente 001
  `Active`). 10 archivos nuevos `qapaq_soc_*.xml` (24 reglas, 101700–101760) y las descripciones normalizadas de
  O365, AD, lanzamiento y endpoint (mismos IDs). Lista CDB `qapaq-internet-facing-projects` creada con un
  centinela `.invalid` y declarada en `<ruleset>` (también en el `ossec.conf` montado de wazuh-docker).
- **Pruebas:** 317 casos de `wazuh-logtest` en un manager desechable 4.14.8 (185 de suites existentes + 132
  nuevos), todos correctos; 7 casos de suites existentes quedan **refinados** a una regla hija más específica
  (declarado en `detections/catalog.yaml`). En el manager productivo, los 8 casos de uso nuevos con logtest pasan
  salvo Snyk expuesto, que depende de poblar la lista (comportamiento esperado). **Prueba en vivo FIM** en el
  agente 001: `authorized_keys2`, `cron.d` y unidad systemd disparan 101755, 101757 y 101756 en el mismo segundo.
- **Vistas:** 73 objetos guardados (6 dashboards `QAPAQ · …`, 10 cazas) importados en el tenant global con
  `infra/aws-poweruser/scripts/bootstrap-detection-content.sh` (proxy auth desde el contenedor del dashboard).

### Metricas de calidad del correlador (2026-11-11)

API, Prometheus y reportes exponen conteos de TP/FP, revisados/no revisados, ventana de evaluación y
truncamiento del feed. Los conteos generales de veredictos usan `UpdatedAt` (o `OccurredAt` si no
hay fecha de actualización) dentro de la ventana y excluyen fechas futuras. Las métricas específicas
del correlador forman una cohorte de alertas por `OccurredAt` y clasifican el veredicto actualmente
registrado en esos eventos; no significan que el veredicto se adjudicara dentro de esa misma
ventana. Si el feed llega truncado, los conteos y propuestas humanas permanecen visibles, pero el
runner desactiva supresiones automáticas para no aplicar ni renovar acciones basadas en evidencia
parcial, que podría omitir TP o reglas P1. Estos conteos describen estado de revisión, no precisión,
recall ni reducción medida de falsos positivos: sigue faltando un corpus adjudicado. Se añadió un
evaluador offline reproducible descrito a continuación; no contiene corpus ni genera resultados de
calidad por sí mismo. `go test ./...` y `gofmt` pasaron en la imagen local Go 1.23.12. Ver
[25](25-programa-confiabilidad-e-investigacion.md).

#### Evaluación reproducible sobre corpus adjudicado

`services/qapaq-correlator/cmd/evaluate-corpus` compara dos versiones congeladas del correlador sobre
el mismo conjunto de casos con una ventana temporal de evaluación (`[evaluationStart, evaluationEnd)`).
El formato `qapaq-correlator-eval/v1` requiere un `corpusId`, hash SHA-256 de snapshot, versión de
protocolo de adjudicación, familia, número de eventos fuente elegibles, `occurredAt`, etiqueta
`positive|negative|ambiguous`, predicciones baseline/candidate y prioridad baseline. Los IDs deben
ser pseudónimos estables; no se admiten cuerpos, logs crudos, entidades ni direcciones de correo.

El informe separa ejemplos anteriores a la ventana (calibración) y ambiguos, calcula matriz de
confusión, precision, recall, tasa de FP y FP por 1.000 eventos elegibles por familia, y deja `null`
cuando un denominador no existe. Compara delta baseline/candidate solo con los positivos y negativos
adjudicados del mismo holdout. La suficiencia por familia requiere al menos 200 etiquetas conocidas,
20 positivas, 20 negativas y un denominador fuente mayor que cero. Si no se alcanza, los valores son
descriptivos y no deben usarse como evidencia de calidad.

Una regresión de positivo conocido que el baseline detectaba, o la supresión de una alerta P1 del
baseline, queda en el JSON con el ID pseudónimo y termina el CLI con código 3; el informe se conserva
para que la regresión sea visible. Los casos ambiguos no cuentan como TP, FP, TN o FN, pero un P1
ambiguo todavía activa la protección P1. La herramienta exige filas de ventanas elegibles aun cuando
ninguna versión emitió una alerta; un export limitado a alertas emitidas no permite estimar recall.
Si la evidencia no alcanza el mínimo por familia, el CLI conserva el informe y termina con código 4;
el informe no supera la puerta de calidad. Las filas de cada familia mantienen sus conteos; el resumen
`overallCandidate` cuenta una sola vez cada ID pseudónimo estable compartido entre familias. Si el mismo
ID aparece con fecha, etiqueta o predicciones distintas, la validación rechaza el corpus. Los conjuntos
de eventos elegibles de familias pueden solaparse, por lo que FP/1.000 se informa por familia y queda
indefinido en el total para evitar un denominador global duplicado.

La comparación estadística usa los mismos casos negativos para ambos builds: cuenta FP que el candidato
quitó y FP que agregó, y calcula la prueba McNemar exacta bilateral. Por familia se presenta el p-valor
crudo y se aplica Holm-Bonferroni entre las familias con evidencia suficiente; el total deduplica los
IDs compartidos y muestra un p-valor sin ajuste para una única comparación global. Los campos de
significancia quedan `null` si el corpus no alcanza el mínimo de evidencia; con evidencia suficiente
se marca el umbral `alpha = 0.05`. La prueba evalúa desacuerdos sobre negativos adjudicados; no corrige
sesgo de selección, errores de etiquetado, deriva temporal ni valida que las predicciones pertenezcan
a los builds declarados. Sin un corpus real, completo y adjudicado, estas estadísticas no demuestran
una reducción operativa de FP.

Ejecutar con Go 1.23 o posterior:

```sh
go run ./cmd/evaluate-corpus -input /ruta-segura/corpus.json -output /ruta-segura/reporte.json
```

El archivo debe venir de un snapshot autorizado y redactado, cubrir el universo elegible mediante
un protocolo de adjudicación revisado, conservar un holdout temporal sin usarlo para ajustar el
matcher y cumplir la retención aprobada. Las pruebas del evaluador usan filas sintéticas y solo
verifican el cálculo y las guardas; no son datos SOC ni evidencian una reducción real de falsos
positivos. El matcher, el umbral y la supresión automática permanecen sin cambios por esta herramienta.
`go test ./...` pasó en `services/qapaq-correlator`; no se aporta aquí un corpus adjudicado ni resultados
de comparación, por lo que no se afirma reducción real de falsos positivos.

## Principios

1. **Una detección es código:** XML + metadatos + fixtures + resultado esperado + runbook, revisados por PR.
   Nada se edita a mano en el manager ni en el dashboard.
2. **Sin datos no hay detección:** una regla sin fuente que la alimente se marca `pending-provider-evidence` o
   `experimental`; la cobertura MITRE cuenta reglas, el dashboard de cobertura muestra lo que **dispara**.
3. **Wazuh detecta, QAPAQ prioriza, una persona decide:** las reglas no ejecutan nada (Active Response apagado,
   docs/16); toda acción con efectos pasa por Ankay con aprobación del Líder SOC (N5, A13).
4. **Los IDs no se reutilizan** y cada fuente tiene un rango (`detections/catalog.yaml`).
5. **Toda descripción empieza por `QAPAQ <Fuente>:`** (M365, Entra, AWS, Linux, Windows, AD, Bitdefender, Snyk,
   Cloudflare, Sophos, Cato). El lint lo exige en las reglas del SOC.

## Ajuste y reducción de falsos positivos

Resumen (detalle, técnicas y registro con fixtures en [detection-engineering/07](detection-engineering/07-ajuste-falsos-positivos.md)):

- **Degradar, no silenciar:** nivel 0 solo para ruido redundante (sesiones PAM de cuentas admin, que ya
  auditan 5402/5715) o FP técnicos probados (rootcheck sobre overlay de Docker). Los principales de confianza
  (rol SSO del SOC, `qapaqservice@qapaq.pe`) bajan de nivel pero siguen indexados; lo destructivo sigue alertando.
- **Allowlists en `detections/lists/`** (CDB versionadas, cambio por PR). El motor de correlación y riesgo propone
  altas desde los veredictos `false_positive`; un humano aprueba.
- **Severidad con corroboración:** correo (≥ 8) y Ankay (≥ 12) solo con activo crítico, exposición, exploit
  maduro, horario o segunda señal.
- **Anomalías:** detectores RCF `qapaq-logins-per-user` y `qapaq-waf-blocks-per-zone` con monitores de Alerting
  (`detections/tools/apply-anomaly-monitors.sh`).
- **Histórico:** las 328 alertas QAPAQ de la regla 521 se cerraron como `false_positive` con el script de servicio
  `detections/tools/close-false-positives.mjs` (984 eventos de auditoría con cadena hash, correlación `close-fp-521-*`).

## Correlador de riesgo (código local, 2026-11-11)

`services/qapaq-correlator` mantiene una correlación determinista por entidad con decaimiento temporal,
límite a repetición de una misma regla, diversidad de fuentes, secuencia MITRE, agrupación por ventana,
deduplicación y propuestas de supresión sujetas a revisión humana. Al evaluar una secuencia ordenada,
`Pattern.Match` ahora selecciona la cadena más reciente que conserva el orden de sus etapas; para una
secuencia no ordenada usa la evidencia más reciente disponible por etapa. También filtra y ordena una vez
las observaciones de cada etapa dentro de la ventana antes de probar combinaciones. Esto mejora la
coherencia de la evidencia explicativa y reduce trabajo repetido; por sí solo no cambia las prioridades
ni demuestra una reducción medida de falsos positivos. La regresión correspondiente está en
`services/qapaq-correlator/internal/risk/risk_test.go`; el código no se ha validado contra tráfico real
desplegado en esta revisión.
