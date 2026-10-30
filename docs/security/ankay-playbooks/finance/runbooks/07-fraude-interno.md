# RB-FIN-07 · Fraude interno por acceso a datos sin relación con la función

| Campo | Valor |
|---|---|
| Playbook | `finance.insider-fraud` v1.0.0 (`design-only`) |
| Prioridad / SLA | P2 · reconocer 30 min · triage 4 h · decisión de contención 8 h · evaluación regulatoria 24 h |
| **Dueño** | Oficial de seguridad de la información, con auditoría interna |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101441, 101443, 101444, 101445 · contexto 101440, 101442, 101416 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.insider-fraud.json` |
| Normativa | `SBS-504-INC`, `SBS-504-ACC`, `LPDP-SEG`, `LPDP-BRECHA` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Investigar con reserva a colaboradores que consultan o exportan datos de clientes sin
relación con su cartera, agencia o función (por ejemplo, vender bases de datos, preparar
fraudes de crédito o espiar a clientes PEP o a otros colaboradores). Es una investigación
sobre una persona: rigen la presunción de inocencia, la confidencialidad y el debido
proceso laboral. El SOC aporta evidencia; la decisión disciplinaria es de RR. HH. y legal.

El adaptador del core que calcula `qapaq_role_match` contra la cartera asignada es
`TO_BE_PROVIDED`. Sin él solo operan 101440/101441 (SharePoint).

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| 50 accesos a sitios sensibles en una hora | 101441 | M365 + lista `qapaq-sensitive-sites` |
| 20 consultas fuera de cartera o agencia en una hora | 101443 | Core normalizado |
| Consulta sin justificación de cliente PEP, colaborador o reservado | 101444 | Core normalizado |
| Exportación de reporte de clientes que el rol no justifica | 101445 | Core normalizado |

## Triage

### Paso 1: Restringir el caso y reconocer (15 min)

- [ ] Marcar el caso como confidencial en QAPAQ (acceso solo para el equipo asignado).
- [ ] No contactar al colaborador ni a su jefe directo sin acuerdo del oficial de
  seguridad.

VERIFICAR: el caso muestra acceso restringido y la lista de personas con acceso.

### Paso 2: Medir el patrón (45 min)

```text
rule.id:(101440 or 101441 or 101442 or 101443 or 101444 or 101445 or 101416) and (data.office365.UserId:"usuario@dominio" or data.qapaq_user_id:"usuario@dominio")
```

- [ ] Cantidad de clientes consultados, segmentos (PEP, colaboradores, reservados),
  horario y agencia; clientes solo por referencia opaca.
- [ ] Exportaciones y descargas en la misma ventana.

VERIFICAR: el caso tiene el patrón resumido sin nombres ni documentos de clientes.

### Paso 3: Contrastar con la función (60 min)

- [ ] IAM/RR. HH.: rol, cartera, agencia, cambios recientes, licencias o cese en curso.
- [ ] Riesgos o auditoría: reclamos de clientes, movimientos atípicos o créditos
  vinculados a los clientes consultados.

VERIFICAR: el caso deja una conclusión preliminar: justificado (por ejemplo, reasignación
de cartera no reflejada en IAM), no justificado o indeterminado.

## Contención

Decisión humana: **¿se abre investigación formal y se restringe el acceso del
colaborador?** Deciden el oficial de seguridad y auditoría interna, consultando a RR. HH.,
legal y al oficial de cumplimiento.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Suspender temporalmente el rol en el core o el acceso a sitios sensibles | Oficial de seguridad + jefe del área (no el jefe directo solo) | IAM (manual) | Temporal, registrado como medida preventiva |

### Paso 4: Ejecutar lo aprobado (30 min)

- [ ] IAM suspende el rol o el permiso indicado y lo confirma en el caso.
- [ ] Preservar las evidencias antes de cualquier comunicación con el colaborador.

VERIFICAR: nuevas consultas del usuario devuelven acceso denegado en el core (confirmado
por el dueño del sistema) y no hay 101440 nuevos.

### Reversión

IAM restituye el rol con la misma aprobación si la investigación concluye que el acceso era
justificado; se documenta el cierre para no afectar la trayectoria del colaborador.

## Erradicación

- [ ] Ajustar permisos al mínimo necesario según la función (art. 12.2.b de la 504-2021).
- [ ] Revisar si otros usuarios tienen el mismo exceso de permisos.

## Recuperación

- [ ] Si hubo divulgación de datos de clientes, abrir RB-FIN-08 (evaluación ANPD).
- [ ] Si hubo fraude, legal evalúa denuncia y riesgos cuantifica la pérdida.

## Lecciones aprendidas

En 10 días hábiles (la investigación es más larga): ¿la cartera asignada estaba al día en
IAM?, ¿el core exige justificación para consultar segmentos reservados?, ¿los umbrales de
101441/101443 generan falsos positivos en cierres de mes?

## RACI

| Actividad | Analista N2 | Jefe SOC | Oficial de seguridad | Auditoría interna | RR. HH. | Legal | Cumplimiento |
|---|---|---|---|---|---|---|---|
| Triage confidencial | R | A | I | I | – | – | – |
| Contraste con función | R | C | A | C | C | – | – |
| Decisión de investigación y restricción | C | C | R | A | C | C | C |
| Suspensión de acceso | – | I | A | I | C | – | – |
| Medidas disciplinarias | – | – | C | C | R | A | I |
| Evaluación regulatoria | – | C | R | C | – | A | C |

## Comunicación

- **Interna:** aviso P2 por outbox solo con referencia del caso, sin el nombre del
  colaborador. Lista cerrada de personas informadas.
- **Colaborador:** lo convoca RR. HH. con legal, cuando la evidencia está preservada.
- **Clientes y regulador:** según RB-FIN-08 si hubo divulgación o fraude.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Patrón aislado, probablemente justificado | Analista N2 |
| L2 | Patrón no justificado o segmentos reservados | Oficial de seguridad + auditoría interna |
| L3 | Exportación masiva, divulgación o fraude confirmado | Gerencia + legal + cumplimiento (RB-FIN-08) |

## Evidencias

Consultas y exportaciones con clientes por referencia opaca, cartera asignada,
justificaciones registradas, accesos a sitios sensibles, decisiones con firmantes. Cadena
de custodia estricta: puede usarse en un proceso laboral o penal.

## Métricas

MTTD, MTTA, MTTT y tasa de falsos positivos por regla. Dashboard: FILL IN.

## Ejercicio

Revisión anual con auditoría interna sobre un caso sintético (casos 101441–101445).
