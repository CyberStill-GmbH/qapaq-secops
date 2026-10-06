# Auditoría de autenticación OIDC

Fecha: 2026-10-06
Alcance: Microsoft Entra, flujo Authorization Code + PKCE, callback BFF, validación de `id_token`, cookies de sesión y logging del gateway.

## Resumen

El BFF ya canjea el código en servidor, conserva `code_verifier` y `nonce` fuera del navegador, valida firma RS256/issuer/audience/tenant y entrega una cookie de sesión `HttpOnly`. La auditoría encontró que el handshake no estaba vinculado al navegador que lo inició, lo que permitía login CSRF con un callback de atacante; también encontró comprobaciones incompletas en respuestas OIDC y riesgo de exponer el código de autorización en URL/referrer/logs.

Se implementaron las correcciones P1/P2 descritas aquí. La suite focalizada y los typechecks de `modules/access` y `apps/api` pasan. El typecheck de todo el workspace se detiene por un error de sintaxis preexistente en `platform/database/src/commit-admission.ts:165`; esa edición local no forma parte de esta auditoría.

## Hallazgos corregidos

### OIDC-01 — Alto: callback no estaba ligado al navegador iniciador

- **Ubicación:** `modules/access/src/oidc-handshake.ts:99-145`; `apps/api/src/soc/auth.controller.ts:38-69`; `apps/api/src/http/request-context.ts:50-96`.
- **Evidencia:** antes, el `state` y el `code_verifier` se guardaban solo en el servidor. El callback no requería ninguna prueba de que el navegador que lo presentaba hubiera iniciado ese flujo.
- **Impacto:** un atacante podía iniciar autenticación con su propia cuenta y tratar de hacer que otra persona visite el callback con su `code` y `state`; el BFF podía abrir la sesión del atacante en el navegador de la víctima.
- **Corrección:** cada handshake ahora crea un secreto aleatorio distinto de `state`, lo guarda con el intento y lo emite en una cookie por flujo con `HttpOnly`, `SameSite=Lax`, `Secure` en producción, ruta exclusiva del callback y vencimiento de diez minutos. El callback compara en tiempo constante la cookie y el secreto almacenado antes de canjear el código. La tienda no consume el handshake si falta o no coincide la cookie. Se limpia la cookie al cerrar el callback.
- **Regresión cubierta:** `apps/api/test/bff.spec.ts` intenta el callback desde otro navegador y confirma que el flujo original aún puede completarse.

### OIDC-02 — Medio: errores del proveedor saltaban validación de `state`

- **Ubicación:** `modules/access/src/oidc-handshake.ts:132-153`.
- **Evidencia:** `resolveCallback` devolvía `PROVIDER_ERROR` antes de comprobar `state`, replay, expiración y prueba del navegador.
- **Impacto:** callbacks de error podían evitar el contrato de validación del handshake y, al consumirse el estado en el runtime, invalidar un intento legítimo conocido.
- **Corrección:** primero se validan `state`, expiración/replay y cookie de navegador; solo después se procesa el error del proveedor. Un intento sin la cookie correcta no consume el estado.

### OIDC-03 — Medio: claims del `id_token` confiaban en casts TypeScript

- **Ubicación:** `modules/access/src/id-token.ts:100-183`.
- **Evidencia:** el JSON firmado se convertía mediante cast a `IdTokenClaims`; objetos o tipos malformados podían lanzar excepciones. Una audiencia múltiple se aceptaba sin verificar `azp`.
- **Impacto:** respuestas OIDC malformadas podían provocar errores no controlados y los tokens con varios destinatarios no verificaban el cliente autorizado.
- **Corrección:** se valida la forma de claims antes de acceder a ellos, se manejan claves públicas inválidas sin lanzar y se exige `azp` igual al cliente cuando corresponde.
- **Regresión cubierta:** pruebas de tipos malformados, audiencias múltiples y `azp` incorrecto.

### OIDC-04 — Medio: respuestas JWKS/token se trataban como tipos confiables

- **Ubicación:** `apps/api/src/access/identity-provider.ts:17-120`; `apps/api/src/runtime/secops-runtime.ts:345-367`.
- **Evidencia:** las respuestas JSON externas se convertían a tipos TypeScript con cast y se usaban campos sin validar estructura de JWKS, tipo de `id_token` ni tamaños.
- **Impacto:** una respuesta inválida podía producir excepciones o datos inesperados durante el inicio de sesión.
- **Corrección:** se validan claves RSA de firma y el esquema mínimo de la respuesta de canje; errores al obtener JWKS se convierten en una denegación genérica auditada.

### OIDC-05 — Medio: código de autorización podía filtrarse por referrer y logs

- **Ubicación:** `apps/api/src/soc/auth.controller.ts:48-99`; `platform/gateway/krakend/krakend.tmpl:11-18`.
- **Evidencia:** el callback recibe `code` y `state` en query string, termina con un redirect 303 y KrakenD tenía logging de acceso habilitado por defecto.
- **Impacto:** el referrer del documento de destino o los logs de acceso podían conservar el código temporal y el estado del callback.
- **Corrección:** inicio y callback llevan `Cache-Control: no-store` y `Referrer-Policy: no-referrer`; el access log del router KrakenD queda deshabilitado y la configuración contractual comprueba que siga así. Nginx ya tenía `access_log off`.
- **Nota:** se mantienen la telemetría de métricas y los logs de aplicación; el cambio elimina el access log que incluiría la ruta de autenticación.

## Riesgos pendientes / condiciones de despliegue

1. `SecOpsRuntime` crea `InMemoryHandshakeStore`, `InMemorySessionStore` y `InMemoryRateLimitStore` (`apps/api/src/runtime/secops-runtime.ts:90-95`). Los handshakes y sesiones no sobreviven reinicios ni se comparten entre réplicas. Mantener una sola instancia o implementar adapters persistentes/distribuidos antes de escalar; el `consume(state, browserBinding, now)` de esos adapters debe ser atómico.
2. Las pruebas usan el emisor OIDC local y claves sintéticas; no se probó contra un tenant Entra real. La configuración del tenant, `redirect_uri`, scopes y registro de aplicación siguen requiriendo validación operativa.
3. La desactivación del access log aplica a KrakenD y el balanceador Nginx. Verificar también cualquier ingress, CDN, WAF o proveedor externo que termine TLS o capture URL completa.
4. El workspace completo no compila hasta resolver el error de sintaxis preexistente en `platform/database/src/commit-admission.ts:165`.

## Verificación

- `modules/access/test/oidc-handshake.spec.ts`, `modules/access/test/id-token.spec.ts` y `apps/api/test/bff.spec.ts`: 81 pruebas aprobadas.
- `tsc -p modules/access/tsconfig.json --noEmit`: aprobado.
- `tsc -p apps/api/tsconfig.json --noEmit`: aprobado.
- `node --test platform/gateway/krakend/test/contract.test.mjs`: 7 pruebas aprobadas.
