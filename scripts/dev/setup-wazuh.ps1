[CmdletBinding()]
param(
    [switch]$PullOnly
)

$ErrorActionPreference = 'Stop'
$wazuhVersion = 'v4.14.7'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localRoot = Join-Path $repositoryRoot '.local'
$wazuhRoot = Join-Path $localRoot 'wazuh-docker'
$singleNode = Join-Path $wazuhRoot 'single-node'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker no está disponible en PATH.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git no está disponible en PATH.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop no está iniciado.' }

if (-not $PullOnly) {
    $dockerInfo = docker info --format '{{json .}}' | ConvertFrom-Json
    $driveName = [System.IO.Path]::GetPathRoot($repositoryRoot).TrimEnd('\').TrimEnd(':')
    $freeBytes = (Get-PSDrive -Name $driveName).Free
    $minimumMemory = 8GB
    $minimumDisk = 50GB
    if ($dockerInfo.NCPU -lt 4 -or $dockerInfo.MemTotal -lt $minimumMemory -or $freeBytes -lt $minimumDisk) {
        $memoryGiB = [math]::Round($dockerInfo.MemTotal / 1GB, 1)
        $freeGiB = [math]::Round($freeBytes / 1GB, 1)
        throw "Capacidad insuficiente para Wazuh single-node: CPU=$($dockerInfo.NCPU), DockerRAM=${memoryGiB}GiB, discoLibre=${freeGiB}GiB. Se requieren 4 CPU, 8 GiB y 50 GiB. Use -PullOnly para precargar sin iniciar."
    }
}

New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
if (-not (Test-Path (Join-Path $wazuhRoot '.git'))) {
    git clone --branch $wazuhVersion --depth 1 https://github.com/wazuh/wazuh-docker.git $wazuhRoot
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo clonar wazuh-docker.' }
}

$actualTag = git -C $wazuhRoot describe --tags --exact-match 2>$null
if ($actualTag -ne $wazuhVersion) {
    throw "El checkout Wazuh local debe estar fijado en $wazuhVersion; actual: $actualTag"
}

Push-Location $singleNode
try {
    docker compose pull
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron descargar las imágenes Wazuh.' }
    if ($PullOnly) { return }

    $certificates = Join-Path $singleNode 'config\wazuh_indexer_ssl_certs\root-ca.pem'
    if (-not (Test-Path $certificates)) {
        docker compose -f generate-indexer-certs.yml run --rm generator
        if ($LASTEXITCODE -ne 0) { throw 'Falló la generación de certificados Wazuh.' }
    }

    docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar el stack Wazuh.' }
}
finally {
    Pop-Location
}

Write-Output 'Wazuh Manager, Indexer y Dashboard quedaron solicitados en single-node.'
