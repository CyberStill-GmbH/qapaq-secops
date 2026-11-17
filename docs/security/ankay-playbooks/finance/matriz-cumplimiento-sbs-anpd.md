# Matriz de apoyo a evidencia regulatoria: SBS 504-2021, Ley 29733/ANPD y marco de confianza digital

**Qué es:** una guía de qué evidencia producen los playbooks financieros y cómo se relaciona
con obligaciones de la normativa peruana. **No es una declaración de cumplimiento.** El
cumplimiento lo determinan QAPAQ, su oficial de seguridad de la información, su oficial de
datos personales, legal y la SBS/ANPD en la supervisión. Esta matriz no reemplaza la
opinión legal.

**Revisión documental:** 2026-10-28, sobre los textos oficiales enlazados. Antes de usarla
en un proceso real, legal debe validar las filas marcadas *interpretación* y todos los
puntos de la sección [Pendientes de validación legal](#pendientes-de-validación-legal).

Leyenda de **Estado**:

- **Verificado:** el artículo y su contenido se leyeron en la fuente oficial enlazada.
- **Interpretación:** lectura de QAPAQ SecOps, fuente secundaria, o texto oficial no
  legible (PDF escaneado). Requiere validación legal.
- **No encontrado:** se buscó en fuente oficial y no se halló. No se debe asumir.

## Fuentes oficiales

| Norma | Fuente |
|---|---|
| Res. SBS N.° 504-2021, Reglamento para la Gestión de la Seguridad de la Información y la Ciberseguridad | [El Peruano](https://busquedas.elperuano.pe/normaslegales/aprueban-el-reglamento-para-la-gestion-de-la-seguridad-de-la-resolucion-no-504-2021-1929393-1/) · [texto concordado SBS v2.0](https://intranet2.sbs.gob.pe/dv_int_cn/2046/v2.0/Adjuntos/504-2021.R.pdf) |
| Res. SBS N.° 00814-2025, modifica el art. 15 del Reglamento de Gestión de la Continuidad del Negocio (Res. SBS N.° 877-2020) | [El Peruano](https://busquedas.elperuano.pe/dispositivo/NL/2377339-1) |
| Ley N.° 29733, Ley de Protección de Datos Personales, y su Reglamento, D.S. N.° 016-2024-JUS | [gob.pe ANPD](https://www.gob.pe/institucion/anpd/normas-legales/6554453-16-2024-jus) · [PDF del Reglamento](https://cdn.www.gob.pe/uploads/document/file/7756037/6554453-reglamento-de-la-ley-n-29733.pdf) |
| D.U. N.° 007-2020, Marco de Confianza Digital, y su Reglamento, D.S. N.° 126-2025-PCM | [gob.pe PCM](https://www.gob.pe/institucion/pcm/normas-legales/7370829-126-2025-pcm) · [PDF del Reglamento](https://cdn.www.gob.pe/uploads/document/file/8993787/7370829-2-reglamento.pdf) |

## Matriz

Las claves en `código` son las que usa `regulatory:` en
[`finance-catalog.yaml`](../finance-catalog.yaml).

### `SBS-504-INC` · Gestión de incidentes y servicio de operaciones de seguridad

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Res. SBS 504-2021, art. 8.2 | Contar con un equipo multidisciplinario para manejar incidentes de ciberseguridad. | RACI de cada runbook con roles de SOC, TI, negocio, legal y cumplimiento. | Verificado |
| Art. 12.6.a–b | Procedimiento de gestión de incidentes, metodología de clasificación y protocolos de respuesta y recuperación. | Ocho runbooks con detección, triage, contención, erradicación, recuperación; prioridad P1–P4 y `slaPolicy`. | Verificado |
| Art. 12.6.c | Servicio de operaciones de seguridad para detección y respuesta, con monitoreo de la red interna y de la infraestructura. | Reglas 101400–101445 sobre M365, AD, endpoint, Sophos y Cato; triage automático de solo lectura en Ankay; casos en QAPAQ. | Verificado |
| Art. 12.6.d | Acceso a inteligencia de amenazas y a bases de tácticas y técnicas de atacantes. | Reglas con técnicas MITRE ATT&CK; consulta manual de VirusTotal por hash (fuera de estos workflows). | Verificado |
| Art. 12.6.e | Reporte interno de incidentes y a la SBS según el art. 15. | Aviso por outbox QAPAQ (Teams); RB-FIN-08 prepara el expediente para la SBS. | Verificado |
| Art. 12.6.f–g | Lecciones aprendidas y preservación de evidencia forense. | Sección de lecciones aprendidas en cada runbook; evidencias con hash SHA-256 y cadena de custodia en el caso QAPAQ. | Verificado |

### `SBS-504-REP` · Reporte de incidentes significativos a la SBS

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Res. SBS 504-2021, art. 15.1 | Reportar a la SBS los incidentes de ciberseguridad con impacto adverso significativo, verificado o presumible, por pérdida o hurto de información, fraude interno o externo, daño reputacional o interrupción de operaciones. | RB-FIN-08 evalúa los cuatro criterios y registra la decisión del comité con hora. Los playbooks 01, 02, 03, 05 y 07 marcan candidatos. | Verificado |
| Art. 15.1, plazo | El reporte se hace “en cuanto” la empresa advierta el incidente. **El artículo no fija horas.** | El reloj regulatorio de QAPAQ parte de la hora de detección registrada; la evaluación regulatoria P1 es interna (4 h), no un plazo legal. | Verificado (sin plazo en horas) |
| Art. 15.2 | Análisis forense con informe ejecutivo e informe técnico a disposición de la SBS. | RB-FIN-08 define ambos informes y su contenido; las evidencias del caso los respaldan. | Verificado |
| Art. 15.3 | La SBS establecerá por norma general el contenido, formato y protocolo del reporte. | El expediente de RB-FIN-08 se adaptará al formato cuando se confirme. | **No encontrado** (norma general) |

### `SBS-504-ACC` · Accesos privilegiados y segregación de funciones

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Res. SBS 504-2021, art. 12.2.b | Gestión de accesos, incluidas cuentas con privilegios administrativos, con segregación de funciones, mínimo privilegio y necesidad de conocer. | 101425–101428 vigilan privilegios y break-glass; 101442–101445 detectan acceso fuera de función; toda acción con efecto exige control dual y aprobador distinto del solicitante. | Verificado |
| Arts. 18–20 | Autenticación de usuarios en canales digitales (enrolamiento con dos factores, autenticación reforzada y exenciones). | Fuera del alcance de estos playbooks (clientes en canales digitales); RB-FIN-06 cubre la suplantación de marca. | Verificado (no cubierto) |
| Art. 17.4 | Monitoreo transaccional contra el fraude. | 101402–101404 dan señales de fraude de pagos a proveedores; no sustituyen el monitoreo transaccional de clientes. | Verificado (cobertura parcial) |

### `SBS-504-LOG` · Registros y evidencia

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Res. SBS 504-2021, art. 17.1.e | Lineamientos de retención de registros de auditoría en la autenticación de canales digitales. **No fija un periodo.** | Las alertas quedan en `wazuh-alerts-*` y las evidencias en el caso QAPAQ; la retención la define la política de QAPAQ. | Verificado (sin periodo) |
| Arts. 22–23 | Gestión de proveedores de TI y nube, incluida la revisión de sus logs. | Evidencia de Sophos, Cato y M365 se obtiene por adaptadores de lectura con procedencia. | Verificado |

### `SBS-504-CONT` · Interrupción de operaciones

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Res. SBS 504-2021, Disposición Complementaria Final Tercera | La interrupción de operaciones causada por un incidente de seguridad también se reporta según el art. 15 del Reglamento de Continuidad del Negocio. | RB-FIN-05 (ransomware) y RB-FIN-08 registran inicio y fin de la afectación por servicio y canal. | Verificado |
| Res. SBS 877-2020, art. 15.2 (modificado por Res. SBS 00814-2025) | Bancos, financieras, cajas y otras empresas reportan la suspensión de servicios priorizados o la caída de un canal por 4 horas o más; en canales presenciales, la caída del 25 % de los puntos de atención. **Máximo 5 h desde el inicio** si ocurre entre 07:00 y 16:00; si no, al inicio de la siguiente jornada hábil. | RB-FIN-08 calcula el reloj de continuidad desde el inicio de la interrupción (no desde la detección). | Verificado (vigente desde 2025-03-11) |
| Res. SBS 877-2020, art. 15.3 (modificado) | Umbral de 1 hora y plazo máximo de 2 h para empresas con requerimiento de patrimonio efectivo por concentración de mercado. | Aplicabilidad a QAPAQ por confirmar con cumplimiento. | Verificado (aplicabilidad pendiente) |

### `LPDP-SEG` · Medidas de seguridad de datos personales

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| Ley 29733, art. 16 | Medidas técnicas, organizativas y legales de seguridad para el tratamiento de datos personales. | Detección de exfiltración (RB-FIN-03) y de acceso indebido (RB-FIN-07); los workflows no copian datos de clientes. | Interpretación (texto oficial escaneado) |
| D.S. 016-2024-JUS, art. 46.1 | Gestión de accesos, autenticación y revisión de privilegios, al menos semestral. | 101425–101428 y la lista `qapaq-finance-core-users` mantenida por IAM aportan insumos a la revisión. | Verificado |
| D.S. 016-2024-JUS, art. 46.3 | Registros de trazabilidad sobre datos personales (usuario, sesiones, acciones); **conservación mínima de 2 años**. | Las reglas consumen esos registros; el periodo de retención del SIEM debe alinearse (decisión fuera de este cambio). | Verificado |
| D.S. 016-2024-JUS, art. 47 | Documento de seguridad con fecha cierta (puede referirse a NTP-ISO/IEC 27001). | Este catálogo y los runbooks pueden citarse como anexos operativos. | Verificado |

### `LPDP-BRECHA` · Notificación de incidentes de datos personales

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| D.S. 016-2024-JUS, art. 2.16 | Define incidente de seguridad de datos personales. | RB-FIN-03 y RB-FIN-07 piden la decisión de exposición al oficial de datos personales. | Verificado |
| Art. 34.1 | Notificar a la ANPD los incidentes con gran volumen de datos, muchos afectados, datos sensibles o perjuicio evidente a derechos, aun si se resolvieron internamente. **Máximo 48 h desde que se toma conocimiento**; un retraso debe justificarse con sustento. | RB-FIN-08 inicia el reloj de 48 h cuando el oficial de datos confirma el incidente y deja constancia de la hora. | Verificado |
| Art. 34.2 | Contenido mínimo: naturaleza, tipos de datos y número aproximado de afectados, contacto del oficial de datos, consecuencias y medidas. | El expediente de RB-FIN-08 tiene una sección por cada elemento. | Verificado |
| Art. 34.3–34.4 | Comunicar a los titulares afectados en lenguaje claro (48 h); no hace falta si no hubo afectación y el incidente quedó superado. | RB-FIN-08 deja la decisión y el texto a legal y comunicaciones. | Verificado |
| Art. 34.5 | Si el incidente es digital, notificar también al CNSD. | Ver fila `D.U. 007-2020` abajo. | Verificado |
| Art. 36 | El encargado del tratamiento informa al responsable “de forma inmediata”. | Aplica a proveedores; RB-FIN-08 registra avisos recibidos de terceros. | Verificado |

### `LPDP-REG` · Registro de incidentes

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| D.S. 016-2024-JUS, art. 35 | Documentar todo incidente de datos personales: hechos, efectos y medidas. | Cada caso QAPAQ guarda línea de tiempo, evidencias, decisiones y medidas; RB-FIN-08 exporta el registro. | Verificado |
| D.S. 016-2024-JUS, vigencia | Deroga el D.S. 003-2013-JUS; publicado el 2024-11-30, rige a los 120 días calendario (fecha calculada 2025-03-30). | — | Verificado (fecha calculada: interpretación) |

### Marco de confianza digital (referencia adicional, sin clave en el catálogo)

| Artículo | Obligación (resumen) | Cómo apoyan los playbooks la evidencia | Estado |
|---|---|---|---|
| D.S. 126-2025-PCM, art. 18.1.a | Notificar al Centro Nacional de Seguridad Digital (CNSD) los incidentes de seguridad digital; no exime de notificar a la ANPD. Incluye a proveedores de servicios digitales del sector financiero. | RB-FIN-08 lo incluye en la evaluación. | Verificado |
| Art. 31 | Canales (plataforma del CNSD, correo cifrado, teléfono) y contenido mínimo: descripción, clasificación, impacto e indicadores de compromiso. | Los IoC del caso se exportan sin datos personales. | Verificado |
| Art. 32.1 | Incidentes de nivel crítico: **máximo 48 h desde que se toma conocimiento**. | Reloj en RB-FIN-08. | Verificado |
| Art. 32.2 | Plazos para otros niveles: los fija la SGTD-PCM. | — | No encontrado |
| Vigencia | 90 días calendario desde la publicación (2025-11-04): alrededor del 2026-02-02. | — | Interpretación |

## Pendientes de validación legal

1. **Plazo en horas del reporte a la SBS (art. 15.1 de la 504-2021):** el texto dice “en
   cuanto advierta”. Confirmar si existe oficio múltiple o norma general (art. 15.3) con
   formato, canal y plazo. Mientras tanto RB-FIN-08 trata el reporte como inmediato tras la
   decisión del comité.
2. **Proyecto Res. SBS N.° 02271-2026** (reporte único de incidentes operacionales,
   prepublicado en septiembre de 2026): verificar si se aprobó, sus plazos y si reemplaza
   el art. 15 de la 504-2021 y el art. 15 del Reglamento de Continuidad. Fuente secundaria:
   [El Peruano](https://elperuano.pe/noticia/304837-entidades-supervisadas-sbs-propone-nuevos-lineamientos-para-reportar-incidentes-operacionales).
3. Texto consolidado de la 504-2021 con las modificatorias 3797-2023 y 02286-2024 y
   cualquier otra de 2025–2026. El texto concordado SBS v2.0 solo integra la 1515-2021.
4. Medio de envío del reporte de interrupción (Res. SBS 00814-2025) y si QAPAQ está sujeta
   al numeral 15.3 (concentración de mercado).
5. Fecha exacta de vigencia del D.S. 016-2024-JUS y lineamientos de la ANPD sobre la
   notificación.
6. Texto oficial legible del art. 16 de la Ley 29733.
7. Vigencia del D.S. 126-2025-PCM y plazos de incidentes no críticos.
8. Coordinación de los reportes a SBS, ANPD y CNSD para un mismo incidente y si alguno
   actúa como canal único.
9. Periodo de retención de registros del SOC: la 504-2021 no lo fija; el único mínimo
   encontrado son 2 años para registros sobre datos personales (art. 46.3 del D.S.
   016-2024-JUS).
10. Criterio interno de “impacto adverso significativo” (umbrales de clientes, montos,
    duración) que el comité aplicará en RB-FIN-08.
