# Documentación QAPAQ SOC

**QAPAQ SOC** es la plataforma de operaciones de seguridad de la fintech QAPAQ: Wazuh 4.14.8 con marca
QAPAQ, el motor QAPAQ (alertas, incidentes, auditoría), Ankay (SOAR), Qapaqzito (asistente de IA) y
las integraciones con Microsoft 365, Bitdefender, Snyk, Cloudflare y AWS. Hoy corre en un nodo EC2
de la cuenta AWS de QAPAQ, sin recursos IAM ([02](02-arquitectura.md)).

Leyenda usada en todos los documentos: **verificado** (probado en el nodo o con pruebas
automatizadas), **sin verificar** (existe en el repositorio, no probado contra el proveedor real),
**por verificar** (afirmación pendiente de comprobación) y **propuesto / objetivo** (no desplegado).

## Empezar aquí

| Si eres… | Lee |
| --- | --- |
| Analista, líder SOC o auditor | [20 · Guía de usuario](20-guia-de-usuario.md) → [17 · Ingeniería de detección](17-ingenieria-de-deteccion.md) → [runbooks](detection-engineering/runbooks/README.md) |
| Ingeniero de seguridad | [02 · Arquitectura](02-arquitectura.md) → [18 · Integraciones](18-integraciones.md) → [16 · Políticas](16-politicas.md) → [17](17-ingenieria-de-deteccion.md) |
| Administrador de plataforma | [06 · Operación](06-operacion.md) → [04 · Identidad y acceso](04-identidad-y-acceso.md) → [21 · Postura de seguridad](21-postura-de-seguridad.md) |
| Responsable del producto | [01 · Producto](01-producto.md) → [19 · Brechas y roadmap](19-brechas-y-roadmap.md) → [10 · Decisiones](10-decisiones.md) |

## Plataforma vigente

| # | Documento | Pregunta que responde |
| - | --- | --- |
| 01 | [Producto](01-producto.md) | Qué es QAPAQ SOC, roles y decisiones de negocio |
| 02 | [Arquitectura](02-arquitectura.md) | Qué corre, dónde y cómo fluyen los datos (con diagrama del despliegue AWS) |
| 04 | [Identidad y acceso](04-identidad-y-acceso.md) | Login QAPAQ, proxy auth, edge, cuentas demo por rol y separación de funciones |
| 05 | [Datos y retención](05-datos-y-retencion.md) | Dónde vive cada dato y cuánto se guarda |
| 06 | [Operación](06-operacion.md) | Runbook: despliegue por componente, credenciales STS, secretos, respaldos, baja, costos, salud y problemas conocidos |
| 07 | [Detección, ML y SOAR](07-deteccion-ml-y-soar.md) | Capas de detección, correlación y respuesta gobernada |
| 08 | [Frontend unificado](08-frontend-unificado.md) | El dashboard de Wazuh como shell y QAPAQ dentro |
| 10 | [Decisiones](10-decisiones.md) | Registro único de decisiones vigentes |
| 13 | [Ankay](13-ankay-qapaq.md) | La respuesta gobernada: motor vigente y diseño objetivo |
| 14 | [Ankay y el núcleo QAPAQ](14-ankay-conexion-qapaq.md) | Contrato, SSO y «Volver al SIEM» |
| 15 | [Qapaqzito](15-qapaqzito-asistente.md) | El asistente de IA: qué lee, con qué permisos, privacidad |
| 16 | [Políticas de seguridad](16-politicas.md) | Políticas como código: agentes, manager, reglas, retención y roles |
| 17 | [Ingeniería de detección](17-ingenieria-de-deteccion.md) | Cómo nace, se prueba, se despliega y se mide una detección; cobertura MITRE, runbooks, Blue Team, playbooks, backlog y vistas de análisis |
| 18 | [Integraciones](18-integraciones.md) | Por fuente: qué recoge, intervalo, reglas, permisos, bloqueos y cómo habilitarla |
| 18 | [Visibilidad de red y capacidades de Wazuh](18-visibilidad-de-red-y-capacidades-wazuh.md) | Conexiones y puertos del host, auditd, SSH, Docker, bitácora del edge, reputación de IP gratuita, correlación Cloudflare/edge/SSH y qué aporta cada módulo de Wazuh |
| 19 | [Brechas y roadmap](19-brechas-y-roadmap.md) | Qué le falta al SOC y quién lo está construyendo |
| 20 | [Guía de usuario](20-guia-de-usuario.md) | Entrar, páginas de la consola, Qapaqzito, Ankay y módulos de Wazuh |
| 21 | [Postura de seguridad](21-postura-de-seguridad.md) | Controles vigentes, límites sin IAM, servicios apagados y riesgos aceptados |
| 22 | [Registro de cambios](22-registro-de-cambios.md) | Qué se hizo en el esfuerzo de despliegue, por commit |

Otros documentos de apoyo: [infra/aws-poweruser](../infra/aws-poweruser/README.md) (Terraform del
nodo), [AGENTS.md](../infra/aws-poweruser/AGENTS.md) (enrolar agentes), [infra/local](../infra/local/README.md)
(stack local), [`wazuh/`](../wazuh/README.md) (overlay) y la [identidad visual QAPAQ](brand/qapaq-visual-identity.md) (tipografía, paleta, logo y mascotas).

## Ingeniería de detección y Blue Team

- [Ciclo de vida, ramas/PR y estándar de metadatos](detection-engineering/01-ciclo-de-vida.md) · contenido en [`detections/`](../detections/README.md)
- [Cobertura MITRE ATT&CK y brechas](detection-engineering/02-cobertura-mitre.md) · [informe generado](../detections/reports/mitre-coverage.md)
- [Modelo operativo: turnos, SLA P1–P4, escalamiento y métricas](detection-engineering/03-modelo-operativo.md)
- [Ajuste y reducción de falsos positivos (registro)](detection-engineering/07-ajuste-falsos-positivos.md) · allowlists en [`detections/lists/`](../detections/lists/)
- [Playbooks de Ankay](detection-engineering/04-playbooks-ankay.md) · [Backlog y hoja de ruta](detection-engineering/05-backlog.md) · [Vistas de análisis](detection-engineering/06-vistas-de-analisis.md)
- [Runbooks](detection-engineering/runbooks/README.md): credenciales, escalada de privilegios, malware/EDR, vulnerabilidad expuesta, oleada WAF, CloudTrail y auditoría

## Diseño objetivo (no desplegado; requiere IAM)

Si la cuenta concede roles e `iam:PassRole`, el destino es serverless. Estos documentos describen ese
diseño, no la plataforma vigente:

- [AWS serverless: topología, costos y gates](cloud/aws/architecture.md) (`infra/aws-serverless`)
- [03 · Evaluación de componentes](03-evaluacion-de-componentes.md)
- [09 · Plan de lanzamiento serverless](09-plan-de-lanzamiento.md)
- [11 · Colas y caché (SQS, Scheduler)](11-cache-y-colas.md)
- [12 · Backend en Lambda](12-backend-en-el-siem.md)

## Referencia y archivo

- [25 · Programa de confiabilidad e investigación SOC](25-programa-confiabilidad-e-investigacion.md): auditoría, secuencia, criterios de aceptación, privacidad y gates de liberación.
- [23 · Claude y Wazuh MCP para operaciones SOC](23-claude-wazuh-mcp-soc.md): propuesta de triaje asistido, MCP privado, UX de administración, respuesta gobernada y control de costos.
- [24 · Operación gobernada de Qapaqzito](24-qapaqzito-operacion-gobernada.md): contratos pendientes para sugerencias revisables, configuración, presupuesto compartido y documentos versionados.
- [27 · Evaluación AiSOC y plan del analista Python/MCP](27-aisoc-mcp-evaluacion-y-plan.md): comparación upstream/QAPAQ, brechas confirmadas, arquitectura de trabajos durables, costos, seguridad, UX, pruebas y gates antes de implementar.

- `reference/`: archivos que el código o la CI leen (catálogo de errores, inventario de fuentes,
  guía de extensión de proveedores, baseline de toolchain, gates de release) y decisiones heredadas.
  Si se mueven, hay que actualizar los tests que los referencian.
- [`archive/`](archive/README.md): **legado**. Perfil Azure, diseño AWS anterior sobre ECS y
  material de fuentes no contratadas (Sophos/Cato). No describe la plataforma vigente.

## Reglas de esta documentación

- Un tema, un documento. Si algo ya está en el código o en git, se enlaza en vez de repetirse.
- Sin credenciales: solo nombres de archivos y variables (`/opt/qapaq/secrets/...`).
- Cada afirmación de estado usa la leyenda de arriba; lo no comprobado se marca **por verificar**.
- Las decisiones nuevas se agregan como fila en [10-decisiones.md](10-decisiones.md), no como un
  archivo ADR nuevo. Los cambios del despliegue se anotan en [22](22-registro-de-cambios.md).
