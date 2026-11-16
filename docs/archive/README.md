# Archivo (legado)

> **Legado.** Nada de esta carpeta describe la plataforma vigente de QAPAQ SOC (AWS, modo PowerUser:
> [02](../02-arquitectura.md)). Se conserva como historia y referencia técnica de la base de código
> original de la que deriva el fork. No usar como runbook.

| Carpeta | Contenido |
| --- | --- |
| [`azure/`](azure/README.md) | Perfil Azure heredado (EUS2, Key Vault, bundle del SIEM). QAPAQ no opera en Azure |
| [`legacy/`](legacy/) | Diseño AWS anterior sobre ECS/RDS/KrakenD y su control de costos; migración de Wazuh por Terraform; inventario de capacidades heredado; baseline Sophos/Cato; perfil multifuente y método de detección del perfil Azure |

Lo vigente sobre esos temas: operación y costos en [06](../06-operacion.md), integraciones en
[18](../18-integraciones.md), detección en [17](../17-ingenieria-de-deteccion.md).
