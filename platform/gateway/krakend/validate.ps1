param(
  [switch] $SkipDocker
)
$ErrorActionPreference = 'Stop'
$gatewayDir = $PSScriptRoot
Push-Location $gatewayDir
try {
  node --test test/contract.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Gateway contract tests failed.' }
  if (-not $SkipDocker) {
    docker compose --env-file .env.example -f compose.yaml config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration is invalid.' }
    docker run --rm --entrypoint /usr/bin/krakend `
      -v "${gatewayDir}:/etc/krakend:ro" `
      -e FC_ENABLE=1 `
      -e GATEWAY_ENDPOINT_TIMEOUT=4s `
      -e GATEWAY_METRICS_PORT=9091 `
      -e GATEWAY_RATE_PER_SECOND=20 `
      -e GATEWAY_RATE_BURST=40 `
      -e OIDC_JWKS_URL=https://identity.example.invalid/jwks `
      -e OIDC_DISABLE_JWK_SECURITY=false `
      -e OIDC_ISSUER=https://identity.example.invalid/ `
      -e OIDC_AUDIENCE=qapaq-provider-gateway `
      -e WAZUH_INDEXER_URL=https://wazuh-indexer.example.invalid:9200 `
      -e WAZUH_INDEXER_CA_FILE= `
      -e WAZUH_BASIC_AUTH_B64=validation-only `
      -e WAZUH_INDEX_PATTERN=wazuh-alerts-* `
      krakend:latest@sha256:e93eed25554145dc4f2727d203e96c655bd2e609459f05e13afcbf590582496f check -t -n -c /etc/krakend/krakend.tmpl
    if ($LASTEXITCODE -ne 0) { throw 'KrakenD configuration validation failed.' }
  }
} finally {
  Pop-Location
}
