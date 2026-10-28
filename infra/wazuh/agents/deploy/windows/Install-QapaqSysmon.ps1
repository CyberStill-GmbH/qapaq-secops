<#
.SYNOPSIS
  Instala o actualiza Sysmon con la configuración base QAPAQ, verificando hash y firma.

.DESCRIPTION
  Sysmon no se versiona en el repositorio (licencia Sysinternals). El paquete interno contiene
  Sysmon.zip descargado de Microsoft por Update-QapaqAgentManifest.ps1, que fija su SHA-256.
  Este script:
    1. Verifica Sysmon.zip contra el manifiesto y Sysmon64.exe con firma Authenticode de Microsoft.
    2. Si Sysmon no está instalado: `Sysmon64.exe -accepteula -i qapaq-sysmon.xml`.
       Si ya está: `Sysmon64.exe -c qapaq-sysmon.xml` (solo cambia la configuración).
  Requiere que QAPAQ haya aceptado la licencia de Sysinternals (decisión registrada en
  docs/security/agents/04-despliegue.md §4): `-accepteula` la acepta en nombre de la organización.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PackageDir = (Join-Path $PSScriptRoot '..\packages'),
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\package-manifest.json'),
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'sysmon\qapaq-sysmon.xml')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { throw "[QAPAQ sysmon] $Message" }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$artifact = $manifest.artifacts | Where-Object { $_.id -eq 'sysmon' }
if (-not $artifact -or $artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
    Fail 'el SHA-256 de Sysmon.zip no está fijado en el manifiesto (TO_BE_PROVIDED).'
}
$zip = Join-Path $PackageDir $artifact.file
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) {
    Fail 'Sysmon.zip no coincide con el SHA-256 del manifiesto.'
}
[xml](Get-Content -LiteralPath $ConfigPath -Raw) | Out-Null

$work = Join-Path $env:TEMP "qapaq-sysmon-$([guid]::NewGuid())"
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $work
    $exe = Join-Path $work $artifact.verification.innerFile
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*$($artifact.verification.signerSubjectContains)*") {
        Fail "firma inválida en $($artifact.verification.innerFile): $($signature.Status)."
    }
    $service = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
    $arguments = if ($service) { @('-c', "`"$ConfigPath`"") } else { @('-accepteula', '-i', "`"$ConfigPath`"") }
    if ($PSCmdlet.ShouldProcess($env:COMPUTERNAME, "Sysmon64.exe $($arguments -join ' ')")) {
        $process = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru -NoNewWindow
        if ($process.ExitCode -ne 0) { Fail "Sysmon64.exe terminó con código $($process.ExitCode)." }
    }
    if ((Get-Service -Name 'Sysmon64').Status -ne 'Running') { Fail 'el servicio Sysmon64 no está en ejecución.' }
    $recent = Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -MaxEvents 1 -ErrorAction SilentlyContinue
    Write-Host "[QAPAQ sysmon] servicio activo; último evento: $(if ($recent) { $recent.TimeCreated } else { 'ninguno aún' })."
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
