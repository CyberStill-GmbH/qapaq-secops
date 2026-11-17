# 07 · Ajuste y reducción de falsos positivos

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Objetivo: que **P1/P2 en QAPAQ
signifiquen "accionable hoy"** sin perder verdaderos positivos ni auditoría.

## Política

1. **Medir antes de ajustar.** Volumen por regla en `wazuh-alerts-*` (7 días) y candidatos a FP; el dashboard
   «QAPAQ · Calidad de detección» lo muestra de forma continua.
2. **Degradar, no silenciar.** Nivel 0 solo para ruido **redundante** (otra regla ya audita el mismo hecho) o
   falsos positivos técnicos probados (rootcheck en overlay). Lo demás baja de nivel y sigue indexado
   (nivel ≥ 3). Los principales de confianza nunca quedan suprimidos: lo destructivo sigue alertando.
3. **Allowlists como datos versionados.** Listas CDB en [`detections/lists/`](../../detections/lists/) (clave =
   entidad, valor = motivo). Cambian por PR con aprobación del Líder SOC. El motor de correlación y riesgo
   propone altas a partir de los veredictos `false_positive` de los analistas; nunca las aplica solo.
4. **Corroborar la severidad alta.** Una alerta llega a correo (≥ 8) o a Ankay (≥ 12) solo si hay
   contexto: activo crítico, exposición a Internet, exploit maduro, horario o una segunda señal (cadenas 1017xx).
5. **Cada ajuste trae prueba.** Un fixture que demuestra que el verdadero positivo sigue disparando y otro que
   demuestra que el falso positivo se suprime o degrada, una nota en `metadata.yaml` (`tuning`,
   `measurement`) y una fila en el registro de abajo.
6. **Revisión mensual de listas** (vencimiento en el valor para escáneres y excepciones temporales).

## Técnicas aplicadas (nativas de Wazuh)

| Técnica | Dónde |
| --- | --- |
| Allowlist CDB con hijas `if_sid` de nivel 0 o menor | 101714–101716, 101743, 101744, 101766, 101767 |
| `not_match_key` / `not_address_match_key` para elevar lo desconocido | 101761 (IP no administrativa), 101733/101734 (proyecto no expuesto) |
| Contexto de negocio: `<time>` y `<weekday>` (horario QAPAQ en UTC) | 101762, 101763 |
| Criticidad de activo por lista | 101741/101742 (zonas críticas de Cloudflare), 101730/101731 (proyectos expuestos) |
| Reglas compuestas (dos señales) | 101700–101703, 101710–101713, 101720–101723, 101750 |
| Umbral `frequency`/`timeframe` con `same_*`/`different_*` | 101513, 101740, 100503/100504 |
| Ventana de supresión `ignore` | 101740 (600 s), 100503/100504 |
| Calibración de severidad (hermanas por nivel) | 101732–101734, 101742 |
| Línea base / anomalías (OpenSearch Anomaly Detection, RCF) | `qapaq-logins-per-user`, `qapaq-waf-blocks-per-zone` (+ `qapaq-m365-login-failures`), con monitores de Alerting |
| Exclusión en el agente | rootcheck `ignore` de `/var/lib/docker` y `/var/lib/containerd` en `linux-servers` y `linux-pilot` |
| Cierre auditado de FP históricos | `detections/tools/close-false-positives.mjs` (principal de servicio, assign → triage `false_positive` → close) |

## Listas versionadas

| Lista | Uso | Contenido inicial |
| --- | --- | --- |
| `qapaq-admin-ips` | SSH desde fuera de la lista se eleva | Prefijo del operador `38.250.148.` |
| `qapaq-admin-accounts` | Sesiones PAM redundantes | `ubuntu`, `root` |
| `qapaq-service-accounts` | Automatización DNS de Cloudflare | `qapaqservice@qapaq.pe` |
| `qapaq-authorized-scanners` | Escáneres autorizados en el WAF | Entrada sintética RFC 5737 de prueba |
| `qapaq-critical-zones` | Corroboración de 101513 | `qapaq.pe` |
| `qapaq-aws-trusted-principals` | Cambios del SOC en el pipeline AWS | Rol SSO `AWSReservedSSO_SOC-PowerUser_…/soc@qapaq.pe` + entrada sintética |

De entorno (no van a git): `qapaq-break-glass`, `qapaq-internet-facing-projects` (centinela `.invalid` hasta poblarlas).

## Registro de ajustes

| Fecha | Regla(s) | Cambio | Motivo / medición (7 d) | TP conservado (fixture) | FP suprimido (fixture) |
| --- | --- | --- | --- | --- | --- |
| 2026-11-08 | 521 → 101765 | Overlay de Docker/containerd a nivel 0 + `ignore` de rootcheck en `linux-pilot` (ya estaba en `linux-servers`) | 328 alertas en una pasada, todas FP | 521 fuera de esas rutas sigue a 11 (live: no reproducible en logtest) | 0 alertas 521 nuevas tras la exclusión |
| 2026-11-08 | 5501/5502 → 101766/101767 | Sesiones PAM de cuentas admin a nivel 0 | 1119 + 1119; duplican 5402 (sudo) y 5715 (SSH), que se conservan | `linux/noise-tuning` casos 3–4 (cuenta `eve`) | casos 1–2 |
| 2026-11-08 | 5715 → 101761/101762/101763 | SSH desde IP no administrativa a 8; 11 fuera de horario o fin de semana | 367 éxitos, 365 desde el operador | caso 6 (198.51.100.77) | caso 5 (38.250.148.107 queda en 5715 nivel 3) |
| 2026-11-08 | 101616/101615/101640 → 101714/101715/101716 | Principal SSO del SOC: 3 / 9 / 5 | 101616 nivel 6 y 101640 nivel 8 por `soc@qapaq.pe` | `aws/trusted-principals` casos 2, 4, 7 | casos 1, 3, 5, 6 |
| 2026-11-08 | 101503 → 101744 | DNS por `qapaqservice@qapaq.pe` a 3 | 32 cambios DNS, la mayoría de la automatización | `cloudflare/noise-tuning` caso 2 | caso 1 |
| 2026-11-08 | 101510 → 101743 | Escáneres autorizados a 2 (no cuentan para 101513/101740) | Pentest/escaneos previstos | casos 28–47 | casos 3–27 (25 bloqueos sin 101513) |
| 2026-11-08 | 101513 → 101741/101742 | 11 en zona crítica, 7 en zona no crítica | Una IP ya bloqueada no es un incidente | caso 47 (qapaq.pe → 101741) | caso 67 (example.test → 101742) |
| 2026-11-08 | 101453/101455/101456 → 101732/101733/101734 | Baja sin exploit → 2; alta/crítica sin exposición ni exploit → 7/10 | 600 bajas, 224 altas (nivel 10 = correo) | `snyk/severity-calibration` casos 2, 4, 5, 7, 8 | casos 1, 3, 6 |
| 2026-11-09 | 521 (328 alertas QAPAQ) | Cerradas como `false_positive` con auditoría (3 eventos por alerta, cadena hash) | Correlación `close-fp-521-*`, actor `svc:qapaq-detection-engineering` | — | 328/328 cerradas |

Volúmenes antes/después: ver [§ Medición](#medición).

## Medición

Evaluación reproducible del correlador en Docker, 2026-11-13:
[resultados, evidencia y límites](evidence/2026-11-13/README.md). Base: 62 pruebas/subpruebas;
candidato: 83; ambas sin fallos con `-race`. Los controles sintéticos de ruido pasan en ambas.
No se demostró reducción adicional de FP; falta corpus real adjudicado y predicciones comparables.

Se completa después de cada despliegue con la consulta de volumen por regla (24 h comparables).
