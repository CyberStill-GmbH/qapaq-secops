# Downstream go-jose v4 migration

The gateway build applies two small downstream patches to pinned KrakenD
modules so the final KrakenD CE binary uses the fixed `github.com/go-jose/go-jose/v4`
release without retaining the vulnerable v3 module.

| Source | Version and commit | License |
| --- | --- | --- |
| [krakend-jose](https://github.com/krakend/krakend-jose) | `v3.0.1`, `3aa1f0176b0e9e75023e2b258a9bff473b61facf` | Apache-2.0; upstream `LICENSE` and `NOTICE.txt` stay with the checkout |
| [go-auth0](https://github.com/krakend/go-auth0) | `v2.0.1`, `fe3d54b3d0ccd3a580b0a43e03df8d60b2b3ed73` | MIT; upstream `LICENSE` stays with the checkout |
| [go-jose](https://github.com/go-jose/go-jose) | `v4.1.6`, commit `a0111f82742fa92bceec9ede40845e73319e6230` | Apache-2.0; consumed as the upstream Go module |

The patch files retain the upstream source notices. The build checks each
KrakenD module commit before applying its patch, then checks both the module
graph and compiled binary to ensure go-jose v3 is absent and v4.1.6 is present.

The adapter keeps compact JWT serialization, audience intersection, issuer
validation, and the complete set of signature algorithms supported by the
previous parser. KrakenD still applies its configured algorithm check before
key lookup; all shipped validator configurations specify `RS256`. The added
go-auth0 tests are `TestV4RS256JWTAndJWKSCompatibility`,
`TestV4RejectsOversizedRSAJWKInJWKS`, and
`TestV4RejectsOversizedRSAJWKInCompactJWTHeader`. They cover RS256 validation
through a JWKS endpoint, issuer/audience/algorithm rejection, and rejection of
4097-bit RSA JWKs in both JWKS and compact JWT headers.
