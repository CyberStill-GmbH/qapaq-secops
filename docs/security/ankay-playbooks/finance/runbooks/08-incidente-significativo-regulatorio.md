# RB-FIN-08 · Incidente significativo con notificación regulatoria y evidencia

| Campo | Valor |
|---|---|
| Playbook | `finance.significant-incident-regulatory` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · evaluación regulatoria 4 h (meta interna) |
| **Dueño** | Oficial de seguridad de la información |
| Última verificación | 2026-10-28 (revisión documental; plazos según la [matriz](../matriz-cumplimiento-sbs-anpd.md), pendientes de validación legal) |
| Disparadores | Incidente QAPAQ marcado como candidato a significativo por RB-FIN-01 a 07 o por el jefe del SOC |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.significant-incident-regulatory.json` |
| Normativa | `SBS-504-INC`, `SBS-504-REP`, `SBS-504-LOG`, `LPDP-BRECHA`, `LPDP-REG` |

## Objetivo y alcance

Decidir con método y a tiempo si un incidente debe reportarse a la SBS, a la ANPD o al
CNSD, y preparar un expediente con evidencia verificable. **Ankay no notifica a ningún
regulador**: el workflow arma el expediente y los relojes; la notificación la firman y
envían personas autorizadas. Este runbook no afirma que QAPAQ cumpla la normativa: ordena
la evidencia para que legal y cumplimiento decidan.

## Relojes regulatorios

| Reloj | Parte de | Plazo | Estado de la fuente |
|---|---|---|---|
| SBS, incidente de ciberseguridad significativo (Res. SBS 504-2021, art. 15.1) | La hora en que QAPAQ advierte el incidente | “En cuanto” lo advierta; **sin plazo en horas** en el artículo | Verificado; formato y canal (art. 15.3) no encontrados |
| SBS, interrupción de servicios priorizados o caída de canal por 4 h o más (Res. SBS 877-2020, art. 15.2, modificado por Res. SBS 00814-2025) | El inicio de la interrupción | 5 h desde el inicio si ocurre entre 07:00 y 16:00; si no, al inicio de la siguiente jornada hábil | Verificado |
| ANPD, incidente de datos personales (D.S. 016-2024-JUS, art. 34.1) | La toma de conocimiento | 48 h; un retraso debe justificarse | Verificado |
| Titulares afectados (art. 34.3) | La toma de conocimiento | 48 h, salvo que no haya afectación y el incidente esté superado | Verificado |
| CNSD, incidente digital crítico (D.S. 126-2025-PCM, art. 32.1) | La toma de conocimiento | 48 h | Verificado; vigencia por confirmar |

La evaluación interna de 4 h (P1) existe para llegar a tiempo a estos plazos; no es un
plazo legal. Todo plazo marcado como pendiente en la matriz se trata como **pendiente de
validación legal** y, mientras tanto, como inmediato.

## Triage

### Paso 1: Convocar y fijar horas clave (15 min)

- [ ] Abrir el caso RB-FIN-08 vinculado al incidente de origen.
- [ ] Registrar en UTC y hora Lima: primera evidencia, hora en que QAPAQ advirtió el
  incidente, inicio de la interrupción (si la hay) y toma de conocimiento de datos
  personales afectados.
- [ ] Convocar al comité de crisis: oficial de seguridad, legal, oficial de datos
  personales, cumplimiento, gerencia general, comunicaciones y TI.

VERIFICAR: el caso muestra las cuatro horas clave con su fuente y los relojes calculados
por el workflow (`qapaq.regulatory_clock`).

### Paso 2: Evaluar criterios (45 min)

- [ ] SBS art. 15.1: ¿hay impacto adverso significativo, verificado o presumible, por
  pérdida o hurto de información, fraude interno o externo, daño reputacional o
  interrupción de operaciones? Aplicar el criterio interno de significancia (pendiente de
  definir, ver la matriz).
- [ ] Continuidad: ¿caída de canal o servicio priorizado por 4 h o más, o del 25 % de los
  puntos de atención presencial?
- [ ] ANPD art. 34.1: ¿gran volumen de datos, muchos afectados, datos sensibles o
  perjuicio evidente a derechos?
- [ ] CNSD: ¿es un incidente de seguridad digital de nivel crítico?

VERIFICAR: el acta del comité registra cada criterio con “sí/no/indeterminado”, la
evidencia que lo sustenta y los firmantes.

### Paso 3: Inventariar evidencias (30 min)

```bash
# Desde el almacén de evidencias del caso: hash y lista firmada por quien la genera.
sha256sum evidencias/* > evidencias/SHA256SUMS
gpg --armor --detach-sign evidencias/SHA256SUMS
```

VERIFICAR: cada evidencia tiene hash SHA-256, origen, hora de obtención, responsable y
ubicación; la cadena de custodia no tiene huecos.

## Contención

Este runbook no ejecuta contención: la del incidente de origen sigue en su runbook. La
única decisión aquí es **¿el incidente es reportable a la SBS, a la ANPD o al CNSD y quién
firma la notificación?** Deciden el comité de crisis y el oficial de seguridad, con legal,
el oficial de datos personales y gerencia.

### Paso 4: Preparar y enviar las notificaciones (60 min)

- [ ] **SBS:** reporte con descripción, criterios del art. 15.1, impacto, medidas y
  siguientes pasos; formato y canal según indique cumplimiento (art. 15.3 pendiente).
- [ ] **ANPD:** naturaleza del incidente, tipos de datos y número aproximado de afectados,
  contacto del oficial de datos personales, consecuencias y medidas (art. 34.2).
- [ ] **Titulares:** texto en lenguaje claro aprobado por legal y comunicaciones.
- [ ] **CNSD:** descripción, clasificación, impacto e indicadores de compromiso sin datos
  personales (D.S. 126-2025-PCM, art. 31).

VERIFICAR: el caso guarda cada notificación enviada, la hora de envío, el canal, el
remitente y la constancia de recepción.

### Reversión

Una notificación enviada no se retira: si cambia la evaluación, se envía una
actualización o rectificación con la nueva evidencia.

## Erradicación y recuperación

Las conduce el runbook de origen. Este runbook hace seguimiento de los compromisos
asumidos ante el regulador y envía actualizaciones hasta el cierre.

## Lecciones aprendidas

Informe ejecutivo e informe técnico del análisis forense a disposición de la SBS (art.
15.2), en 10 días hábiles o el plazo que indique legal: línea de tiempo, causa raíz,
impacto, medidas, acciones con dueño y fecha, y métricas (MTTD, MTTC, cumplimiento de
relojes).

## RACI

| Actividad | Jefe SOC | Oficial de seguridad | Oficial de datos | Legal | Cumplimiento | Gerencia | Comunicaciones |
|---|---|---|---|---|---|---|---|
| Horas clave y relojes | R | A | C | I | C | I | – |
| Evaluación de criterios | C | R | R (datos) | C | C | A | I |
| Inventario de evidencias | R | A | C | C | I | – | – |
| Notificación SBS | C | R | – | C | R | A | I |
| Notificación ANPD y titulares | C | C | R | A | C | I | R (titulares) |
| Notificación CNSD | R | A | – | C | I | I | – |
| Informes del art. 15.2 | R | A | C | C | C | I | – |

## Comunicación

- **Comité:** puente de crisis con actualizaciones cada 2 h mientras el incidente esté
  activo.
- **Directorio:** según el procedimiento de gobierno de QAPAQ.
- **Externa:** solo voceros autorizados; ningún mensaje desde Ankay ni desde Teams.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Candidato a significativo en evaluación | Jefe del SOC + oficial de seguridad |
| L2 | Algún criterio en “sí” o “indeterminado” | Comité de crisis |
| L3 | Riesgo de vencer un reloj, impacto masivo o atención mediática | Gerencia general + directorio |

## Evidencias

Línea de tiempo UTC con fuentes, inventario con SHA-256 y cadena de custodia, acta del
comité con firmantes, evaluación de impacto, notificaciones con constancias y los dos
informes del art. 15.2.

## Métricas

MTTA, MTTT, cumplimiento de relojes regulatorios y `SLA_BREACH_RATE`. Dashboard: FILL IN.

## Ejercicio

Simulacro anual de comité con un incidente sintético que active los cuatro relojes, para
medir el tiempo hasta cada notificación lista para firma.
