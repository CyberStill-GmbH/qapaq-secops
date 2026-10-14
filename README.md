<p align="center">
  <img src="docs/reference/assets/qapaq-logo.png" alt="Qapaq, una financiera solidaria" width="320" />
</p>

# QAPAQ SecOps

**Plataforma SOC unificada sobre Wazuh.** Una URL, un login Entra y un shell: el dashboard de Wazuh
con marca QAPAQ, al que QAPAQ añade casos, correlación contextual, respuesta gobernada, auditoría
con integridad, gestión de acceso con revocación inmediata y avisos con acuse humano. La investigación
colaborativa es **Ayni Qapaq** y la automatización de respuesta será **Ankay Qapaq** (Shuffle).

- **Wazuh** recolecta, detecta y guarda (manager, indexer, dashboard). Lo que QAPAQ cambia de
  Wazuh vive versionado en [`wazuh/`](wazuh/README.md), sin fork del código.
- **QAPAQ** (TypeScript, NestJS) coordina el trabajo humano: quién toma una alerta, cómo se vuelve
  incidente, quién aprueba una acción, qué queda como evidencia y quién puede entrar.

## Estructura

| Ruta                 | Contenido                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `wazuh/`             | Overlay QAPAQ de Wazuh: reglas, Office 365, edge nginx, seguridad del Indexer, ISM, detectores ML, integraciones y dashboard |
| `apps/api`           | API y BFF (NestJS/Fastify): login Entra, casos, ingesta, notificaciones, auditoría                                           |
| `wazuh/dashboard`    | Dashboard Wazuh rebrandeado y plugin QAPAQ, servido en `qapaq-secops.jappi.net.pe`                                           |
| `modules/`           | Dominio hexagonal sin frameworks: `access`, `soc`, `detection`, `soar`, `connectors`, `telemetry`                            |
| `platform/`          | Auditoría, configuración y secretos, base de datos (Prisma/Postgres), testing, gateway (en retiro)                           |
| `packages/contracts` | Contrato `SecurityEvent` 1.0.0 y catálogo de errores                                                                         |
| `infra/aws`          | Terraform de la demo AWS. `infra/local`: Postgres, Redis y MinIO para desarrollo                                             |

## Documentación

Empieza por [`docs/README.md`](docs/README.md), que tiene diez documentos cortos:

1. [Producto y decisiones de negocio](docs/01-producto.md)
2. [Arquitectura](docs/02-arquitectura.md)
3. [Evaluación de componentes y decisión de fork](docs/03-evaluacion-de-componentes.md)
4. [Identidad, acceso y administración de usuarios](docs/04-identidad-y-acceso.md)
5. [Datos y retención hot/warm/cold](docs/05-datos-y-retencion.md)
6. [Operación, costos y observabilidad](docs/06-operacion.md)
7. [Detección, ML y SOAR](docs/07-deteccion-ml-y-soar.md)
8. [Frontend unificado](docs/08-frontend-unificado.md)
9. [Plan de lanzamiento](docs/09-plan-de-lanzamiento.md)
10. [Decisiones vigentes](docs/10-decisiones.md)

## Desarrollo

```powershell
pnpm install
pnpm infra:up          # Postgres, Redis, MinIO locales (infra/local/README.md)
pnpm dev:api
pnpm dev:web
pnpm verify            # lint, typecheck, unit, boundaries
```

Requisitos: Node 24.21 y pnpm 12.4. Baseline completa en
[`docs/reference/toolchain-and-capacity.md`](docs/reference/toolchain-and-capacity.md).

## Licencias

Código QAPAQ: ver [LICENSE](LICENSE). Wazuh Manager y sus reglas y decoders son GPLv2. El Indexer,
el Dashboard y OpenSearch son Apache-2.0. Las reglas y decoders derivados que viven en `wazuh/`
mantienen la atribución GPLv2.
