# C-18 — Comprobación de conectividad real con Microsoft Entra ID

Fecha: 2026-10-01 · Ambiente: estación de desarrollo Windows, red QAPAQ ·
Tenant: `45f2f938-dbe3-4a3e-8a54-930893f94ef8`

Esta comprobación responde a una sola pregunta: **¿Entra reacciona a lo que QAPAQ
construye?** No sustituye la aceptación del flujo completo, que exige una persona real
iniciando sesión y sus claims de rol.

## Qué se comprobó y con qué resultado

| # | Comprobación | Resultado |
| --- | --- | --- |
| 1 | Documento de descubrimiento OIDC del tenant | HTTP 200 en 547 ms |
| 2 | Endpoints derivados por `parseAccess` frente a los publicados por Entra | Coinciden: `issuer`, `authorize`, `token` y `jwks_uri` |
| 3 | `code_challenge_methods_supported` del tenant | Incluye `S256`, que es el único que C-18 emite |
| 4 | JWKS del tenant interpretado por el validador de C-18 | 4 claves RSA publicadas, 4 utilizables por `jwkToPublicKey` |
| 5 | Credencial del app registration (`client_credentials`) | HTTP 200, token `Bearer` emitido con vigencia de 3599 s |
| 6 | URL de autorización construida por `beginAuthorization` | Entra devuelve la pantalla de inicio de sesión, sin ningún código `AADSTS` |

El punto 6 es el más informativo: un `client_id` desconocido habría devuelto `AADSTS700016`
y un `redirect_uri` no registrado, `AADSTS50011`. No apareció ninguno, de modo que la
aplicación y el retorno `http://127.0.0.1:3000/api/auth/callback` son los que el tenant
reconoce.

Ningún secreto ni token se registró en la salida: solo estado HTTP, tipo, vigencia y
longitud.

## Qué sigue pendiente

- **Inicio de sesión interactivo** con una persona del tenant, para observar `amr`,
  `roles` y la emisión del `id_token` que C-18 valida. Requiere intervención humana y
  consentimiento; no se automatiza aquí.
- **Mapeo de roles**: el catálogo de C-18 espera `qapaq.soc.analyst`, `qapaq.soc.lead`,
  `qapaq.auditor` y `qapaq.platform.admin` como app roles del registro. Su publicación en
  el tenant no se ha verificado.
- **Nombres de variables**: el `.env` local declara `QAPAQ_MICROSOFT_ENTRA_*`, mientras el
  esquema de configuración de C-18 lee `QAPAQ_ENTRA_*`. Unificarlos es trabajo pendiente
  antes de arrancar el BFF contra el tenant real.

Por eso el gate `C-18-entra-real` permanece `BLOCKED` en la matriz: la conectividad y la
credencial están demostradas, el recorrido autenticado no.

## Docker en este ambiente

El motor de Docker no se pudo levantar: el Subsistema de Windows para Linux no está
instalado y el servicio privilegiado `com.docker.service` está detenido y no admite
arranque sin privilegios de administrador. Instalar WSL exige elevación y reinicio.

Consecuencia directa: las suites que dependen de contenedores —PostgreSQL de C-19,
perfil HA de C-28 y stack OSS de C-26— permanecen `BLOCKED` tal como las declara
[`blocked-gates.json`](blocked-gates.json). No se marcan como ejecutadas.
