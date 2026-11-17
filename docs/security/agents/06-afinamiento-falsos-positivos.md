# Afinamiento continuo de falsos positivos

**Estado:** proceso vigente para las reglas QAPAQ. Complementa el método general de
[`detection-engineering-qapaq.md`](../detection-engineering-qapaq.md) con las palancas concretas
de este paquete.

## 1. Principios

1. **Reducir en la fuente antes que en la regla.** Si un canal trae eventos que ninguna regla
   consume, se ajusta el XPath del perfil o la regla Sysmon de inclusión. Menos costo y menos
   ruido a la vez.
2. **Rebajar, no borrar.** Una rebaja va a nivel 3–6 con `qapaq_priority_lowered` y una
   justificación en el XML. El evento sigue disponible para investigación.
3. **Excepciones estrechas y con vencimiento.** Actor + activo + regla + ventana + ticket. Nunca
   rangos de IP, dominios completos ni cuentas administrativas como solución general.
4. **Lo que atacaría un adversario no se suprime.** Break-glass, cadenas de ataque y cambios de
   auditoría no admiten supresión (el núcleo lo impone).
5. **Toda rebaja tiene prueba.** Un caso `baja:` en `tests/logtest-cases.jsonl` y su contraparte
   `mantiene:` o `sube:` que demuestra que la detección sigue viva.

## 2. Palancas disponibles

| Palanca | Dónde | Cuándo usarla | Rastro |
|---|---|---|---|
| XPath del canal | `infra/wazuh/agents/shared/<grupo>/agent.conf` | Evento sin consumidor | PR + medición EPS |
| Regla Sysmon `include`/`exclude` | `deploy/windows/sysmon/qapaq-sysmon.xml` | Proceso legítimo identificado por ruta firmada | PR |
| Regla hija de rebaja (nivel 3–6) | `infra/wazuh/priority/rules/qapaq_priority_rules.xml` (rango 101600–101699) | Patrón benigno estable y explicable | Justificación en XML + caso `baja:` |
| Lista CDB | `qapaq-*` en el manager | El activo o la identidad cambió de clase | Cambio de inventario aprobado |
| `QAPAQ_DETECTION_KNOWN_BENIGN_RULES` | Variables del núcleo | Acuerdo temporal sobre una regla completa | `id:referencia` obligatorio |
| Ventana de mantenimiento | Núcleo | Cambio planificado | Referencia del cambio |

## 3. Ciclo semanal (30 min, líder SOC + analista)

1. **Top 10 por volumen** de la semana en `wazuh-alerts-*` agrupado por `rule.id` y
   `agent.labels.qapaq_profile`.
2. **Tasa de cierre como falso positivo** por regla en QAPAQ (alertas cerradas como
   `false_positive` / total). Candidata a afinar: > 30 % con más de 20 alertas.
3. Para cada candidata, decidir con la tabla de §2 y abrir PR con:
   - la muestra redactada que justifica el cambio (sin datos personales),
   - el caso `baja:` y el caso que prueba que la detección sigue,
   - el vencimiento o la fecha de revisión.
4. **Revisar vencimientos**: excepciones vencidas se retiran o se renuevan con nueva evidencia.
5. Registrar en el PR el antes/después (alertas/semana, EPS).

## 4. Rebajas vigentes

| Regla | Motivo | Revisión | Señal que demuestra que la detección sigue |
|---|---|---|---|
| 101604 | Replicación entre DC registrados | Trimestral | 101603 (DCSync por cuenta de usuario) |
| 101608 | Kerberos 0x25 (reloj) | Trimestral | 101307 (fallos de usuario) |
| 101609 | Preautenticación de cuentas de equipo | Trimestral | 101307 |
| 101626 | Barrido SSH contra expuesto no crítico | Mensual | 101625 (crítico), éxito posterior |

## 5. Métricas del programa

| Métrica | Objetivo inicial |
|---|---|
| Alertas P1 por semana que resultan falso positivo | < 10 % |
| Alertas nivel ≥ 12 por día (tarjetas Teams) | Medir en piloto; fijar techo con el dueño |
| Reglas con > 30 % de falsos positivos | 0 sin plan |
| Excepciones vencidas | 0 |
| MTTA P1 | ≤ 15 min |

## 6. Nueva detección o elevación

Una elevación nueva sigue el mismo camino que una rebaja: ID en 101600–101699, grupos
`qapaq_<táctica>` + `qapaq_ctx_*` solo si la regla consultó la lista correspondiente (lo exige
`test_priority_rules.py`), caso `sube:` y caso `mantiene:` para el mismo evento sin contexto.
Las señales que dependen del orden (`if_matched_sid`) deben correlacionar contra la regla que
realmente gana: una hija que eleva su padre impide que otra regla vea al padre (ver 101640).
