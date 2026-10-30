# RB-FIN-05 · Ransomware en agencia o sucursal

| Campo | Valor |
|---|---|
| Playbook | `finance.branch-ransomware` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · decisión de contención 2 h · evaluación regulatoria 4 h |
| **Dueño** | Jefe del SOC QAPAQ, con el gerente de TI |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101430, 101431, 101432, 101433 · contexto 101201, 101202, 101203, 101209, 101302, 101208 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.branch-ransomware.json` |
| Normativa | `SBS-504-INC`, `SBS-504-REP`, `SBS-504-CONT`, `LPDP-BRECHA` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Cortar la propagación de ransomware desde una agencia hacia la sede, el core y los
backups, y mantener la atención a clientes. La velocidad importa más que en otros
runbooks: la decisión de aislar se toma con evidencia parcial. El aislamiento sigue
requiriendo aprobación, pero el aprobador de guardia debe responder en minutos.

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| Borrado de shadow copies, catálogo de backup o recuperación de arranque | 101430 | Sysmon Event 1 |
| La misma inhibición en 3 equipos en 30 min | 101431 | Sysmon |
| Sophos detecta ransomware (CryptoGuard u otra firma) | 101432 | Sophos normalizado |
| 5 amenazas altas permitidas en el mismo sitio en 15 min | 101433 | Cato normalizado |

## Triage

### Paso 1: Reconocer y medir el alcance (10 min)

- [ ] Reconocer en QAPAQ; llamar al aprobador de guardia (jefe del SOC) de inmediato.
- [ ] Listar equipos y sitio afectados desde el resumen del workflow.

```text
rule.id:(101430 or 101431 or 101432 or 101433 or 101201 or 101202 or 101203 or 101208 or 101209 or 101302) and @timestamp >= "now-2h"
```

VERIFICAR: el caso tiene la lista de equipos (nombre y agencia), primera hora de cifrado o
inhibición y si hay servidores entre ellos.

### Paso 2: Estado de Sophos y de la red (15 min)

- [ ] En Sophos Central (solo lectura): detecciones, estado de remediación y si el equipo
  sigue en línea.
- [ ] En Cato: tráfico SMB/RDP desde el sitio hacia la sede, el core y los backups.

VERIFICAR: el caso indica si la propagación salió de la agencia y si los backups siguen
íntegros (consulta al responsable de backups).

## Contención

Decisión humana: **¿se aíslan los equipos o la agencia y se activa continuidad del
negocio?** Deciden el jefe del SOC y el gerente de TI, consultando al jefe de agencias y a
continuidad del negocio.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Aislar endpoints | Jefe del SOC | `containment.endpoint-isolate` | Solo equipos con evidencia |
| Aislar el sitio en Cato o bloquear indicadores | Jefe del SOC + jefe de redes | `containment.cato-block-indicator` | Con expiración y revisión cada 4 h |
| Revocar sesiones de cuentas usadas | Jefe del SOC | `containment.m365-revoke-sessions` | Cuentas vistas en la propagación |

### Paso 3: Ejecutar lo aprobado (15 min)

Mientras los ejecutores automáticos sigan deshabilitados, el administrador de Sophos
aísla desde Sophos Central (Dispositivos → equipo → Aislar) y el administrador de Cato
aplica la regla de aislamiento del sitio preparada para emergencias. Si el equipo no
responde a Sophos, el personal de la agencia lo desconecta físicamente de la red (no
apagar: se pierde memoria útil para el análisis forense).

VERIFICAR: Sophos muestra los equipos “aislados”; Cato muestra la regla activa; no hay
nuevas 101430/101432 en 15 minutos fuera de los equipos aislados.

### Reversión

Quitar el aislamiento en Sophos y Cato solo después de la erradicación y con aprobación.
La regla de sitio de Cato tiene expiración; renovarla exige nueva aprobación.

## Erradicación

- [ ] Imagen forense de al menos un equipo afectado antes de reinstalar (art. 12.6.g de
  la 504-2021: preservación de evidencia).
- [ ] Reinstalar desde imagen corporativa; no “limpiar” equipos cifrados.
- [ ] Rotar credenciales usadas en la propagación; revisar GPO y tareas programadas.
- [ ] Bloquear los IoC confirmados con expiración (no por veredicto de una sola fuente).

## Recuperación

- [ ] Restaurar datos desde backups verificados como íntegros.
- [ ] Activar el plan de continuidad de la agencia (atención en agencia cercana o modo
  contingencia) y registrar inicio y fin de la interrupción por servicio y canal.
- [ ] Si la interrupción alcanza el umbral del Reglamento de Continuidad (4 h de caída de
  canal o servicio priorizado), abrir RB-FIN-08 a tiempo para el reporte de 5 h.

## Lecciones aprendidas

En 5 días hábiles: vector de entrada, por qué Sophos no bloqueó antes, segmentación de la
agencia hacia la sede, tiempo real de restauración frente al objetivo, y si el umbral de
101431 (3 equipos) es adecuado.

## RACI

| Actividad | Analista N2 | Jefe SOC | Gerente de TI | Jefe de agencias | Continuidad | Backups |
|---|---|---|---|---|---|---|
| Alcance y triage | R | A | I | I | – | C |
| Decisión de aislamiento | C | R | A | C | C | – |
| Ejecución de aislamiento | – | I | A | R (agencia) | – | – |
| Continuidad del negocio | – | I | C | R | A | – |
| Restauración | – | I | A | – | C | R |

## Comunicación

- **Interna:** aviso P1 por outbox; llamada telefónica al aprobador de guardia.
- **Agencia:** el jefe de agencias instruye al personal por teléfono (no por el correo del
  equipo afectado).
- **Clientes:** solo mensajes aprobados por comunicaciones si se afecta la atención.
- **Regulador:** según RB-FIN-08 (ciberseguridad y continuidad).

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Una alerta aislada sin cifrado confirmado | Analista N2 |
| L2 | Cifrado confirmado o más de un equipo | Jefe del SOC + gerente de TI |
| L3 | Propagación fuera de la agencia, servidores o backups afectados | Comité de crisis + apoyo externo de respuesta a incidentes (RB-FIN-08) |

## Evidencias

Detecciones y hashes, estado de remediación, eventos de red del sitio, lista de equipos,
hora del primer cifrado, imagen forense con hash y cadena de custodia, estado de backups,
inicio y fin de la interrupción.

## Métricas

MTTD, MTTA, MTTT, MTTC, MTTR. Dashboard: FILL IN.

## Ejercicio

Simulación anual con un equipo de laboratorio y el comando sintético de los casos
101430/101431 (sin cifrado real), más prueba de restauración de backup de una agencia.
