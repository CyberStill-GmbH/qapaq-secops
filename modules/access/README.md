# Access

Ownership: identidad Entra, sesión BFF, capabilities, scopes y autorización por
recurso/campo. No importa SDKs desde el dominio: el intercambio de código y el JWKS son
puertos, y los adaptadores viven en `apps/api`.

Implementado en C-18 y C-25:

- handshake OIDC con `state`, `nonce` y PKCE S256, y rechazo de replay de `state`;
- validación de `id_token` RS256 contra JWKS, con emisor, audiencia, tenant, ventana
  temporal, `nonce` y método de autenticación;
- sesión opaca con vencimiento por inactividad y por vida máxima, revocación y
  **sesión única** por persona;
- capabilities por rol intersecadas con los scopes del cliente, y autorización
  contextual por recurso y por campo;
- origen de red confiable con cadena de proxies, passkey obligatoria fuera de la red
  QAPAQ, Smart Lockout por `(sujeto, origen)` y limitación de tasa.

Specs: `modules/access/test`. Recorrido sobre HTTP: `apps/api/test/bff.spec.ts`.
