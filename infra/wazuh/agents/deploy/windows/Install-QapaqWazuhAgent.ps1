<#
.SYNOPSIS
  Instala o actualiza el agente Wazuh 4.14.8 de QAPAQ en Windows y lo inscribe en su grupo.

.DESCRIPTION
  Pensado para GPO (script de inicio de equipo), Intune (Win32 app como SYSTEM) o ejecución
  manual por un operador. Es idempotente: si el agente 4.14.8 ya está inscrito en el grupo
  correcto, solo verifica su estado.

  1. Verifica el MSI contra package-manifest.json: SHA-256 fijado y firma Authenticode de Wazuh.
  2. Resuelve el grupo QAPAQ: explícito o `auto` por OU o nombre (group-mapping.json).
  3. Instala con WAZUH_MANAGER, WAZUH_REGISTRATION_SERVER, WAZUH_AGENT_GROUP y WAZUH_AGENT_NAME.
     La contraseña de inscripción NUNCA va como propiedad del MSI (quedaría en argv y en el log).
  4. Endurece la configuración local: retira los canales eventchannel por defecto (los define el
     grupo), deshabilita Active Response y fija remote_commands=0.
  5. Si el agente no está inscrito, lee la contraseña de Key Vault, la escribe en authd.pass con
     ACL SYSTEM/Administradores, arranca el servicio, espera client.keys y borra authd.pass.
  6. Verifica servicio, conexión con el manager y deja un resumen JSON sin secretos.

  Códigos de salida: 0 correcto · 1 error de validación/instalación · 2 inscrito pero sin
  conexión con el manager dentro del plazo.

.EXAMPLE
  # Servidor Azure o Azure Arc con identidad administrada con permiso "Key Vault Secrets User".
  .\Install-QapaqWazuhAgent.ps1 -Group qapaq-srv-core -KeyVaultName kv-qapaq-eus2 -PackageDir \\srv\wazuh\4.14.8

.EXAMPLE
  # Estación por GPO/Intune: grupo por OU y contraseña entregada en un archivo protegido por la ola.
  .\Install-QapaqWazuhAgent.ps1 -Group auto -GroupMappingPath .\group-mapping.json -SecretSource ProtectedFile -ProtectedFilePath C:\ProgramData\QAPAQ\enroll.bin
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('auto', 'qapaq-dc', 'qapaq-srv-core', 'qapaq-srv-db', 'qapaq-srv-web',
        'qapaq-ws-sensitive', 'qapaq-ws-general', 'qapaq-laptop-remote')]
    [string]$Group,
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$Manager = 'app.jappi.net.pe',
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$RegistrationServer = 'app.jappi.net.pe',
    [string]$PackageDir = (Join-Path $PSScriptRoot '..\packages'),
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\package-manifest.json'),
    [string]$GroupMappingPath = (Join-Path $PSScriptRoot '..\..\group-mapping.json'),
    [ValidateSet('ManagedIdentity', 'AzPowerShell', 'ProtectedFile')]
    [string]$SecretSource = 'ManagedIdentity',
    [ValidatePattern('^[A-Za-z0-9-]{3,24}$')]
    [string]$KeyVaultName,
    [ValidatePattern('^[A-Za-z0-9-]{1,127}$')]
    [string]$SecretName = 'wazuh-agent-enrollment-password',
    [string]$ManagedIdentityClientId,
    [string]$ProtectedFilePath,
    [ValidateRange(30, 900)]
    [int]$EnrollmentTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$WazuhVersion = '4.14.8'
$InstallDir = Join-Path ${env:ProgramFiles(x86)} 'ossec-agent'
$ServiceName = 'WazuhSvc'
$StateDir = Join-Path $env:ProgramData 'QAPAQ\wazuh-agent'
$Groups = @('qapaq-dc', 'qapaq-srv-core', 'qapaq-srv-db', 'qapaq-srv-web', 'qapaq-ws-sensitive',
    'qapaq-ws-general', 'qapaq-laptop-remote')

function Write-Step([string]$Message) { Write-Host "[QAPAQ wazuh] $Message" }
function Fail([string]$Message) { throw "[QAPAQ wazuh] $Message" }

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail 'debe ejecutarse como administrador o SYSTEM.'
    }
}

function Get-VerifiedMsi {
    if (-not (Test-Path -LiteralPath $ManifestPath)) { Fail "no existe el manifiesto $ManifestPath." }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.wazuhVersion -ne $WazuhVersion) { Fail "el manifiesto fija $($manifest.wazuhVersion), no $WazuhVersion." }
    $artifact = $manifest.artifacts | Where-Object { $_.id -eq 'wazuh-agent-windows' }
    if (-not $artifact) { Fail 'el manifiesto no declara wazuh-agent-windows.' }
    if ($artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
        Fail 'el SHA-256 del MSI no está fijado (TO_BE_PROVIDED). Ejecutar Update-QapaqAgentManifest.ps1 y versionar el resultado.'
    }
    $msi = Join-Path $PackageDir $artifact.file
    if (-not (Test-Path -LiteralPath $msi)) { Fail "no se encontró $($artifact.file) en $PackageDir." }
    $actual = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $artifact.sha256) { Fail "SHA-256 del MSI no coincide con el manifiesto (obtenido $actual)." }
    $signature = Get-AuthenticodeSignature -LiteralPath $msi
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*$($artifact.verification.signerSubjectContains)*") {
        Fail "firma Authenticode inválida o de otro emisor: $($signature.Status)."
    }
    return $msi
}

function Get-ComputerFqdn {
    $domain = (Get-CimInstance -ClassName Win32_ComputerSystem).Domain
    $name = $env:COMPUTERNAME
    if ($domain -and $domain -ne 'WORKGROUP') { $name = "$name.$domain" }
    return $name.ToLowerInvariant()
}

function Resolve-QapaqGroup {
    if ($Group -ne 'auto') { return $Group }
    if (-not (Test-Path -LiteralPath $GroupMappingPath)) { Fail "Group=auto requiere $GroupMappingPath." }
    $mapping = Get-Content -LiteralPath $GroupMappingPath -Raw | ConvertFrom-Json
    if ((Get-Content -LiteralPath $GroupMappingPath -Raw) -match 'TO_BE_PROVIDED') {
        Fail 'group-mapping.json conserva valores TO_BE_PROVIDED; completar con OU y nombres reales.'
    }
    # OU del equipo según la última aplicación de GPO; no requiere RSAT ni consultar AD.
    $gpState = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\State\Machine'
    $distinguishedName = (Get-ItemProperty -Path $gpState -Name 'Distinguished-Name' -ErrorAction SilentlyContinue).'Distinguished-Name'
    foreach ($rule in $mapping.rules) {
        $subject = switch ($rule.match) {
            'ou' { $distinguishedName }
            'hostname' { $env:COMPUTERNAME }
            default { Fail "regla de mapeo con match desconocido: $($rule.match)." }
        }
        if ($subject -and $subject -match $rule.pattern) {
            if ($Groups -notcontains $rule.group) { Fail "el mapeo apunta a un grupo inexistente: $($rule.group)." }
            Write-Step "grupo $($rule.group) por $($rule.match) ($($rule.id))."
            return $rule.group
        }
    }
    if ($Groups -notcontains $mapping.defaultGroup) { Fail 'defaultGroup inválido en group-mapping.json.' }
    Write-Step "grupo por defecto $($mapping.defaultGroup)."
    return $mapping.defaultGroup
}

function Get-InstalledVersion {
    $keys = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    $entry = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Wazuh Agent' } |
        Select-Object -First 1
    if ($entry) { return [string]$entry.DisplayVersion }
    return $null
}

function Test-Enrolled {
    $keys = Join-Path $InstallDir 'client.keys'
    return (Test-Path -LiteralPath $keys) -and ((Get-Item -LiteralPath $keys).Length -gt 0)
}

function Install-Msi([string]$Msi, [string]$TargetGroup, [string]$AgentName) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $log = Join-Path $StateDir "msi-$(Get-Date -Format yyyyMMddTHHmmss).log"
    $arguments = @('/i', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$log`"",
        "WAZUH_MANAGER=$Manager", "WAZUH_REGISTRATION_SERVER=$RegistrationServer",
        "WAZUH_AGENT_GROUP=$TargetGroup", "WAZUH_AGENT_NAME=$AgentName")
    if ($PSCmdlet.ShouldProcess($env:COMPUTERNAME, "msiexec $($arguments -join ' ')")) {
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
        if ($process.ExitCode -notin 0, 3010) { Fail "msiexec terminó con código $($process.ExitCode); ver $log." }
    }
}

function Set-LocalHardening {
    $conf = Join-Path $InstallDir 'ossec.conf'
    if (-not (Test-Path -LiteralPath $conf)) { Fail 'no existe ossec.conf tras la instalación.' }
    Copy-Item -LiteralPath $conf -Destination "$conf.qapaq-$(Get-Date -Format yyyyMMddTHHmmss).bak"
    [xml]$xml = '<root>' + (Get-Content -LiteralPath $conf -Raw) + '</root>'
    $blocks = @($xml.root.SelectNodes('ossec_config'))
    if ($blocks.Count -eq 0) { Fail 'ossec.conf no contiene <ossec_config>.' }
    # Los canales los define el grupo QAPAQ; duplicarlos aquí duplicaría eventos y costo.
    foreach ($block in $blocks) {
        foreach ($node in @($block.SelectNodes('localfile[log_format="eventchannel"]'))) {
            [void]$block.RemoveChild($node)
        }
    }
    $config = $blocks[0]
    $ar = $config.SelectSingleNode('active-response')
    if (-not $ar) { $ar = $config.AppendChild($xml.CreateElement('active-response')) }
    $disabled = $ar.SelectSingleNode('disabled')
    if (-not $disabled) { $disabled = $ar.AppendChild($xml.CreateElement('disabled')) }
    $disabled.InnerText = 'yes'
    $enrollment = $config.SelectSingleNode('client/enrollment')
    if ($enrollment) {
        $pass = $enrollment.SelectSingleNode('authorization_pass_path')
        if (-not $pass) { $pass = $enrollment.AppendChild($xml.CreateElement('authorization_pass_path')) }
        $pass.InnerText = 'authd.pass'
    }
    $body = ($xml.root.ChildNodes | ForEach-Object { $_.OuterXml }) -join "`r`n"
    [IO.File]::WriteAllText($conf, $body, (New-Object Text.UTF8Encoding($false)))

    $internal = Join-Path $InstallDir 'local_internal_options.conf'
    $lines = @()
    if (Test-Path -LiteralPath $internal) {
        $lines = Get-Content -LiteralPath $internal | Where-Object { $_ -notmatch 'remote_commands' }
    }
    $lines += 'logcollector.remote_commands=0', 'wazuh_command.remote_commands=0', 'sca.remote_commands=0'
    Set-Content -LiteralPath $internal -Value $lines -Encoding ASCII
}

function Get-ManagedIdentityToken {
    $resource = 'https://vault.azure.net'
    if ($env:IDENTITY_ENDPOINT -and $env:IMDS_ENDPOINT) {
        # Azure Arc: desafío con un archivo .key que solo pueden leer administradores locales.
        $uri = "$($env:IDENTITY_ENDPOINT)?api-version=2020-06-01&resource=$resource"
        $challenge = $null
        try {
            Invoke-WebRequest -Uri $uri -Headers @{ Metadata = 'true' } -UseBasicParsing | Out-Null
        } catch {
            $headers = $_.Exception.Response.Headers
            # Windows PowerShell 5.1 (WebHeaderCollection) y PowerShell 7 (HttpResponseHeaders).
            if ($headers -is [System.Net.WebHeaderCollection]) { $challenge = $headers['WWW-Authenticate'] }
            elseif ($headers) { $challenge = [string]$headers.WwwAuthenticate }
        }
        if (-not $challenge -or $challenge -notmatch 'Basic realm=(.+)$') { Fail 'Azure Arc no presentó el desafío esperado.' }
        $keyPath = $Matches[1].Trim()
        $secret = Get-Content -LiteralPath $keyPath -Raw
        $response = Invoke-RestMethod -Uri $uri -Headers @{ Metadata = 'true'; Authorization = "Basic $secret" }
        $secret = $null
        return $response.access_token
    }
    $uri = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=$resource"
    if ($ManagedIdentityClientId) { $uri += "&client_id=$ManagedIdentityClientId" }
    return (Invoke-RestMethod -Uri $uri -Headers @{ Metadata = 'true' } -TimeoutSec 10).access_token
}

function Write-EnrollmentPassword([string]$Path) {
    $value = $null
    try {
        switch ($SecretSource) {
            'ManagedIdentity' {
                if (-not $KeyVaultName) { Fail 'ManagedIdentity requiere -KeyVaultName.' }
                $token = Get-ManagedIdentityToken
                $uri = "https://$KeyVaultName.vault.azure.net/secrets/$($SecretName)?api-version=7.4"
                $value = (Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token" }).value
                $token = $null
            }
            'AzPowerShell' {
                if (-not $KeyVaultName) { Fail 'AzPowerShell requiere -KeyVaultName.' }
                $secure = (Get-AzKeyVaultSecret -VaultName $KeyVaultName -Name $SecretName).SecretValue
                $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
            }
            'ProtectedFile' {
                if (-not $ProtectedFilePath -or -not (Test-Path -LiteralPath $ProtectedFilePath)) {
                    Fail 'ProtectedFile requiere -ProtectedFilePath existente.'
                }
                $acl = Get-Acl -LiteralPath $ProtectedFilePath
                $broad = $acl.Access | Where-Object {
                    $_.IdentityReference -match 'Everyone|Todos|Users|Usuarios|Authenticated Users' -and
                    $_.AccessControlType -eq 'Allow'
                }
                if ($broad) { Fail 'el archivo de inscripción es legible por usuarios no administradores.' }
                $value = (Get-Content -LiteralPath $ProtectedFilePath -Raw).Trim()
            }
        }
        if ([string]::IsNullOrWhiteSpace($value)) { Fail 'la contraseña de inscripción está vacía.' }
        # ACL explícita antes de escribir el contenido: solo SYSTEM y Administradores.
        New-Item -ItemType File -Force -Path $Path | Out-Null
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
        [IO.File]::WriteAllText($Path, $value, (New-Object Text.UTF8Encoding($false)))
    } finally {
        $value = $null
        [GC]::Collect()
    }
}

function Remove-EnrollmentPassword([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $length = (Get-Item -LiteralPath $Path).Length
        [IO.File]::WriteAllBytes($Path, (New-Object byte[] ([Math]::Max($length, 64))))
        Remove-Item -LiteralPath $Path -Force
    }
}

function Wait-Condition([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Get-AgentState {
    $state = Join-Path $InstallDir 'wazuh-agent.state'
    $result = @{}
    if (Test-Path -LiteralPath $state) {
        foreach ($line in Get-Content -LiteralPath $state) {
            if ($line -match "^(\w+)='?([^']*)'?$") { $result[$Matches[1]] = $Matches[2] }
        }
    }
    return $result
}

# ------------------------------------------------------------------ ejecución
Assert-Administrator
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$targetGroup = Resolve-QapaqGroup
$agentName = Get-ComputerFqdn
$installed = Get-InstalledVersion
Write-Step "equipo $agentName · grupo $targetGroup · versión instalada: $(if ($installed) { $installed } else { 'ninguna' })."

if ($installed -and [version]$installed -gt [version]$WazuhVersion) {
    Fail "hay un agente $installed más nuevo que el manager fijado ($WazuhVersion); no se degrada automáticamente."
}
if ($installed -ne $WazuhVersion) {
    $msi = Get-VerifiedMsi
    Install-Msi -Msi $msi -TargetGroup $targetGroup -AgentName $agentName
}
Set-LocalHardening

$passPath = Join-Path $InstallDir 'authd.pass'
try {
    if (-not (Test-Enrolled)) {
        Write-EnrollmentPassword -Path $passPath
        Restart-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ((Get-Service -Name $ServiceName).Status -ne 'Running') { Start-Service -Name $ServiceName }
        if (-not (Wait-Condition { Test-Enrolled } $EnrollmentTimeoutSeconds)) {
            Fail 'el agente no obtuvo client.keys; revisar ossec.log (firewall 1515, contraseña o grupo).'
        }
        Write-Step 'inscripción correcta.'
    } else {
        Restart-Service -Name $ServiceName
    }
} finally {
    Remove-EnrollmentPassword -Path $passPath
}

Set-Service -Name $ServiceName -StartupType Automatic
$connected = Wait-Condition { (Get-AgentState)['status'] -eq 'connected' } 120
$state = Get-AgentState
$summary = [ordered]@{
    timestampUtc  = (Get-Date).ToUniversalTime().ToString('o')
    agentName     = $agentName
    group         = $targetGroup
    version       = Get-InstalledVersion
    manager       = $Manager
    service       = [string](Get-Service -Name $ServiceName).Status
    enrolled      = Test-Enrolled
    status        = $state['status']
    lastKeepAlive = $state['last_keepalive']
}
$summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDir 'install-summary.json') -Encoding UTF8
$summary | ConvertTo-Json | Write-Host
if (-not $connected) {
    Write-Warning 'el agente está inscrito pero no reporta conexión: revisar 1514/TCP hacia el manager y siem_host.agent_public_cidrs.'
    exit 2
}
Write-Step 'agente conectado. Verificar inventario y SCA desde el manager con tools/verify_agent.py.'
exit 0
