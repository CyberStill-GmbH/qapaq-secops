# Configuración de runtime

`@qapaq/configuration` es la única frontera para interpretar el entorno bruto y
producir configuración tipada. No abre conexiones ni selecciona un proveedor de
secretos productivo. El dominio y la aplicación reciben valores ya validados desde
el composition root.

## Flujo

1. `QAPAQ_PROFILE` selecciona explícitamente `development`, `test` o `production`.
2. Solo se extraen variables conocidas; una variable desconocida con prefijo
   `QAPAQ_` detiene el arranque.
3. Se validan tipos, unidades, protocolos y límites sin coerción ambigua.
4. Las referencias `secret://<namespace>/<name>` se validan antes de llamar al
   `SecretProvider`.
5. Cada referencia se resuelve una sola vez durante un arranque.
6. Se aplica la política TLS del perfil y se congela profundamente el resultado.

`development` y `test` permiten HTTP o transporte sin TLS solamente contra
`localhost`, `127.0.0.1` o `::1`. `production` exige TLS para PostgreSQL, Redis y
MinIO, y exige HTTPS, CA explícita y verificación de certificado para Wazuh
Indexer. Ninguna URL admite usuario o contraseña embebidos.

El adaptador de secretos basado en variables de entorno solo se usa mediante el
loader local del worker y rechaza `production`. El proveedor productivo y su
identidad técnica siguen pendientes de Infraestructura conforme a ADR-013.

## Contratos

- PostgreSQL: host, puerto, base, usuario, password ref, TLS, timeouts y pool.
- Redis: host, puerto, usuario/password ref opcionales en local, DB, TLS, timeouts
  y reintentos. En producción el password ref es obligatorio.
- MinIO: endpoint, puerto, región, bucket raw, access/secret refs, TLS, timeouts y
  reintentos.
- Wazuh Indexer: URL, username/password/CA refs, verificación TLS, timeouts,
  reintentos y paginación. Wazuh Manager se omite porque la vertical aprobada solo
  consulta el Indexer; añadir Manager exige un consumidor documentado.

Los secretos resueltos se encapsulan en `SecretValue`: su serialización y
`toString()` producen `[REDACTED]`; el consumidor explícito usa `reveal()` solo al
crear el cliente correspondiente. `redactSecrets` protege diagnóstico autorizado,
incluidos objetos cíclicos, arrays y credenciales accidentales en URLs. El arranque
normal nunca registra la configuración completa.

## Límites C-03

- puertos: 1–65535;
- duraciones: unidad obligatoria `ms`, `s` o `m`, entre 100 ms y 120 s;
- reintentos adicionales: 0–5;
- página Wazuh inicial/máxima: 50/200;
- pool PostgreSQL: 0–50, con mínimo no mayor al máximo;
- Redis DB: 0–15.

Los valores de reintentos y paginación provienen de ADR-016. Los demás son una
baseline conservadora de C-03 y requieren ADR si cambian de forma incompatible.

## Uso

```ts
const config = await loadRuntimeConfig(process.env, secretProvider);
const password = config.postgres.password.value.reveal();
```

El loader completo falla de forma atómica: si una referencia no se resuelve, no
devuelve configuración parcial. `loadConfigurationAndStart` ejecuta el callback de
arranque únicamente después de completar toda la validación y resolución.

```powershell
pnpm exec vitest run platform/configuration/test/runtime-config.spec.ts --config vitest.config.ts
pnpm --filter @qapaq/configuration typecheck
pnpm --filter @qapaq/configuration build
```
