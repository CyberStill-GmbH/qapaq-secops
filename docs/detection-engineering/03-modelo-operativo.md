# 03 · Modelo operativo del Blue Team QAPAQ

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). **[propuesto]** Los tiempos de esta
página son **objetivos internos** para dimensionar el equipo; no se publican como SLO hasta tener 30 días de
medición real (decisión N8).

## Roles

| Rol | Rol QAPAQ | Responsabilidad |
| --- | --- | --- |
| Analista de guardia (L1) | `qapaq.soc.analyst` | Acusa y clasifica alertas, sigue el runbook, abre o enlaza el incidente, escala |
| Analista de respuesta (L2) | `qapaq.soc.analyst` | Investiga incidentes P1/P2, pide acciones del catálogo de Ankay, documenta el timeline |
| Líder SOC | `qapaq.soc.lead` | Aprueba acciones (SoD, step-up), decide escalamiento a dirección y comunicación, dueño del backlog de detección |
| Ingeniería de detección | `qapaq.soc.lead` / `qapaq.automation.engineer` (pendiente, docs/14) | Ciclo de vida de reglas, cazas, calidad, playbooks |
| Platform | `qapaq.platform.admin` | Fuentes, collectors, manager, despliegues y permisos de proveedores |
| Auditoría | `qapaq.auditor` | Revisa evidencia, cadena de auditoría y cumplimiento (SBS 504-2021, ISO 27001) |

## Turnos

| Fase | Cobertura | Cómo |
| --- | --- | --- |
| Lanzamiento (hoy) | Lunes a viernes 08:00–20:00 (hora de Lima) en sitio; fuera de horario **guardia localizable** para P1 | El correo QAPAQ (nivel ≥ 8, `wazuh/alert-mail`) y Teams avisan; el analista de guardia acusa en QAPAQ |
| Fase 2 | 24×7 con guardia rotativa semanal (L1) + Líder SOC de respaldo | Rotación publicada en el calendario del SOC; traspaso de turno con la bandeja de QAPAQ vacía o asignada |
| Fase 3 | 24×7 presencial o con MSSP bajo N1 (sin SaaS de logs) | Requiere presupuesto (BL-B04) |

**Traspaso de turno (15 min):** P1/P2 abiertos y su próximo paso, alertas sin acuse, cambios aprobados en curso
(ventanas de mantenimiento cargadas en QAPAQ), fuentes degradadas (vista Integraciones).

## Prioridades y tiempos objetivo

La prioridad la calcula QAPAQ Core (`modules/detection/prioritization.ts`: severidad + identidad privilegiada,
activo crítico/expuesto, repetición, correlación y cadena; break-glass siempre P1).

| Prioridad | Ejemplos | Acuse (MTTA) | Contención o decisión | Resolución objetivo | Escalamiento |
| --- | --- | --- | --- | --- | --- |
| **P1** | Cadena de compromiso (101700–101713, 101750), break-glass/root, CloudTrail apagado, malware con protección deshabilitada | 15 min (guardia 24×7) | 1 h | 24 h | Líder SOC de inmediato; dirección si hay datos de clientes o fraude |
| **P2** | Fuerza bruta/spray, rol privilegiado, reenvío de correo, crítica expuesta con exploit, oleada WAF | 1 h en horario; 4 h fuera | 4 h | 3 días hábiles | Líder SOC si no hay contención en 4 h |
| **P3** | Cambios de control con ticket dudoso, vulnerabilidad alta, FIM fuera de cambio | 1 día hábil | — | 10 días hábiles | Revisión semanal |
| **P4** | Higiene (firmas, agente desactualizado), informativos | Revisión semanal | — | Backlog | — |

## Escalamiento

1. **L1 → L2:** toda P1, toda alerta con `qapaq_attack_chain`, o cuando el runbook lo indique.
2. **L2 → Líder SOC:** pedir una acción con efectos (Ankay), incidente con impacto en clientes, o falta de
   contención en el tiempo objetivo.
3. **Líder SOC → dirección / Legal / Riesgos no financieros:** datos personales (Ley 29733), fraude, reporte al
   regulador (SBS) o a clientes. El Líder SOC registra la decisión en el incidente.
4. **Proveedores:** Microsoft, AWS, Cloudflare, Bitdefender y Snyk por los canales de soporte de QAPAQ; el contacto
   queda en el timeline.

## Métricas

| Métrica | Definición | Fuente | Frecuencia |
| --- | --- | --- | --- |
| **MTTD** | `alerta.creada − evento.ocurrido` (latencia de detección e ingesta) | `occurredAt` vs `createdAt` de la alerta QAPAQ | Semanal, por fuente |
| **MTTA** | `primer acuse − alerta.creada` | Timeline del incidente / acuse de notificación | Semanal, por prioridad |
| **MTTR** | `incidente.cerrado − incidente.abierto` (y `contención − apertura` para P1/P2) | Transiciones auditadas del incidente | Mensual |
| **Fidelidad** | `alertas promovidas a incidente verdadero positivo / alertas` por regla | Cierre del incidente con clasificación | Mensual, por regla |
| **Ruido** | Alertas por regla y por día; top 10 de volumen | «QAPAQ · Calidad de detección» | Semanal |
| **Cobertura** | Técnicas cubiertas y brechas de prioridad alta | `detections/reports/mitre-coverage.md` | Por cambio de reglas |
| **Salud de fuentes** | Fuentes con datos en las últimas 24 h | Vista Integraciones | Diaria |

**Revisión semanal de calidad (30 min, Líder SOC + ingeniería):** top 10 de volumen, reglas con fidelidad < 20 %
en el mes, falsos positivos repetidos (se convierten en afinamiento o en lista, nunca en silencio sin registro),
brechas nuevas y estado del backlog. Hallazgo actual: **521 (rootcheck, nivel 11)** genera ~10 % de las alertas
del nodo sin incidentes: primer candidato a afinamiento (BL-Q01).
