[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string] $EnvFile = (Join-Path $PSScriptRoot '..\..\..\.env.local'),
    [string] $WazuhInstallArchivePath,
    [switch] $ConfirmRotatedSecrets,
    [switch] $OverwriteExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceToSecret = [ordered]@{
    'QAPAQ_MICROSOFT_ENTRA_CLIENT_SECRET' = 'qapaq-entra-client-secret'
    'OFFICE365_CLIENT_SECRET'            = 'office365-client-secret'
    'SOPHOS_CLIENT_ID'                   = 'sophos-client-id'
    'SOPHOS_SECRET'                      = 'sophos-client-secret'
    'CATO_SECRET'                        = 'cato-api-key'
    'TEAMS_WORKFLOW_URL'                 = 'qapaq-teams-workflow-url'
}

# Pin the importer to the isolated EUS2 target so an accidental parameter override
# cannot send demo credentials to another subscription or vault.
$targetSubscriptionId = 'aaf787f8-5964-4470-9eb6-89d15eacda61'
$targetTenantId = '45f2f938-dbe3-4a3e-8a54-930893f94ef8'
$targetResourceGroupName = 'rg-qapaqsecopsdemoeus-3a2405f3'
$targetVaultName = 'kv-qapaqsecopsd-3a2405f3'

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]] $Arguments)

    $result = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'Azure CLI preflight failed; verify the signed-in account and target resource.'
    }
    return ($result | ConvertFrom-Json)
}

function Test-PrivateIpAddress {
    param([Parameter(Mandatory)][string] $Address)

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref] $parsed)) { return $false }
    if ($parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        $bytes = $parsed.GetAddressBytes()
        return (($bytes[0] -band 0xFE) -eq 0xFC)
    }

    $octets = $parsed.GetAddressBytes()
    return (
        $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
    )
}

function Read-AllowlistedEnvValues {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The configured .env.local file does not exist.'
    }

    $values = [ordered]@{}
    $reader = [System.IO.StreamReader]::new((Resolve-Path -LiteralPath $Path).Path, $true)
    try {
        while (($line = $reader.ReadLine()) -ne $null) {
            $match = [regex]::Match($line, '^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$')
            if (-not $match.Success) { continue }

            $key = $match.Groups[1].Value
            if (-not $sourceToSecret.Contains($key)) { continue }
            if ($values.Contains($key)) {
                throw "Duplicate allowlisted environment key: $key"
            }

            $value = $match.Groups[2].Value.Trim()
            if ($value.Length -ge 2 -and
                (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
                 ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            } elseif ($value.StartsWith('"') -or $value.StartsWith("'")) {
                throw "Malformed quoted value for allowlisted environment key: $key"
            }

            if ([string]::IsNullOrWhiteSpace($value) -or $value.Contains("`r") -or $value.Contains("`n")) {
                throw "Empty or multiline value for allowlisted environment key: $key"
            }
            $values[$key] = $value
        }
    } finally {
        $reader.Dispose()
    }
    return $values
}

function Test-WazuhInstallArchive {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The Wazuh install archive path does not exist.'
    }
    $file = Get-Item -LiteralPath $Path -Force
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The Wazuh install archive must not be a symlink or reparse point.'
    }
    if ($file.Length -le 0 -or $file.Length -gt 18000) {
        throw 'The Wazuh install archive exceeds the runtime contract size limit.'
    }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw 'Python is required to validate the Wazuh install archive.' }
    $archivePath = (Resolve-Path -LiteralPath $Path).Path
    $validator = @'
import pathlib, sys, tarfile
path = pathlib.Path(sys.argv[1])
max_members = 32
max_member_bytes = 2 * 1024 * 1024
max_extracted_bytes = 4 * 1024 * 1024
passwords = "wazuh-install-files/wazuh-passwords.txt"
cert_prefix = "wazuh-install-files/wazuh-certificates/"
try:
    with tarfile.open(path, mode="r:") as archive:
        members = archive.getmembers()
        if len(members) > max_members:
            raise ValueError()
        names = set()
        extracted = 0
        has_passwords = False
        has_certificates = False
        for member in members:
            name = member.name
            normalized = pathlib.PurePosixPath(name).as_posix().rstrip("/")
            item = pathlib.PurePosixPath(name)
            if (not normalized or normalized == "." or item.is_absolute() or
                    ".." in item.parts or "\\" in name or "\x00" in name or
                    not (member.isfile() or member.isdir()) or normalized in names):
                raise ValueError()
            names.add(normalized)
            if member.size < 0 or member.size > max_member_bytes:
                raise ValueError()
            extracted += member.size
            if extracted > max_extracted_bytes:
                raise ValueError()
            has_passwords = has_passwords or (name == passwords and member.isfile())
            has_certificates = has_certificates or (name.startswith(cert_prefix) and member.isfile())
        if not has_passwords or not has_certificates:
            raise ValueError()
except Exception:
    sys.exit(1)
'@
    $null = & $python.Source -c $validator $archivePath 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'The Wazuh archive failed the offline credentials/certificates structure check.'
    }
}

$vaultId = "/subscriptions/$targetSubscriptionId/resourceGroups/$targetResourceGroupName/providers/Microsoft.KeyVault/vaults/$targetVaultName"
$vaultHost = "$targetVaultName.vault.azure.net"
$expectedSecretNames = @($sourceToSecret.Values) + @('wazuh-install-files.tar.b64')
$existingNames = @()
$values = [ordered]@{}
$accessToken = $null
$headers = $null

try {
    $account = Invoke-AzJson -Arguments @('account', 'show', '--subscription', $targetSubscriptionId, '--output', 'json', '--only-show-errors')
    if ($account.id -ne $targetSubscriptionId -or $account.tenantId -ne $targetTenantId) {
        throw 'Azure CLI is signed into a different subscription or tenant.'
    }

    $vault = Invoke-AzJson -Arguments @('keyvault', 'show', '--name', $targetVaultName, '--subscription', $targetSubscriptionId, '--output', 'json', '--only-show-errors')
    if ($vault.id.TrimEnd('/') -ne $vaultId) { throw 'The Key Vault resource ID does not match the EUS2 target.' }
    if ($vault.location -ne 'eastus2' -or $vault.properties.tenantId -ne $targetTenantId) {
        throw 'The Key Vault location or tenant does not match the EUS2 target.'
    }
    if ($vault.properties.publicNetworkAccess -ne 'Disabled' -or
        $vault.properties.networkAcls.defaultAction -ne 'Deny' -or
        $vault.properties.networkAcls.bypass -ne 'None') {
        throw 'Key Vault is not private with default-deny network ACLs; refusing to seed secrets.'
    }

    $addresses = @(Resolve-DnsName -Name $vaultHost -Type A -ErrorAction Stop |
        Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress -Unique)
    if ($addresses.Count -eq 0 -or @($addresses | Where-Object { -not (Test-PrivateIpAddress -Address $_) }).Count -gt 0) {
        throw 'Key Vault DNS does not resolve exclusively to a private endpoint.'
    }
    if (-not (Test-NetConnection -ComputerName $vaultHost -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        throw 'The private Key Vault endpoint is not reachable on TCP/443 from this machine.'
    }

    $listedNames = & az keyvault secret list --vault-name $targetVaultName --subscription $targetSubscriptionId --query '[].name' --output tsv --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Key Vault secret names; verify metadata/list permission.' }
    $existingNames = @($listedNames | Where-Object { $_ -and $_.Trim() })

    if (-not $WhatIfPreference -and -not $ConfirmRotatedSecrets) {
        throw 'Values shared in the earlier chat must be rotated first; pass -ConfirmRotatedSecrets only after replacing them with fresh credentials.'
    }

    if ($WazuhInstallArchivePath) {
        Test-WazuhInstallArchive -Path $WazuhInstallArchivePath
        $archiveBytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $WazuhInstallArchivePath).Path)
        if ($archiveBytes.Length -gt 18000) { throw 'The Wazuh archive exceeds its maximum decoded size.' }
        $values['__wazuh_archive__'] = [Convert]::ToBase64String($archiveBytes)
        [Array]::Clear($archiveBytes, 0, $archiveBytes.Length)
    }

    $envValues = Read-AllowlistedEnvValues -Path $EnvFile
    foreach ($sourceKey in $envValues.Keys) {
        $values[$sourceKey] = $envValues[$sourceKey]
    }
    $envValues.Clear()

    $writes = @()
    foreach ($sourceKey in $sourceToSecret.Keys) {
        if ($values.Contains($sourceKey)) {
            $writes += [pscustomobject]@{ Source = $sourceKey; Name = $sourceToSecret[$sourceKey] }
        }
    }
    if ($values.Contains('__wazuh_archive__')) {
        $writes += [pscustomobject]@{ Source = '__wazuh_archive__'; Name = 'wazuh-install-files.tar.b64' }
    }
    if ($writes.Count -eq 0) { throw 'No allowlisted runtime secrets were found; nothing was written.' }

    $alreadyPresent = @($writes | Where-Object { $existingNames -contains $_.Name })
    if ($alreadyPresent.Count -gt 0 -and -not $OverwriteExisting) {
        $names = ($alreadyPresent | ForEach-Object { $_.Name }) -join ', '
        throw "Refusing to create new versions of existing Key Vault secrets: $names. Use -OverwriteExisting only for an explicitly approved rotation."
    }
    Write-Output "Private Key Vault preflight passed. Secret names present in input: $($writes.Name -join ', ')."
    $missing = @($expectedSecretNames | Where-Object { $_ -notin $writes.Name })
    if ($missing.Count -gt 0) {
        Write-Output "Not provided by this import: $($missing -join ', '). Runtime profiles must remain disabled until required secrets exist."
    }

    if ($PSCmdlet.ShouldProcess($targetVaultName, "write $($writes.Count) allowlisted secrets over private endpoint")) {
        $tokenResult = & az account get-access-token --subscription $targetSubscriptionId --resource 'https://vault.azure.net' --query accessToken --output tsv --only-show-errors 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tokenResult)) {
            throw 'Could not acquire a Key Vault access token for the active Azure CLI identity.'
        }
        $accessToken = $tokenResult.Trim()
        $headers = @{ Authorization = "Bearer $accessToken" }

        foreach ($item in $writes) {
            $value = if ($item.Source -eq '__wazuh_archive__') { $values['__wazuh_archive__'] } else { $values[$item.Source] }
            $body = ConvertTo-Json -InputObject @{ value = $value } -Compress
            $uri = "https://$vaultHost/secrets/$([uri]::EscapeDataString($item.Name))?api-version=7.4"
            try {
                $null = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body -ContentType 'application/json' -ErrorAction Stop
                Write-Output "Stored Key Vault secret name: $($item.Name)"
            } catch {
                throw "Key Vault write failed for secret name '$($item.Name)'; verify Key Vault Secrets Officer access and private endpoint connectivity. No response body was displayed."
            } finally {
                $value = $null
                $body = $null
            }
        }
        $headers.Clear()
    } else {
        Write-Output 'WhatIf/confirmation prevented writes; no secret values were sent.'
    }
} finally {
    if ($null -ne $headers) {
        $headers.Clear()
    }
    $accessToken = $null
    $tokenResult = $null
    foreach ($key in @($values.Keys)) { $values[$key] = $null }
    $values.Clear()
}
