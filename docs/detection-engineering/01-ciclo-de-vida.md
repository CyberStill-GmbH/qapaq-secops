# 01 · Ciclo de vida de una detección (detección como código)

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md).

## Etapas

| # | Etapa | Qué se produce | Quién | Puerta de salida |
| --- | --- | --- | --- | --- |
| 1 | **Idea** | Issue `deteccion:` con la amenaza, la fuente y por qué importa a QAPAQ (incidente, caza, intel, brecha de [02](02-cobertura-mitre.md)) | Cualquier analista | Líder SOC la acepta en el backlog |
| 2 | **Hipótesis** | Una frase verificable: «si un atacante hace X, la fuente Y registra Z» + técnica MITRE | Ingeniería de detección | Existe la fuente con datos (o se marca `pending-provider-evidence`) |
| 3 | **Regla** | `detections/<fuente>/<caso>/rule.xml` con ID del rango de la fuente, nivel según la escala QAPAQ y `<mitre>` | Ingeniería de detección | `qapaq_detections.py lint` sin errores |
| 4 | **Pruebas** | `fixtures.jsonl` (positivos, negativos y frontera) + `expected.txt`; si no aplica logtest (FIM), prueba en vivo documentada en `metadata.yaml → tests.live` | Ingeniería de detección | `test-in-container.sh` en verde (CI) |
| 5 | **Revisión** | PR con metadatos completos, runbook enlazado y nota de falsos positivos | Par revisor + Líder SOC | Aprobación de una persona distinta del autor (N5) |
| 6 | **Despliegue** | `deploy-detections.sh` en el host (respaldo, `analysisd -t`, reinicio, agente activo, rollback automático) | Platform/SOC con acceso al host | Smoke de logtest en el manager y regla visible en «QAPAQ · Calidad de detección» |
| 7 | **Afinamiento** | Ajustes de umbral, ventana o listas; nunca se baja el nivel para callar ruido sin registrar el motivo | Ingeniería de detección | Revisión semanal de calidad ([03](03-modelo-operativo.md)) |
| 8 | **Retiro** | `status: retired` y `retired_reason` en `metadata.yaml`; el XML se borra pero **el ID queda reservado** | Líder SOC | Sin dependencias (`if_sid`, playbooks, dashboards) |

Estados (`status` en `metadata.yaml`): `experimental` (solo repo) → `testing` (desplegada, observando) →
`production` (validada con datos reales) · `pending-provider-evidence` (cargada, la fuente aún no entrega o el
nombre de la operación no está confirmado con un registro real) · `deprecated` · `retired`.

## Ramas y PR

1. Rama `det/<fuente>-<caso>` desde `main` (p. ej. `det/aws-cloudtrail-tampering`).
2. Un PR por caso de uso. Título `feat(detection): <fuente> <caso>`; el cuerpo enlaza el issue y pega la salida
   de `lint` y de `test-in-container.sh`.
3. La CI [`qapaq-detections.yml`](../../.github/workflows/qapaq-detections.yml) corre: lint, contrato de los
   playbooks, cobertura y vistas al día (aviso si `coverage` o el builder cambian `detections/reports/` o el
   NDJSON) y todas las suites de `wazuh-logtest` en un manager Wazuh 4.14.8 desechable.
4. Merge solo con CI verde y aprobación del Líder SOC. El despliegue es un paso aparte (A17): nunca desde la CI
   de PR y nunca con `deploy-host.sh`/`ship.sh`.
5. Después del despliegue se actualiza `status` y se regenera la cobertura y las vistas
   (`build_detection_dashboards.py`) en el mismo PR o en uno de seguimiento.

## Estándar de metadatos

`detections/<fuente>/<caso>/metadata.yaml` (los existentes referencian su archivo canónico, que no se mueve):

| Campo | Obligatorio | Contenido |
| --- | --- | --- |
| `id` | sí | `QAPAQ-DET-<FUENTE>-NNN`, estable |
| `title`, `hypothesis` | sí | En español; la hipótesis es la frase verificable de la etapa 2 |
| `source`, `use_case` | sí | Clave de `catalog.yaml → sources` y nombre de carpeta |
| `status`, `version` | sí | Estado del ciclo y SemVer (mayor = cambia la semántica o el ID de una regla hija) |
| `owner`, `reviewers` | sí | Equipo dueño y rol revisor |
| `data_sources` | sí | Fuente, módulo/collector y permiso que necesita |
| `rules` | sí | `file`, `ids`, `installed_as` (nuevas) o `related` (reglas base) |
| `mitre` | sí | Lista `technique` + `tactic`; el lint exige que coincida con `<mitre>` del XML |
| `severity` | sí | `levels`, `priority_hint` (P1–P4 esperado) y `rationale` (por qué ese nivel en QAPAQ) |
| `false_positives`, `tuning` | sí / no | Escenarios benignos conocidos y cómo afinarlos sin perder la señal |
| `tests` | sí | `runner` (`logtest`, `validator` o `live`), `fixtures`, `expected` y suite |
| `runbook`, `respond_playbook` | sí / no | Ruta del runbook y del playbook de Ankay |
| `depends_on`, `lists`, `notes` | no | Reglas/grupos de otros archivos, listas CDB y bloqueos |

**Escala de severidad QAPAQ** (`modules/telemetry`): 0 informativo · 1–3 baja · 4–7 media · 8–11 alta · 12–15
crítica. El correo QAPAQ sale desde 8 (alta) y el webhook de Ankay desde 12. Criterio para elegir nivel:

| Nivel | Cuándo |
| --- | --- |
| 3 | Marca de contexto que alimenta correlaciones (login exitoso/fallido) |
| 5–7 | Higiene o señal débil que solo vale agregada |
| 8–10 | Acción sensible que exige revisión el mismo turno (cambio de control, privilegio) |
| 12–13 | Compromiso probable de una identidad, host o servicio |
| 14–15 | Cadena de ataque confirmada por dos señales, evasión de la auditoría o identidad tier 0 |

**Rangos de IDs** (fuente única: [`detections/catalog.yaml`](../../detections/catalog.yaml)): M365/Entra
100500–100549 y 101700–101709 · Windows 101100–101199 · paquete de lanzamiento 101200–101215 · servicio de
proveedores 101216–101299 · AD 101300–101399 · Bitdefender 101400–101449 y 101720–101729 · Snyk 101450–101499 y
101730–101739 · Cloudflare 101500–101549 y 101740–101749 · reservado Sophos/Cato 101550–101599 · AWS 101600–101699
(paquete del receptor) y 101710–101719 (correlación) · Linux 101750–101769 · reservado Windows/AD 101770–101799.

## Herramientas

```bash
python3 detections/tools/qapaq_detections.py lint                 # metadatos, rangos, prefijos, MITRE
python3 detections/tools/qapaq_detections.py coverage --official <ruleset/rules>   # matriz y brechas
bash    detections/tools/test-in-container.sh                   # todas las suites en Wazuh 4.14.8 desechable
sudo bash detections/tools/deploy-detections.sh [--check]        # en el host: instala con respaldo y rollback
sudo bash infra/aws-poweruser/scripts/bootstrap-detection-content.sh   # vistas OSD (tenant global)
```

`wazuh/manager/policy/apply-manager-policy.sh` también instala `detections/*/*/rule.xml` como `qapaq_soc_*.xml`,
para que reaplicar la política del manager no deje fuera las reglas del programa.

**Orden de carga y precedencia.** Wazuh carga `etc/rules` en orden alfabético y, entre hijas del mismo padre,
evalúa primero la de **mayor nivel**. Por eso las reglas del programa se llaman `qapaq_soc_*` (cargan después de
todo QAPAQ) y una correlación es hija también de la regla que la precede en nivel (p. ej. 101700 cuelga de 100520 y
de 101704; 101750 de 5715 y de 40112). Las correlaciones sobre el paquete AWS se enlazan por **grupo**
(`qapaq_aws_*`), no por ID, para no romper la carga si ese paquete se renumera.
