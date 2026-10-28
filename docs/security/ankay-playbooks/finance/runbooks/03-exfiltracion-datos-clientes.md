# RB-FIN-03 · Descarga o exfiltración masiva de datos de clientes

| Campo | Valor |
|---|---|
| Playbook | `finance.customer-data-exfiltration` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · decisión de contención 2 h · evaluación regulatoria 4 h |
| **Dueño** | Jefe del SOC QAPAQ, con el oficial de datos personales |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101416, 101417, 101418, 101419, 101421, 101422 · contexto 101415, 101420, 100515, 100529, 101203 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.customer-data-exfiltration.json` |
| Normativa | `SBS-504-INC`, `LPDP-SEG`, `LPDP-BRECHA` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Detectar y frenar la salida de datos de clientes (créditos, cobranzas, PLAFT, bases de
contacto) desde SharePoint/OneDrive, por enlaces anónimos o por subida a aplicaciones en la
nube no autorizadas, y decidir a tiempo si hay brecha de datos personales. El triage usa
solo metadatos: conteos, rutas, etiquetas de sensibilidad; nunca abre los archivos.

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| 100 descargas en 10 min | 101416 | M365 UAL |
| 30 descargas en 10 min fuera de horario o en fin de semana | 101417, 101418 | M365 UAL (hora Lima) |
| 10 enlaces anónimos en una hora | 101419 | M365 UAL |
| 5 coincidencias DLP en una hora | 101421 | Purview DLP (requiere DLP.All) |
| Subida de volumen alto a app no autorizada | 101422 | Cato normalizado |

## Triage

### Paso 1: Reconocer y medir el volumen (15 min)

- [ ] Reconocer en QAPAQ y revisar el resumen del workflow (`signals`, `degradedSources`).
- [ ] Contar archivos, sitios y etiquetas de sensibilidad en la ventana.

```text
rule.id:(101415 or 101416 or 101417 or 101418 or 100515 or 101419 or 101420 or 101421) and data.office365.UserId:"usuario@dominio"
```

VERIFICAR: el caso registra cuántos archivos, de qué sitios y con qué etiqueta, sin copiar
nombres de clientes en el caso ni en Teams.

### Paso 2: Comparar con la función del usuario (20 min)

- [ ] Pedir a IAM/RR. HH. por el canal aprobado: rol, área, si tiene renuncia o cese en
  curso, vacaciones.
- [ ] Preguntar al jefe del área si la descarga responde a una tarea autorizada (por
  ejemplo, cierre de mes), sin alertar al usuario.

VERIFICAR: el caso tiene la línea base del rol y la respuesta del jefe, con hora.

### Paso 3: Seguir el destino (20 min)

- [ ] Enlaces anónimos creados y si siguen activos.
- [ ] Destinos de subida en Cato (aplicación, volumen) y dispositivos USB si hay telemetría
  de endpoint.

VERIFICAR: el caso deja una de tres conclusiones: actividad justificada, salida confirmada
hacia destino externo o salida no determinable (se trata como confirmada).

## Contención

Decisión humana: **¿hubo exposición de datos personales de clientes que active la
evaluación regulatoria?** Deciden el analista N2 y el oficial de datos personales,
consultando a legal, cumplimiento y al jefe del área.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Revocar sesiones | Jefe del SOC | `containment.m365-revoke-sessions` | Solo la identidad |
| Bloquear destino de subida | Jefe del SOC + jefe de redes | `containment.cato-block-indicator` | Destino exacto, expira en 7 días |
| Retirar permisos al sitio | Jefe del área del usuario | IAM (manual) | Temporal |

### Paso 4: Ejecutar lo aprobado (20 min)

Con aprobación registrada, un administrador de SharePoint distinto del aprobador elimina
los enlaces anónimos identificados (lista exportada como evidencia antes):

```powershell
$Site = 'https://tenant.sharepoint.com/sites/sitio'
Connect-PnPOnline -Url $Site -Interactive
Get-PnPFileSharingLink -Identity '/sites/sitio/Documentos/archivo.xlsx' | Export-Clixml .\links-before.xml
Remove-PnPFileSharingLink -Identity '/sites/sitio/Documentos/archivo.xlsx' -Force
```

VERIFICAR: `Get-PnPFileSharingLink` ya no muestra enlaces anónimos sobre los archivos; Cato
muestra el bloqueo activo con fecha de expiración.

### Reversión

Recrear enlaces legítimos con la copia `links-before.xml` solo si el dueño del dato lo
aprueba; el bloqueo Cato expira solo o se retira con aprobación; IAM restituye permisos al
cerrar el caso.

## Erradicación

- [ ] Revisar etiquetas y permisos heredados de los sitios afectados con su dueño.
- [ ] Desactivar enlaces anónimos en sitios con datos de clientes (cambio aprobado).
- [ ] Si la identidad estaba comprometida, seguir RB-FIN-02.

## Recuperación

- [ ] Pedir eliminación al destinatario externo cuando sea identificable y legal lo apruebe.
- [ ] Vigilar la identidad 30 días.
- [ ] Si el oficial de datos confirma brecha, abrir RB-FIN-08 de inmediato: el plazo de
  48 h ante la ANPD corre desde que se toma conocimiento.

## Lecciones aprendidas

En 5 días hábiles: ¿las etiquetas de sensibilidad cubrían los sitios?, ¿los umbrales de
101416/101417 se ajustan a la línea base?, ¿DLP.All está habilitado?, ¿cómo llegó RR. HH. a
avisar de ceses a tiempo?

## RACI

| Actividad | Analista N1 | Analista N2 | Jefe SOC | Oficial de datos | Jefe del área | IAM/RR. HH. | Legal |
|---|---|---|---|---|---|---|---|
| Triage y volumen | R | A | I | I | – | – | – |
| Línea base del rol | – | R | A | – | C | C | – |
| Decisión de exposición | – | R | C | A | C | – | C |
| Contención | – | – | A | I | R (permisos) | R | – |
| Notificación regulatoria | – | C | C | R | I | – | A |

## Comunicación

- **Interna:** aviso P1 por outbox. Investigación confidencial: no avisar al usuario.
- **Ejecutiva:** si hay brecha confirmada, resumen a gerencia en 2 h.
- **Clientes y ANPD:** solo según RB-FIN-08, con textos aprobados por legal.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Umbral superado, sin datos de clientes confirmados | Analista N1 → N2 |
| L2 | Datos de clientes en el volumen o destino externo | Jefe del SOC + oficial de datos |
| L3 | Brecha confirmada o destino no determinable | Oficial de seguridad de la información + legal + gerencia (RB-FIN-08) |

## Evidencias

Conteos por sitio y etiqueta, enlaces creados, coincidencias DLP, destinos y volúmenes de
red, línea base del rol, decisión de exposición con hora y firmante.

## Métricas

MTTD, MTTA, MTTT, MTTC y tasa de falsos positivos por regla. Dashboard: FILL IN.

## Ejercicio

Prueba trimestral con un usuario de laboratorio y documentos sintéticos (casos
101416/101417/101419 de `infra/wazuh/finance/tests`).
