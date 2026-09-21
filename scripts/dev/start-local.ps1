[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$environmentFile = Join-Path $repositoryRoot '.env.local'
$composeFile = Join-Path $repositoryRoot 'infra\local\compose.yaml'

if (-not (Test-Path $environmentFile)) {
    throw 'Falta .env.local. Copie .env.example y cambie las credenciales locales.'
}

& (Join-Path $PSScriptRoot 'setup-wazuh.ps1')
docker compose --env-file $environmentFile -f $composeFile up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar la infraestructura QAPAQ local.' }

docker compose --env-file $environmentFile -f $composeFile ps
