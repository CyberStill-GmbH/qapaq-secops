# Guía de extensión a un nuevo proveedor (C-23)

Esta guía describe qué hace falta para incorporar una segunda fuente de eventos sin
tocar el dominio. No se acompaña de un proveedor de ejemplo: un adapter ficticio
demostraría que nuestro doble encaja con nuestro puerto y poco más. En su lugar, las
reglas se verifican sobre el único adapter real —Wazuh— en
[`tests/architecture/provider-coupling.spec.ts`](../../tests/architecture/provider-coupling.spec.ts).

## Qué implementa un proveedor

Un proveedor implementa el puerto `SecurityEventProvider`
([`modules/connectors/src/application/security-event-provider.ts`](../../modules/connectors/src/application/security-event-provider.ts)).
El puerto expone cuatro capacidades y ninguna más:

| Operación | Responsabilidad | Lo que **no** debe hacer |
| --- | --- | --- |
| `capabilities()` | Declarar datasets, tamaño de página y criterio de orden | Inventar datasets que el proveedor no sirve |
| `health()` | Informar estado por componente con latencia | Reportar `healthy` sin consultar nada |
| `readPage(query)` | Devolver registros neutrales y cursor opaco | Devolver tipos del proveedor o estructuras propias |
| — | — | Escribir en el proveedor: la lectura es de solo lectura |

El `ProviderRecord` que devuelve `readPage` es neutral: identificador de origen, dataset,
instante de recolección y el documento crudo. La traducción a
`qapaq.security-event/1.0.0` ocurre después, en el mapping de C-12.

## Procedimiento

1. **Registrar la ruta en la pasarela.** Todo tráfico hacia un proveedor pasa por
   KrakenD. Añadir la ruta a
   [`platform/gateway/krakend/routes.json`](../../platform/gateway/krakend/routes.json)
   con método, auth, límite, timeout, clasificación y propietario explícitos. La spec de
   contrato rechaza comodines y rutas sin inventario.
2. **Declarar la configuración.** Las variables van al esquema de
   `platform/configuration`; los secretos viajan como referencia (`*_REF`) y los
   resuelve el `SecretProvider`. Ningún valor sensible se escribe en el repositorio.
3. **Escribir el adapter** bajo `modules/connectors/src/infrastructure/<proveedor>/`.
   Es el único lugar donde puede aparecer el nombre del proveedor, su cliente HTTP y sus
   formas de documento.
4. **Someterlo a la suite de conformidad.** `defineSecurityEventProviderContract` recibe
   el proveedor y ejercita el contrato completo: capacidades coherentes, salud
   estructurada, página vacía válida, orden estable, cursor opaco, cursor caducado,
   ausencia de escrituras y redacción de secretos en errores.
5. **Versionar el mapping.** El normalizador declara `mappingId` y `mappingVersion`; un
   cambio de significado exige una versión nueva, no una edición silenciosa de la
   existente. El rechazo seguro va a cuarentena, no a un `catch` vacío.
6. **Exponer solo la fábrica** desde `modules/connectors/src/public/index.ts`. El cliente
   HTTP y sus tipos permanecen internos.

## Reglas que la suite verifica

- Ningún módulo de dominio (`detection`, `soc`, `soar`, `access`, `audit`) nombra al
  proveedor, ni por tipo, ni por constante, ni en un comentario.
- El contrato canónico `security-event.schema.json` no menciona a ningún proveedor.
- El SOC consume `@qapaq/detection`, nunca `@qapaq/connectors`.
- La suite de conformidad es portable: no construye proveedores ni conoce ninguno.
- El adapter real pasa esa misma suite.
- La superficie pública del módulo expone el puerto y la fábrica, no el cliente.

## Lo que esta guía no resuelve

La aceptación real contra un proveedor autorizado sigue siendo un gate de producto. Un
adapter que pase la suite local demuestra conformidad estructural; no demuestra que el
proveedor responda como su documentación afirma. Esa evidencia se registra en la matriz
de C-22 con su ambiente y su commit.
