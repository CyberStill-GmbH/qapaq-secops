# Instalación idempotente del agente Wazuh en Windows (MSI), ejecutada por SSM.
# Los valores {{ ... }} los sustituye SSM con los parámetros del documento.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Manager = '{{ ManagerAddress }}'
$SecretArn = '{{ RegistrationSecretArn }}'
$Region = '{{ Region }}'
$Version = '{{ WazuhVersion }}'
$DefaultGroup = '{{ DefaultGroup }}'
$GroupTag = '{{ GroupTagKey }}'
$Conf = 'C:\Program Files (x86)\ossec-agent\ossec.conf'

# 1. Idempotencia.
$svc = Get-Service -Name WazuhSvc -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running' -and (Test-Path $Conf) -and
    (Select-String -Path $Conf -SimpleMatch "<address>$Manager</address>" -Quiet)) {
  Write-Output "wazuh-agent ya activo y apuntando a $Manager; sin cambios."
  exit 0
}

# 2. Grupo desde el tag (IMDSv2) con valor por defecto.
$Group = $DefaultGroup
$Name = $env:COMPUTERNAME
try {
  $token = Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' `
    -Headers @{ 'X-aws-ec2-metadata-token-ttl-seconds' = '60' } -TimeoutSec 2
  $headers = @{ 'X-aws-ec2-metadata-token' = $token }
  $iid = Invoke-RestMethod -Uri 'http://169.254.169.254/latest/meta-data/instance-id' -Headers $headers -TimeoutSec 2
  $Name = "$($env:COMPUTERNAME)-$iid"
  $tag = Invoke-RestMethod -Uri "http://169.254.169.254/latest/meta-data/tags/instance/$GroupTag" -Headers $headers -TimeoutSec 2
  if ($tag -match '^[A-Za-z0-9_.,-]{1,255}$') { $Group = $tag }
} catch { Write-Output 'Sin tag de grupo en IMDS; se usa el grupo por defecto.' }

# 3. AWS CLI v2 si falta.
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  $cliMsi = Join-Path $env:TEMP 'AWSCLIV2.msi'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://awscli.amazonaws.com/AWSCLIV2.msi' -OutFile $cliMsi
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$cliMsi`" /qn"
  $env:Path += ';C:\Program Files\Amazon\AWSCLIV2'
}

# 4. Contraseña de registro.
$RegPassword = (aws secretsmanager get-secret-value --region $Region --secret-id $SecretArn --query SecretString --output text)
if (-not $RegPassword) { throw 'No se pudo leer la contraseña de registro.' }

# 5. Instalación o reconfiguración.
if (Test-Path $Conf) {
  (Get-Content $Conf -Raw) -replace '<address>[^<]*</address>', "<address>$Manager</address>" | Set-Content $Conf -Encoding UTF8
} else {
  $msi = Join-Path $env:TEMP "wazuh-agent-$Version-1.msi"
  Invoke-WebRequest -UseBasicParsing -Uri "https://packages.wazuh.com/4.x/windows/wazuh-agent-$Version-1.msi" -OutFile $msi
  $msiArgs = "/i `"$msi`" /q WAZUH_MANAGER=`"$Manager`" WAZUH_REGISTRATION_PASSWORD=`"$RegPassword`" WAZUH_AGENT_GROUP=`"$Group`" WAZUH_AGENT_NAME=`"$Name`""
  $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList $msiArgs
  if ($p.ExitCode -ne 0) { throw "msiexec terminó con código $($p.ExitCode)" }
  Remove-Item $msi -Force
}

Set-Content -Path 'C:\Program Files (x86)\ossec-agent\authd.pass' -Value $RegPassword -NoNewline -Encoding ASCII
Remove-Variable RegPassword

Set-Service -Name WazuhSvc -StartupType Automatic
Restart-Service -Name WazuhSvc -Force
Write-Output "wazuh-agent $Version activo; manager=$Manager grupo=$Group nombre=$Name"
