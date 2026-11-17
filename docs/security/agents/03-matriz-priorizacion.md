# Matriz de priorización: niveles Wazuh y P1–P4 del núcleo

**Estado:** propuesta para aprobación del dueño. Las reglas y el ajuste del núcleo están
probados con datos sintéticos (`wazuh-logtest` en CI y specs de `modules/detection`); los SLA y
destinatarios son una propuesta hasta que el dueño los apruebe (cuestionario, bloque N).

## 1. Dos capas, una sola decisión

| Capa | Qué decide | Dónde vive | Con qué contexto |
|---|---|---|---|
| **Wazuh** (nivel 0–15) | Si el evento es una alerta y cuán grave es la *señal sobre ese activo*. | `infra/wazuh/*/rules`, `infra/wazuh/priority/rules/qapaq_priority_rules.xml` | Listas CDB `qapaq-critical-assets`, `qapaq-privileged-identities`, `qapaq-sensitive-workstations`, `qapaq-internet-facing` |
| **Núcleo QAPAQ** (P1–P4) | Qué merece atención primero y a quién se avisa. | `modules/detection` (ruleset `qapaq.detection.prioritization` 1.2.0) | Variables `QAPAQ_DETECTION_*`, correlación por entidad, cadena de compromiso, ventanas de mantenimiento y las etiquetas `qapaq_ctx_*` que deja Wazuh |

Regla de oro: **el contexto cuenta una sola vez**. Si Wazuh consultó su lista y etiquetó la
alerta con `qapaq_ctx_critical_asset`, el núcleo suma `CRITICAL_ASSET` una vez, aunque el mismo
host esté también en `QAPAQ_DETECTION_CRITICAL_ASSETS`. Si Wazuh **rebajó** una regla por ruido
conocido (`qapaq_priority_lowered`), el núcleo no la vuelve a subir por contexto
(`PROVIDER_TUNED_DOWN`); solo una cuenta break-glass o una cadena de ataque la pueden elevar.

¿Por qué el contexto cambia el nivel en Wazuh *y* suma en el núcleo? Porque son dos cosas:
el nivel Wazuh expresa el **impacto de la técnica sobre ese activo** (borrar el Security log de
un controlador de dominio no es lo mismo que en una estación), y el núcleo ordena la cola con
contexto que Wazuh no tiene (correlación, cadenas, mantenimiento). La matriz de abajo está
calculada con ambas capas y la verifica `modules/detection/test/prioritization.spec.ts`.

## 2. Escala y cálculo

Nivel Wazuh → severidad normalizada (`modules/telemetry/src/wazuh-normalization.ts`):

| Nivel Wazuh | Severidad | Puntaje base | Sale a Teams/Ankay por integrador (nivel ≥ 12) |
|---|---|---|---|
| 12–15 | crítica | 80 | Sí |
| 8–11 | alta | 60 | No |
| 4–7 | media | 40 | No |
| 1–3 | baja | 20 | No |
| 0 | informativa | 5 | No (no genera alerta) |

Ajustes del núcleo (reason codes) y umbrales: P1 ≥ 85 · P2 ≥ 65 · P3 ≥ 35 (umbral de promoción a
alerta SOC) · P4 < 35 (consultable, sin alerta).

| Reason code | Delta | Origen |
|---|---|---|
| `BREAK_GLASS_IDENTITY` | +100 (siempre P1, no suprimible) | `QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES` |
| `PRIVILEGED_IDENTITY` | +15 | lista del núcleo **o** `qapaq_ctx_privileged_identity` |
| `CRITICAL_ASSET` | +15 | lista del núcleo **o** `qapaq_ctx_critical_asset` |
| `SENSITIVE_WORKSTATION` | +10 | `qapaq_ctx_sensitive_workstation` (solo Wazuh) |
| `EXTERNAL_EXPOSURE` | +10 | lista del núcleo **o** `qapaq_ctx_internet_facing` |
| `OFF_HOURS` | +5 | `qapaq_ctx_off_hours` (regla con `<time>`/`<weekday>`) |
| `SUCCESSFUL_INTRUSION` | +20 | categoría ofensiva con resultado exitoso |
| `ATTACK_CHAIN` | +25 | acceso → impacto sobre el mismo usuario en 24 h |
| `CORRELATED_ENTITY` / `REPEATED_ACTIVITY` | +10 / +10 | correlación por entidad |
| `KNOWN_BENIGN` / `MAINTENANCE_WINDOW` | −base (suprime) | acuerdo con referencia / ventana de cambio |
| `PROVIDER_TUNED_DOWN` | 0 (bloquea el contexto) | `qapaq_priority_lowered` |

## 3. Matriz resultante

| Nivel Wazuh | Sin contexto | + activo crítico o identidad privilegiada | + estación sensible | + expuesto a Internet |
|---|---|---|---|---|
| 12–15 (crítica) | **P2** (80) | **P1** (95) | **P1** (90) | **P1** (90) |
| 8–11 (alta) | **P3** (60) | **P2** (75) | **P2** (70) | **P2** (70) |
| 4–7 (media) | **P3** (40) | **P3** (55) | **P3** (50) | **P3** (50) |
| 1–3 (baja) | **P4** (20) | P3 (35) salvo `PROVIDER_TUNED_DOWN` → **P4** | P4 (30) | P4 (30) |

Con cadena de ataque (+25) o break-glass, cualquier fila sube a P1. Una ventana de mantenimiento
o una regla benigna acordada suprime, salvo break-glass y cadena.

## 4. Qué es crítico y qué es alto para QAPAQ

### Crítico (P1): respuesta inmediata 24×7

| Dimensión | Criterio | Reglas que lo materializan |
|---|---|---|
| **Activo** | Controladores de dominio, PAW, core financiero/créditos, bases de datos con datos de clientes, sistemas de pago. | 101600, 101601, 101611, 101615, 101620, 101622–101625, 101627 |
| **Identidad** | Tier 0, administradores de nube, aprobadores de pagos, cuentas break-glass. | 101602, 101605, 101629, 101640–101644, 100530 |
| **Táctica MITRE** | Evasión de defensas en activo crítico (T1070.001, T1562), robo de credenciales de dominio (T1003.006, T1558), toma de cuenta privilegiada (T1078 tras T1110), inhibición de recuperación (T1490), webshell expuesto (T1505.003), reenvío de correo de aprobadores (T1114.003, BEC). | ver columna anterior y 101603, 101613 |
| **Origen** | Interno contra activo crítico (movimiento lateral) o Internet con éxito posterior. | 101625, 101640 |
| **Horario** | Agrava, no define: fuera de horario suma `OFF_HOURS` (+5). | 101645, 101646 |

### Alto (P2): triage en horario extendido

- Señal crítica sin contexto (nivel 12–15 sobre un activo no listado): Outlook→intérprete en
  servidor no listado, webshell interno (101612), shadow copies en estación (101614).
- Señal alta (8–11) sobre activo/identidad listada: tier 0 con RDP fuera de activos críticos
  (101606), inicio de sesión de admin fuera de horario (101645/101646 → 80, P2).
- Señal alta en estación sensible o servidor expuesto.

### Rebajado con justificación (P3/P4)

| Regla | De → a | Justificación | Revisión |
|---|---|---|---|
| 101604 | 101306 (6) → 3 | Replicación entre DC registrados (`dc` en la lista): constante y legítima. Un DCSync desde cuenta de usuario sigue en 101603 (13). | Trimestral |
| 101608 | 101307 (6) → 3 | Fallo Kerberos 0x25 = desfase de reloj, no adivinación. | Trimestral |
| 101609 | 101307 (6) → 3 | Fallo de preautenticación de cuentas de equipo (`$`): reinstalaciones; el spray apunta a usuarios. | Trimestral |
| 101626 | 101213 (12) → 6 | Barrido SSH desde Internet contra expuesto **no crítico**: ruido de fondo; el éxito posterior se detecta aparte. Si el host es crítico, 101625 lo sube a 13. | Mensual (volumen) |

## 5. SLA y avisos por rol (propuesta)

| Prioridad | Acuse | Contención / decisión | Canal | Destinatarios |
|---|---|---|---|---|
| **P1** | 15 min, 24×7 | 1 h | Tarjeta Teams del integrador Wazuh (nivel ≥ 12) + aviso QAPAQ con mención y push; respaldo correo → consola | `qapaq.soc.analyst` y `qapaq.soc.lead` (ruta `soc.alert.created` P1, `modules/soar/src/notification-routing.ts`). Escalado: `qapaq.soc.lead` + `qapaq.platform.admin`. Dueño del activo y Oficial de Seguridad: TO_BE_PROVIDED (N2) |
| **P2** | 1 h en horario extendido (TO_BE_PROVIDED, N1) | 4 h | Tarjeta Teams si el nivel es ≥ 12; bandeja QAPAQ | Analista de turno (`qapaq.soc.analyst`) |
| **P3** | 1 día hábil | 3 días hábiles | Bandeja QAPAQ | Cola del SOC |
| **P4** | — | Revisión semanal de tendencias | Consultable en Wazuh | — |

Notas:

- Hoy el núcleo solo notifica P1 (tabla `NOTIFICATION_ROUTES`). Avisar P2 por Teams requiere
  una ruta nueva en `modules/soar`; se deja como decisión del dueño (cuestionario N3) para no
  aumentar el ruido antes de medir el volumen del piloto.
- Brechas con datos personales (Ley 29733) o incidentes significativos (SBS 504-2021) siguen
  los playbooks de `docs/security/ankay-playbooks/finance*`; los plazos regulatorios no se fijan
  aquí.
- Toda acción con efecto (aislar, revocar, bloquear) pasa por Ankay con aprobación SoD. Ninguna
  regla de esta matriz ejecuta Active Response.

## 6. Verificación

| Qué | Cómo | Dónde |
|---|---|---|
| Qué regla gana en Wazuh (sube/mantiene/baja) | 63 casos `wazuh-logtest` sobre Manager 4.14.8 | `infra/wazuh/priority/tests`, workflow `wazuh-priority-agents.yml` |
| Contrato de reglas (rango, padres, etiquetas ↔ listas, dirección del ajuste) | `test_priority_rules.py` | mismo workflow |
| Nivel Wazuh → P1–P4 | `it.each` de la matriz y casos de etiquetas | `modules/detection/test/prioritization.spec.ts` |

Comando local con Docker:

```bash
bash infra/wazuh/priority/tests/run-logtest.sh qapaq-wazuh-priority-test
```

(El contenedor se prepara con los pasos del workflow: reglas de AD, endpoint, launch-detections,
office365 y prioridad montadas, listas renderizadas con `apply-priority.sh` en modo `render`.)
