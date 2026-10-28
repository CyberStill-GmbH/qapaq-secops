<#
.SYNOPSIS
  Construye el paquete interno Windows (MSI de Wazuh y Sysmon) y fija sus SHA-256 en el manifiesto.

.DESCRIPTION
  Lo ejecuta una vez por versión un operador de QAPAQ en un equipo de construcción, nunca un
  endpoint. Descarga desde las URL del manifiesto a -OutputDir, exige firma Authenticode válida
  del fabricante declarado y escribe el SHA-256 resultante en package-manifest.json. El cambio
  del manifiesto se revisa en un PR: es el punto donde QAPAQ decide confiar en esos binarios.

  Sysmon.zip no tiene URL versionada; por eso el manifiesto guarda también la versión del
  ejecutable, y los instaladores rechazan otro hash aunque Microsoft publique una versión nueva.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'package-manifest.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

foreach ($artifact in $manifest.artifacts | Where-Object { $_.verification.type -eq 'authenticode' }) {
    $target = Join-Path $OutputDir $artifact.file
    if ($PSCmdlet.ShouldProcess($artifact.url, "descargar a $target")) {
        Invoke-WebRequest -Uri $artifact.url -OutFile $target -UseBasicParsing
    }
    $signed = $target
    $work = $null
    if ($artifact.verification.PSObject.Properties['innerFile']) {
        $work = Join-Path $env:TEMP "qapaq-manifest-$([guid]::NewGuid())"
        Expand-Archive -LiteralPath $target -DestinationPath $work
        $signed = Join-Path $work $artifact.verification.innerFile
    }
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $signed
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*$($artifact.verification.signerSubjectContains)*") {
            throw "[QAPAQ manifest] firma inválida en $($artifact.file): $($signature.Status) $($signature.SignerCertificate.Subject)"
        }
        if ($artifact.PSObject.Properties['version']) {
            $artifact.version = (Get-Item -LiteralPath $signed).VersionInfo.FileVersion
        }
    } finally {
        if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $artifact.sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "[QAPAQ manifest] $($artifact.id) $($artifact.sha256) firmado por $($signature.SignerCertificate.Subject)"
}

$pending = @($manifest.artifacts | Where-Object { $_.sha256 -notmatch '^[0-9a-f]{64}$' }).Count
$manifest.status = if ($pending -eq 0) { 'pinned' } else { 'hashes-pending' }
$json = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($ManifestPath, $json + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "[QAPAQ manifest] actualizado; artefactos pendientes: $pending. Copiar $OutputDir al recurso compartido de despliegue."
