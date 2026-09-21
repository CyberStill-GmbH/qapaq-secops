[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$localDataRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
$dockerRun = [System.IO.Path]::GetFullPath((Join-Path $localDataRoot 'Docker\run'))
$secretsEngine = [System.IO.Path]::GetFullPath((Join-Path $localDataRoot 'docker-secrets-engine'))
$settingsPath = Join-Path $env:APPDATA 'Docker\settings-store.json'
$desktopExecutable = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($path in @($dockerRun, $secretsEngine)) {
    if (-not $path.StartsWith($localDataRoot + [System.IO.Path]::DirectorySeparatorChar)) {
        throw "La ruta queda fuera de LocalAppData: $path"
    }
}

Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProcessName -eq 'Docker Desktop' -or
        $_.ProcessName -eq 'docker' -or
        $_.ProcessName -eq 'docker-desktop' -or
        $_.ProcessName -like 'com.docker.*'
    } |
    Stop-Process -Force -ErrorAction SilentlyContinue

wsl.exe --shutdown

foreach ($source in @($dockerRun, $secretsEngine)) {
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = "$source.stale-$timestamp"
    Move-Item -LiteralPath $source -Destination $destination
    Write-Output "Socket aislado: $source -> $destination"
}

if (Test-Path -LiteralPath $settingsPath) {
    Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.backup-$timestamp"
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $settings | Add-Member -NotePropertyName EnableInference -NotePropertyValue $false -Force
    $settings | Add-Member -NotePropertyName EnableDockerAI -NotePropertyValue $false -Force
    $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8NoBOM
}

if (Test-Path -LiteralPath $settingsPath) {
    Copy-Item -LiteralPath $settingsPath -Destination
}

if (-not (Test-Path -LiteralPath $desktopExecutable)) {
    throw "No se encontró Docker Desktop en $desktopExecutable"
}

Start-Process -FilePath $desktopExecutable -WorkingDirectory (Split-Path $desktopExecutable) -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(90)
do {
    Start-Sleep -Seconds 3
    if (Test-Path -LiteralPath '\\.\pipe\dockerDesktopLinuxEngine') { break }
} while ((Get-Date) -lt $deadline)

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop no respondió después de la reparación. Revisar sus logs antes de repetir.'
}

Write-Output 'Docker Desktop responde. Los respaldos .stale se conservan para diagnóstico.'
