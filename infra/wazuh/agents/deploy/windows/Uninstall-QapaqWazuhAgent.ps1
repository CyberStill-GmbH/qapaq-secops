<#
.SYNOPSIS
  Rollback del agente Wazuh QAPAQ en Windows: detiene el servicio y desinstala el MSI.

.DESCRIPTION
  No toca Sysmon (usar -RemoveSysmon para retirarlo también). Conserva una copia de
  ossec.conf y del log del agente en %ProgramData%\QAPAQ\wazuh-agent\rollback-<fecha> para la
  investigación. El registro del agente en el manager se elimina aparte, desde el manager
  (docs/security/agents/05-operacion.md §4): este script no tiene credenciales del API.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$RemoveSysmon)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installDir = Join-Path ${env:ProgramFiles(x86)} 'ossec-agent'
$evidence = Join-Path $env:ProgramData "QAPAQ\wazuh-agent\rollback-$(Get-Date -Format yyyyMMddTHHmmss)"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
foreach ($file in 'ossec.conf', 'ossec.log', 'wazuh-agent.state') {
    $path = Join-Path $installDir $file
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $evidence }
}

$keys = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
$entry = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Wazuh Agent' } |
    Select-Object -First 1
if (-not $entry) {
    Write-Host '[QAPAQ wazuh] no hay agente Wazuh instalado.'
} elseif ($PSCmdlet.ShouldProcess($env:COMPUTERNAME, "msiexec /x $($entry.PSChildName)")) {
    Stop-Service -Name 'WazuhSvc' -ErrorAction SilentlyContinue
    $log = Join-Path $evidence 'msi-uninstall.log'
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $entry.PSChildName, '/qn', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
    if ($process.ExitCode -notin 0, 3010) { throw "[QAPAQ wazuh] msiexec /x terminó con código $($process.ExitCode)." }
    Write-Host "[QAPAQ wazuh] agente desinstalado; evidencia en $evidence."
}

if ($RemoveSysmon -and (Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue)) {
    $sysmon = Join-Path $env:windir 'Sysmon64.exe'
    if ($PSCmdlet.ShouldProcess($env:COMPUTERNAME, 'Sysmon64.exe -u')) {
        Start-Process -FilePath $sysmon -ArgumentList '-u' -Wait -NoNewWindow
        Write-Host '[QAPAQ sysmon] Sysmon desinstalado.'
    }
}
