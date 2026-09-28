[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$ConfigPath = 'docs/verification-checks.json'
)

$ErrorActionPreference = 'Stop'
$checkOrder = @('format', 'lint', 'unit', 'integration', 'typecheck', 'boundaries', 'build', 'smoke')
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$resolvedConfig = if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
    (Resolve-Path -LiteralPath $ConfigPath).Path
} else {
    (Resolve-Path -LiteralPath (Join-Path $resolvedRoot $ConfigPath)).Path
}
$configuration = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
$failed = $false
$incomplete = $false

Push-Location $resolvedRoot
try {
    foreach ($name in $checkOrder) {
        $check = $configuration.$name
        if ($null -eq $check) {
            Write-Output "INCOMPLETE ${name}: sin configurar"
            $incomplete = $true
            continue
        }
        if ($check.notApplicable) {
            Write-Output "N/A ${name}: $($check.notApplicable)"
            continue
        }
        if (-not $check.executable -or $null -eq $check.arguments) {
            Write-Output "FAIL ${name}: configuración inválida"
            $failed = $true
            continue
        }

        $command = Get-Command $check.executable -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            Write-Output "FAIL ${name}: no se encontró $($check.executable)"
            $failed = $true
            continue
        }

        & $command.Source @($check.arguments)
        if ($LASTEXITCODE -eq 0) {
            Write-Output "PASS $name"
        } else {
            Write-Output "FAIL ${name}: exit $LASTEXITCODE"
            $failed = $true
        }
    }
} finally {
    Pop-Location
}

if ($failed) { exit 1 }
if ($incomplete) { exit 2 }
exit 0
