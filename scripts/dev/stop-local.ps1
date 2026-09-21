[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$environmentFile = Join-Path $repositoryRoot '.env.local'
$composeFile = Join-Path $repositoryRoot 'infra\local\compose.yaml'
$wazuhCompose = Join-Path $repositoryRoot '.local\wazuh-docker\single-node\docker-compose.yml'

if (Test-Path $environmentFile) {
    docker compose --env-file $environmentFile -f $composeFile down
}
if (Test-Path $wazuhCompose) {
    docker compose -f $wazuhCompose down
}
