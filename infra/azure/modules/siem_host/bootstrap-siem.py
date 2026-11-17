#!/usr/bin/python3
"""First-boot installer for a privately networked QAPAQ Wazuh host.

The only artifact input is a SHA-256-pinned private Blob. Runtime secret values
are read through the VM's user-assigned identity and are never printed or passed
in argv. The pinned release bundle owns package installation and service setup.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from indexer_read_proxy import IndexerProxyError, configure as configure_indexer_read_proxy


CONFIG_PATH = pathlib.Path("/etc/qapaq-siem/bootstrap.json")
DATA_DEVICE = pathlib.Path("/dev/disk/azure/scsi1/lun0")
DATA_ROOT = pathlib.Path("/srv/qapaq-siem")
CORE_ROOT = pathlib.Path("/opt/qapaq-core")
CORE_ENV_PATH = pathlib.Path("/etc/qapaq-core/core.env")
WAZUH_SECRET_DIR = pathlib.Path("/etc/qapaq-secrets")
RELEASE_ROOT = pathlib.Path("/opt/qapaq-siem/releases")
CORE_SECRET_REFERENCE_KEYS = {
    "QAPAQ_ENTRA_CLIENT_SECRET": "QAPAQ_ENTRA_CLIENT_SECRET_REF",
    "QAPAQ_POSTGRES_PASSWORD": "QAPAQ_POSTGRES_PASSWORD_REF",
    "QAPAQ_ENTITY_REF_KEY": "QAPAQ_ENTITY_REF_KEY_REF",
    "QAPAQ_TEAMS_WORKFLOW_URL": "QAPAQ_TEAMS_WORKFLOW_URL_REF",
    "QAPAQ_VAPID_PRIVATE_KEY": "QAPAQ_VAPID_PRIVATE_KEY_REF",
}
CORE_SECRET_PROVIDER_KEYS = {
    "QAPAQ_SECRET_PROVIDER_TYPE",
    "QAPAQ_SECRET_PROVIDER_TIMEOUT",
    "QAPAQ_SECRET_PROVIDER_ENDPOINT",
}
CORE_NON_SECRET_ENVIRONMENT_KEYS = {
    "QAPAQ_PROFILE",
    "QAPAQ_PROCESS_ROLE",
    "QAPAQ_API_HOST",
    "QAPAQ_API_PORT",
    "QAPAQ_POSTGRES_HOST",
    "QAPAQ_POSTGRES_PORT",
    "QAPAQ_POSTGRES_DATABASE",
    "QAPAQ_POSTGRES_USERNAME",
    "QAPAQ_POSTGRES_TLS",
    "QAPAQ_POSTGRES_CONNECTION_TIMEOUT",
    "QAPAQ_POSTGRES_STATEMENT_TIMEOUT",
    "QAPAQ_POSTGRES_POOL_MIN",
    "QAPAQ_POSTGRES_POOL_MAX",
    "QAPAQ_REDIS_HOST",
    "QAPAQ_REDIS_PORT",
    "QAPAQ_REDIS_USERNAME",
    "QAPAQ_REDIS_DATABASE",
    "QAPAQ_REDIS_TLS",
    "QAPAQ_REDIS_CONNECTION_TIMEOUT",
    "QAPAQ_REDIS_COMMAND_TIMEOUT",
    "QAPAQ_REDIS_RETRY_LIMIT",
    "QAPAQ_MINIO_ENDPOINT",
    "QAPAQ_MINIO_PORT",
    "QAPAQ_MINIO_REGION",
    "QAPAQ_MINIO_RAW_BUCKET",
    "QAPAQ_MINIO_TLS",
    "QAPAQ_MINIO_CONNECTION_TIMEOUT",
    "QAPAQ_MINIO_REQUEST_TIMEOUT",
    "QAPAQ_MINIO_RETRY_LIMIT",
    "QAPAQ_WAZUH_GATEWAY_BASE_URL",
    "QAPAQ_WAZUH_REQUEST_TIMEOUT",
    "QAPAQ_WAZUH_RETRY_LIMIT",
    "QAPAQ_WAZUH_PAGE_SIZE",
    "QAPAQ_WAZUH_MAX_PAGE_SIZE",
    "QAPAQ_WAZUH_DATASET",
    "QAPAQ_WAZUH_CURSOR_TTL",
    "QAPAQ_WAZUH_MAX_RESPONSE_BYTES",
    "QAPAQ_ACCESS_IDENTITY_MODE",
    "QAPAQ_ACCESS_ALLOWED_CIDRS",
    "QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS",
    "QAPAQ_ENTRA_TENANT_ID",
    "QAPAQ_ENTRA_CLIENT_ID",
    "QAPAQ_ENTRA_AUTHORITY",
    "QAPAQ_ENTRA_REDIRECT_URI",
    "QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS",
    "QAPAQ_ENTRA_SCOPES",
    "QAPAQ_MVP_ROLE_BINDING_OID",
    "QAPAQ_MVP_ROLE_BINDING_ROLE",
    "QAPAQ_MVP_ROLE_BINDING_EXPIRES_AT",
    "QAPAQ_CONSOLE_BASE_URL",
    "QAPAQ_DETECTION_PRIVILEGED_IDENTITIES",
    "QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES",
    "QAPAQ_DETECTION_CRITICAL_ASSETS",
    "QAPAQ_DETECTION_INTERNET_FACING_ASSETS",
    "QAPAQ_DETECTION_KNOWN_BENIGN_RULES",
    "QAPAQ_SOC_PERSISTENCE",
    "QAPAQ_INGESTION_SOURCE",
    "QAPAQ_INGESTION_SOURCE_ID",
    "QAPAQ_INGESTION_GATEWAY_SCOPE",
    "QAPAQ_INGESTION_INTERVAL",
    "QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES",
    "QAPAQ_ROLE_BINDINGS",
    "QAPAQ_GROUP_OWNER_OIDS",
    "QAPAQ_ADMIN_GROUP_IDS",
    "QAPAQ_ACCESS_APPROVER_OIDS",
    "QAPAQ_SECURITY_APPROVER_OIDS",
    "QAPAQ_DIRECTORY_SYNC",
    "QAPAQ_DIRECTORY_GROUP_ID",
    "QAPAQ_DIRECTORY_GROUP_NAME",
    "QAPAQ_DIRECTORY_SYNC_INTERVAL_MINUTES",
    "QAPAQ_ALERT_MAIL_SENDER",
}
EXPECTED = {
    "wazuh_version": "4.14.8",
    "osd_version": "2.19.6",
    "node_version": "24.21.0",
}
EXPECTED_DEBIAN_PACKAGES = {
    "wazuh-manager": ("managerDeb", "wazuh-manager", "prefix", "4.14.8-"),
    "wazuh-indexer": ("indexerDeb", "wazuh-indexer", "prefix", "4.14.8-"),
    "filebeat": ("filebeatDeb", "filebeat", "exact", "7.10.2-2"),
    "wazuh-dashboard": ("qapaqDashboardDeb", "wazuh-dashboard", "exact", "4.14.8-1qapaq1"),
}


def log(message: str) -> None:
    print(f"qapaq-siem-bootstrap: {message}", flush=True)


def fail(message: str) -> None:
    log(f"ERROR: {message}")
    raise SystemExit(1)


def validate_core_environment(
    core_environment: object,
    core_secret_names: dict,
    key_vault_uri: str,
) -> dict:
    if not isinstance(core_environment, dict):
        fail("core_environment debe ser un objeto")
    if not isinstance(core_secret_names, dict) or not isinstance(key_vault_uri, str):
        fail("la configuración del proveedor Key Vault no es válida")
    allowed_keys = (
        CORE_NON_SECRET_ENVIRONMENT_KEYS
        | CORE_SECRET_PROVIDER_KEYS
        | set(CORE_SECRET_REFERENCE_KEYS.values())
    )
    for key, value in core_environment.items():
        if not isinstance(key, str) or key not in allowed_keys or not isinstance(value, str):
            fail("core_environment solo admite variables no secretas allowlisted y referencias Key Vault")
        if any(character in value for character in ("\n", "\r", "\x00")):
            fail("configuración de entorno core inválida")
        if key in CORE_SECRET_REFERENCE_KEYS.values():
            secret_key = next(
                name for name, reference_key in CORE_SECRET_REFERENCE_KEYS.items()
                if reference_key == key
            )
            expected_name = core_secret_names.get(secret_key)
            if expected_name is None or value != f"secret://keyvault/{expected_name}":
                fail("la referencia Core no coincide con el nombre autorizado de Key Vault")
        elif key in CORE_SECRET_PROVIDER_KEYS:
            expected_value = {
                "QAPAQ_SECRET_PROVIDER_TYPE": "azure-key-vault",
                "QAPAQ_SECRET_PROVIDER_TIMEOUT": "5s",
                "QAPAQ_SECRET_PROVIDER_ENDPOINT": key_vault_uri.rstrip("/"),
            }[key]
            if value != expected_value:
                fail("la configuración del proveedor Azure debe coincidir con la identidad y el vault del host")
    return core_environment


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
    )
    if result.returncode != 0:
        # Never echo command output: installers and package tools can include secrets.
        fail(f"comando requerido falló: {pathlib.Path(args[0]).name}")
    return result.stdout.strip() if capture else ""


def load_config() -> dict:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("no se pudo leer la configuración no secreta de bootstrap")
    if config.get("expected") != EXPECTED:
        fail("las versiones esperadas no coinciden con Wazuh QAPAQ 4.14.8 / OSD 2.19.6 / Node 24.21.0")
    if not re.fullmatch(r"[0-9a-f]{64}", config.get("artifact_sha256", "")):
        fail("el SHA-256 del bundle no es válido")
    url = config.get("artifact_url", "")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".blob.core.windows.net") or parsed.query:
        fail("el bundle debe estar en Blob privado con URL HTTPS sin SAS")
    if not config.get("identity_client_id"):
        fail("falta client ID de la identidad administrada")
    office365 = config.get("office365")
    if not isinstance(office365, dict):
        fail("falta configuración no secreta de Microsoft 365")
    guid_pattern = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    if not guid_pattern.fullmatch(office365.get("tenant_id", "")) or not guid_pattern.fullmatch(office365.get("client_id", "")):
        fail("tenant/client ID de Microsoft 365 no son GUID válidos")
    if office365.get("api_type") not in ("commercial", "gcc", "gcc-high") or type(office365.get("enable_dlp")) is not bool:
        fail("la configuración de API Microsoft 365 no es válida")
    secret_names = config.get("wazuh_secret_names", {})
    if not isinstance(secret_names, dict):
        fail("la configuración de secretos Wazuh debe ser un mapa de referencias Key Vault")
    for required_secret in ("office365-client-secret", "wazuh-install-files.tar.b64"):
        if required_secret not in secret_names:
            fail(f"falta la referencia Key Vault {required_secret}")
    core_secret_names = config.get("core_secret_names", {})
    if not isinstance(core_secret_names, dict):
        fail("la configuración de secretos Core debe ser un mapa de nombres Key Vault")
    if "QAPAQ_ENTRA_CLIENT_SECRET" not in core_secret_names:
        fail("falta la referencia Key Vault del client secret Entra de QAPAQ")
    for key, name in core_secret_names.items():
        if (
            not isinstance(key, str)
            or not isinstance(name, str)
            or key not in CORE_SECRET_REFERENCE_KEYS
            or not re.fullmatch(r"[A-Za-z0-9-]{1,127}", name)
        ):
            fail("core_secret_names contiene una clave o un nombre Key Vault no admitido")
    core_environment = validate_core_environment(
        config.get("core_environment", {}),
        core_secret_names,
        config.get("key_vault_uri", ""),
    )
    if core_environment.get("QAPAQ_SOC_PERSISTENCE") == "postgres":
        required_postgres_secrets = {"QAPAQ_POSTGRES_PASSWORD", "QAPAQ_ENTITY_REF_KEY"}
        if not required_postgres_secrets.issubset(core_secret_names):
            fail("persistencia PostgreSQL requiere referencias Key Vault para la contraseña de aplicación y la clave de referencias de entidad")
    provider_config = config.get("provider_ingestion", {})
    provider_keys = {"sophos_enabled", "sophos_tenant_id", "sophos_data_region", "cato_enabled", "cato_account_id"}
    if not isinstance(provider_config, dict) or set(provider_config) - provider_keys:
        fail("la configuración de conectores Sophos/Cato contiene campos no admitidos")
    if any(not isinstance(key, str) or not isinstance(value, str) or "\n" in value or "\r" in value for key, value in provider_config.items()):
        fail("la configuración de conectores Sophos/Cato debe ser texto no secreto de una sola línea")
    if provider_config.get("sophos_enabled", "false") not in ("true", "false") or provider_config.get("cato_enabled", "false") not in ("true", "false"):
        fail("los flags Sophos/Cato deben ser true o false")
    if provider_config.get("sophos_enabled") == "true":
        if not guid_pattern.fullmatch(provider_config.get("sophos_tenant_id", "")) or not re.fullmatch(r"[a-z0-9-]{2,32}", provider_config.get("sophos_data_region", "")):
            fail("Sophos requiere un tenant GUID y data region válidos")
        if not {"sophos-client-id", "sophos-client-secret"}.issubset(secret_names):
            fail("Sophos requiere referencias Key Vault de client ID y client secret")
    if provider_config.get("cato_enabled") == "true":
        if not re.fullmatch(r"[0-9]{1,20}", provider_config.get("cato_account_id", "")) or "cato-api-key" not in secret_names:
            fail("Cato requiere account ID y referencia Key Vault de API key")
    if type(config.get("data_disk_size_gb")) is not int or config["data_disk_size_gb"] < 128:
        fail("el tamaño del disco de datos no coincide con el contrato mínimo del SIEM")
    indexer_proxy = config.get("indexer_read_proxy")
    if indexer_proxy is not None:
        if not isinstance(indexer_proxy, dict) or set(indexer_proxy) != {
            "private_ip_address", "reader_secret_name", "proxy_ca_secret_name"
        }:
            fail("la configuración del proxy read-only de Indexer no es válida")
        private_ip = indexer_proxy.get("private_ip_address", "")
        try:
            if str(ipaddress.IPv4Address(private_ip)) != private_ip or not ipaddress.IPv4Address(private_ip).is_private:
                fail("el proxy Indexer requiere la IP privada estática del SIEM")
        except ipaddress.AddressValueError:
            fail("el proxy Indexer requiere una IP privada IPv4 válida")
        for name in (indexer_proxy.get("reader_secret_name"), indexer_proxy.get("proxy_ca_secret_name")):
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,127}", name):
                fail("el proxy Indexer requiere nombres de secretos Key Vault válidos")
        if indexer_proxy["reader_secret_name"] == indexer_proxy["proxy_ca_secret_name"]:
            fail("las credenciales y la CA del proxy Indexer requieren secretos Key Vault distintos")
    return config


def ensure_ext4_or_format(device: str, expected_size_bytes: int) -> None:
    fs_probe = subprocess.run(
        ["blkid", "-p", "-o", "export", device], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if fs_probe.returncode == 0:
        fs_fields = dict(line.split("=", 1) for line in fs_probe.stdout.splitlines() if "=" in line)
        if fs_fields.get("TYPE") != "ext4":
            fail("LUN 0 contiene un formato reconocido distinto de ext4; no se modificó")
        return
    if fs_probe.returncode != 2 or fs_probe.stdout.strip():
        fail("blkid no pudo identificar LUN 0 de forma segura; no se modificó")

    signatures = subprocess.run(
        ["wipefs", "-n", device], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    if signatures.returncode != 0 or signatures.stdout.strip():
        fail("LUN 0 contiene firmas desconocidas; se detuvo sin formatearlo")
    zero_scan = subprocess.run(
        ["cmp", "--silent", f"--bytes={expected_size_bytes}", device, "/dev/zero"],
        check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if zero_scan.returncode == 1:
        fail("LUN 0 contiene datos aunque no tenga firmas; se detuvo sin formatearlo")
    if zero_scan.returncode != 0:
        fail("no se pudo confirmar que LUN 0 esté completamente vacío")
    log("LUN 0 verificado como disco Azure esperado, sin firmas y completamente en cero; se crea ext4")
    run("mkfs.ext4", "-m", "1", "-L", "qapaq-siem-data", device)
    fs_probe = subprocess.run(
        ["blkid", "-p", "-o", "export", device], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if fs_probe.returncode != 0 or "TYPE=ext4" not in fs_probe.stdout.splitlines():
        fail("no se pudo confirmar ext4 después de inicializar LUN 0")


def mount_data_disk(expected_size_gb: int) -> None:
    for _ in range(180):
        if DATA_DEVICE.exists():
            break
        time.sleep(2)
    else:
        fail("el disco de datos LUN 0 no apareció; no se instaló el SIEM")

    if not DATA_DEVICE.is_symlink():
        fail("LUN 0 no es el enlace de dispositivo Azure esperado; no se modificó ningún disco")
    device = os.path.realpath(str(DATA_DEVICE))
    try:
        device_stat = os.stat(device)
    except OSError:
        fail("no se pudo inspeccionar el dispositivo Azure LUN 0")
    if not stat.S_ISBLK(device_stat.st_mode):
        fail("LUN 0 no resuelve a un dispositivo de bloques; no se modificó ningún disco")

    layout = subprocess.run(
        ["lsblk", "--json", "--paths", "--output", "NAME,TYPE,PKNAME,FSTYPE,UUID,PARTUUID,PTTYPE,MOUNTPOINTS", device],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if layout.returncode != 0:
        fail("no se pudo verificar la identidad y estructura de LUN 0")
    try:
        devices = json.loads(layout.stdout).get("blockdevices", [])
    except (json.JSONDecodeError, AttributeError):
        fail("lsblk devolvió una estructura inválida para LUN 0")
    if len(devices) != 1:
        fail("LUN 0 no identifica un único disco de datos")
    disk = devices[0]
    if (
        disk.get("type") != "disk"
        or os.path.realpath(disk.get("name", "")) != device
        or disk.get("pkname")
        or disk.get("children")
        or disk.get("pttype")
        or disk.get("fstype") not in (None, "ext4")
        or disk.get("mountpoints") not in (None, [], [None], [str(DATA_ROOT)])
    ):
        fail("LUN 0 no es un disco vacío sin particiones ni montajes")
    try:
        expected_size_bytes = int(expected_size_gb) * 1024**3
    except (TypeError, ValueError):
        fail("el tamaño esperado del disco LUN 0 no es válido")
    actual_size = subprocess.run(
        ["blockdev", "--getsize64", device], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if actual_size.returncode != 0 or actual_size.stdout.strip() != str(expected_size_bytes):
        fail("el tamaño de LUN 0 no coincide con el disco de datos declarado")

    ensure_ext4_or_format(device, expected_size_bytes)
    fs_type = subprocess.run(
        ["blkid", "-p", "-s", "TYPE", "-o", "value", device],
        check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if fs_type.returncode != 0 or fs_type.stdout.strip() != "ext4":
        fail("el disco durable debe contener ext4; no se modifica un formato distinto")

    fs_uuid = run("blkid", "-s", "UUID", "-o", "value", device, capture=True)
    if not fs_uuid:
        fail("no se pudo identificar el UUID del disco durable")

    DATA_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    fstab = pathlib.Path("/etc/fstab")
    lines = fstab.read_text(encoding="utf-8").splitlines()
    root_entry = f"UUID={fs_uuid} {DATA_ROOT} ext4 defaults,nofail,noatime 0 2"
    if not any(line.split()[:2] == [f"UUID={fs_uuid}", str(DATA_ROOT)] for line in lines if line.strip() and not line.lstrip().startswith("#")):
        with fstab.open("a", encoding="utf-8") as stream:
            stream.write(root_entry + "\n")
    run("mount", str(DATA_ROOT))

    # Bind the state-bearing Wazuh paths before package installation. A retry
    # must not hide pre-existing host data behind an empty mount.
    data_device_source = os.path.realpath(run("findmnt", "-n", "-o", "SOURCE", "--target", str(DATA_ROOT), capture=True).split("[", 1)[0])
    bind_paths = {
        DATA_ROOT / "manager": pathlib.Path("/var/ossec"),
        DATA_ROOT / "indexer": pathlib.Path("/var/lib/wazuh-indexer"),
        DATA_ROOT / "dashboard": pathlib.Path("/var/lib/wazuh-dashboard"),
    }
    for source, target in bind_paths.items():
        source.mkdir(mode=0o750, parents=True, exist_ok=True)
        target.mkdir(mode=0o750, parents=True, exist_ok=True)
        mounted = subprocess.run(
            ["mountpoint", "-q", str(target)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ).returncode == 0
        if mounted:
            mounted_source = run("findmnt", "-n", "-o", "SOURCE", "--target", str(target), capture=True)
            mounted_device = os.path.realpath(mounted_source.split("[", 1)[0])
            if mounted_device != data_device_source:
                fail(f"el punto de montaje {target} no pertenece al disco durable; no se sobrescribe")
            continue
        if any(target.iterdir()):
            fail(f"{target} ya contiene datos fuera del disco persistente; se detuvo para evitar ocultarlos")
        bind_entry = f"{source} {target} none bind,nofail 0 0"
        if not any(line.split()[:2] == [str(source), str(target)] for line in lines if line.strip() and not line.lstrip().startswith("#")):
            with fstab.open("a", encoding="utf-8") as stream:
                stream.write(bind_entry + "\n")
        run("mount", str(target))
    log("disco persistente montado para Manager, Indexer y Dashboard")


def get_token(identity_client_id: str, resource: str) -> str:
    query = urllib.parse.urlencode(
        {"api-version": "2018-02-01", "resource": resource, "client_id": identity_client_id}
    )
    request = urllib.request.Request(
        f"http://169.254.169.254/metadata/identity/oauth2/token?{query}", headers={"Metadata": "true"}
    )
    for attempt in range(30):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.load(response)
            return body["access_token"]
        except (OSError, KeyError, json.JSONDecodeError, urllib.error.URLError):
            if attempt == 29:
                break
            time.sleep(min(5 + attempt, 30))
    fail(f"no se pudo obtener token de identidad para {resource}")
    raise AssertionError("unreachable")


def key_vault_get(config: dict, token: str, secret_name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,127}", secret_name):
        fail("referencia de secreto Key Vault con nombre inválido")
    url = f"{config['key_vault_uri']}/secrets/{urllib.parse.quote(secret_name)}?api-version=7.4"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(30):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                secret = json.load(response).get("value")
            if not isinstance(secret, str) or "\n" in secret or "\r" in secret or "\x00" in secret:
                fail(f"el secreto {secret_name} no es una cadena de una línea")
            return secret
        except urllib.error.HTTPError as error:
            # Role assignment propagation can take time; other errors remain redacted.
            if error.code not in (403, 429, 500, 502, 503, 504) or attempt == 29:
                fail(f"Key Vault rechazó la lectura del secreto {secret_name} (HTTP {error.code})")
        except (OSError, KeyError, json.JSONDecodeError, urllib.error.URLError):
            if attempt == 29:
                fail(f"no se pudo leer el secreto {secret_name} desde Key Vault")
        time.sleep(min(5 + attempt, 30))
    fail(f"no se pudo leer el secreto {secret_name} desde Key Vault")
    raise AssertionError("unreachable")


def key_vault_get_optional(config: dict, token: str, secret_name: str) -> str | None:
    """Read an already-created secret without echoing its value; 404 is a safe absence."""
    if not re.fullmatch(r"[A-Za-z0-9-]{1,127}", secret_name):
        fail("referencia de secreto Key Vault con nombre inválido")
    url = f"{config['key_vault_uri']}/secrets/{urllib.parse.quote(secret_name)}?api-version=7.4"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(30):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                value = json.load(response).get("value")
            if not isinstance(value, str) or "\x00" in value:
                fail(f"el secreto {secret_name} no es texto válido")
            return value
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code not in (403, 429, 500, 502, 503, 504) or attempt == 29:
                fail(f"Key Vault rechazó la lectura del secreto {secret_name} (HTTP {error.code})")
        except (OSError, KeyError, json.JSONDecodeError, urllib.error.URLError):
            if attempt == 29:
                fail(f"no se pudo leer el secreto {secret_name} desde Key Vault")
        time.sleep(min(5 + attempt, 30))
    fail(f"no se pudo leer el secreto {secret_name} desde Key Vault")
    raise AssertionError("unreachable")


def key_vault_set(config: dict, token: str, secret_name: str, value: str) -> None:
    """Create a new Key Vault secret version without putting the value in argv/logs."""
    if not re.fullmatch(r"[A-Za-z0-9-]{1,127}", secret_name):
        fail("referencia de secreto Key Vault con nombre inválido")
    if not isinstance(value, str) or "\x00" in value:
        fail("el valor generado para Key Vault no es texto válido")
    url = f"{config['key_vault_uri']}/secrets/{urllib.parse.quote(secret_name)}?api-version=7.4"
    body = json.dumps({"value": value, "contentType": "text/plain"}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
    )
    for attempt in range(30):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status not in (200, 201):
                    fail(f"Key Vault no guardó la referencia del proxy (HTTP {response.status})")
                response.read(4096)
            return
        except urllib.error.HTTPError as error:
            if error.code not in (403, 429, 500, 502, 503, 504) or attempt == 29:
                fail(f"Key Vault rechazó la escritura de la referencia del proxy (HTTP {error.code})")
        except (OSError, urllib.error.URLError):
            if attempt == 29:
                fail("no se pudo guardar la referencia generada en Key Vault")
        time.sleep(min(5 + attempt, 30))


def configure_indexer_proxy(config: dict) -> None:
    proxy = config.get("indexer_read_proxy")
    if proxy is None:
        return
    token = get_token(config["identity_client_id"], "https://vault.azure.net")
    try:
        reader_secret = key_vault_get_optional(config, token, proxy["reader_secret_name"])
        proxy_ca_secret = key_vault_get_optional(config, token, proxy["proxy_ca_secret_name"])
        configure_indexer_read_proxy(
            proxy,
            reader_secret,
            proxy_ca_secret,
            lambda name, value: key_vault_set(config, token, name, value),
            log,
        )
    except IndexerProxyError as error:
        fail(str(error))
    except Exception:
        # The VM extension log is durable; never dump a traceback from a routine
        # bootstrap failure that could include request/configuration details.
        fail("falló la configuración del proxy Indexer; se omitieron detalles internos")
    finally:
        del token


def systemd_quote(value: str) -> str:
    if "\n" in value or "\r" in value or "\x00" in value:
        fail("una variable de entorno contiene saltos de línea")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def materialize_secrets(config: dict) -> None:
    core_secret_names = config.get("core_secret_names", {})
    if not isinstance(core_secret_names, dict):
        fail("la configuración de secretos Core debe ser un mapa de nombres Key Vault")
    environment = validate_core_environment(
        config.get("core_environment", {}),
        core_secret_names,
        config.get("key_vault_uri", ""),
    )
    wazuh_secret_names = config.get("wazuh_secret_names", {})
    for key, name in core_secret_names.items():
        if (
            not isinstance(key, str)
            or not isinstance(name, str)
            or key not in CORE_SECRET_REFERENCE_KEYS
            or not re.fullmatch(r"[A-Za-z0-9-]{1,127}", name)
        ):
            fail("core_secret_names contiene una clave o un nombre Key Vault no admitido")
    for filename, name in wazuh_secret_names.items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", filename):
            fail("nombre de archivo de secreto Wazuh inválido")

    wazuh_secret_values: dict[str, str] = {}
    if wazuh_secret_names:
        kv_token = get_token(config["identity_client_id"], "https://vault.azure.net")
        wazuh_secret_values = {
            name: key_vault_get(config, kv_token, name)
            for name in sorted(set(wazuh_secret_names.values()))
        }
        del kv_token

    merged_env = dict(environment)
    for key, name in core_secret_names.items():
        reference_key = CORE_SECRET_REFERENCE_KEYS[key]
        reference_value = f"secret://keyvault/{name}"
        if reference_key in merged_env and merged_env[reference_key] != reference_value:
            fail("la referencia Core no coincide con el nombre autorizado de Key Vault")
        merged_env[reference_key] = reference_value
    if core_secret_names:
        provider_defaults = {
            "QAPAQ_SECRET_PROVIDER_TYPE": "azure-key-vault",
            "QAPAQ_SECRET_PROVIDER_TIMEOUT": "5s",
            "QAPAQ_SECRET_PROVIDER_ENDPOINT": config["key_vault_uri"].rstrip("/"),
        }
        for key, value in provider_defaults.items():
            if key in merged_env and merged_env[key] != value:
                fail("la configuración del proveedor Azure debe coincidir con la identidad y el vault del host")
            merged_env[key] = value
        if "AZURE_CLIENT_ID" in merged_env and merged_env["AZURE_CLIENT_ID"] != config["identity_client_id"]:
            fail("AZURE_CLIENT_ID debe corresponder a la identidad administrada del SIEM")
        merged_env["AZURE_CLIENT_ID"] = config["identity_client_id"]
    for key, value in merged_env.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) or not isinstance(value, str):
            fail("configuración de entorno core inválida")
        if "\n" in value or "\r" in value or "\x00" in value:
            fail("configuración de entorno core inválida")
        if key in CORE_SECRET_REFERENCE_KEYS.values():
            secret_key = next(
                name for name, reference_key in CORE_SECRET_REFERENCE_KEYS.items()
                if reference_key == key
            )
            expected_name = core_secret_names.get(secret_key)
            if expected_name is None or value != f"secret://keyvault/{expected_name}":
                fail("la referencia Core no coincide con el nombre autorizado de Key Vault")
        elif key in CORE_SECRET_PROVIDER_KEYS:
            expected_value = {
                "QAPAQ_SECRET_PROVIDER_TYPE": "azure-key-vault",
                "QAPAQ_SECRET_PROVIDER_TIMEOUT": "5s",
                "QAPAQ_SECRET_PROVIDER_ENDPOINT": config["key_vault_uri"].rstrip("/"),
            }[key]
            if value != expected_value:
                fail("la configuración del proveedor Azure debe coincidir con la identidad y el vault del host")
        elif re.search(r"(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|CONNECTION_STRING)", key):
            fail("core_environment no admite valores secretos ni credenciales")
    CORE_ENV_PATH.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with CORE_ENV_PATH.open("w", encoding="utf-8") as stream:
        for key in sorted(merged_env):
            stream.write(f"{key}={systemd_quote(merged_env[key])}\n")
    # systemd lee el EnvironmentFile como root antes de bajar a qapaq-core, y
    # apply-core-azure.sh exige que no tenga permisos de grupo ni de otros.
    os.chmod(CORE_ENV_PATH, 0o600)
    try:
        qapaq_gid = pwd.getpwnam("qapaq-core").pw_gid
    except KeyError:
        run("useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "qapaq-core")
        qapaq_gid = pwd.getpwnam("qapaq-core").pw_gid
    os.chown(CORE_ENV_PATH.parent, 0, qapaq_gid)
    os.chown(CORE_ENV_PATH, 0, qapaq_gid)

    WAZUH_SECRET_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(WAZUH_SECRET_DIR, 0o700)
    for filename, secret_name in wazuh_secret_names.items():
        target = WAZUH_SECRET_DIR / filename
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(wazuh_secret_values[secret_name])
        os.chmod(target, 0o600)
    del wazuh_secret_values
    log(f"referencias Core configuradas y secretos Wazuh instalados sin imprimir valores: {len(core_secret_names) + len(wazuh_secret_names)}")


def fetch_bundle(config: dict, destination: pathlib.Path) -> None:
    token = get_token(config["identity_client_id"], "https://storage.azure.com/")
    request = urllib.request.Request(
        config["artifact_url"],
        headers={"Authorization": f"Bearer {token}", "x-ms-version": "2023-11-03"},
    )
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as artifact:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                artifact.write(chunk)
    except (OSError, urllib.error.URLError):
        fail("no se pudo descargar el bundle Blob con la identidad administrada")
    finally:
        del token
    if digest.hexdigest() != config["artifact_sha256"]:
        destination.unlink(missing_ok=True)
        fail("el SHA-256 del bundle no coincide con el pin configurado")


def validate_debian_artifacts(content: pathlib.Path, manifest: dict) -> None:
    """Verify package metadata before install.sh can execute any package installer."""
    artifacts = manifest["artifacts"]
    versions = manifest["debianPackages"]
    for manifest_name, (
        artifact_key,
        expected_name,
        version_mode,
        required_version,
    ) in EXPECTED_DEBIAN_PACKAGES.items():
        package_path = content.joinpath(*pathlib.PurePosixPath(artifacts[artifact_key]).parts)
        actual_name = run("dpkg-deb", "--field", str(package_path), "Package", capture=True)
        actual_version = run("dpkg-deb", "--field", str(package_path), "Version", capture=True)
        actual_architecture = run("dpkg-deb", "--field", str(package_path), "Architecture", capture=True)
        if actual_name != expected_name:
            fail(f"el paquete {manifest_name} no tiene el nombre Debian esperado")
        if actual_version != versions[manifest_name]:
            fail(f"la versión Debian de {manifest_name} no coincide con el manifiesto")
        version_matches = (
            actual_version.startswith(required_version)
            if version_mode == "prefix"
            else actual_version == required_version
        )
        if not version_matches:
            fail(f"la versión Debian de {manifest_name} no corresponde al contrato QAPAQ")
        if actual_architecture != "amd64":
            fail(f"el paquete {manifest_name} no es amd64")


def validate_runtime_health() -> None:
    """Require all runtime services declared by the SIEM host contract to be active."""
    for service in (
        "wazuh-indexer",
        "wazuh-manager",
        "wazuh-dashboard",
        "filebeat",
        "qapaq-core-api",
        "qapaq-core-worker",
    ):
        run("systemctl", "is-active", "--quiet", service)
    for attempt in range(60):
        try:
            with urllib.request.urlopen("http://127.0.0.1:3000/health/ready", timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            if attempt == 59:
                fail("qapaq-core no alcanzó /health/ready")
        time.sleep(2)
    fail("qapaq-core no alcanzó /health/ready")


def extract_and_verify(bundle: pathlib.Path, config: dict) -> pathlib.Path:
    RELEASE_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    release = RELEASE_ROOT / config["artifact_sha256"]
    already_extracted = release.exists()
    staging = None if already_extracted else pathlib.Path(tempfile.mkdtemp(prefix=".qapaq-siem-release-", dir=RELEASE_ROOT))
    try:
        if already_extracted:
            content = release
        else:
            assert staging is not None
            with tarfile.open(bundle, "r:gz") as archive:
                archive.extractall(staging, filter="data")
            top_dirs = [path for path in staging.iterdir() if path.is_dir()]
            if len(top_dirs) != 1:
                fail("el bundle debe contener un único directorio raíz")
            content = top_dirs[0]
        manifest_path = content / "manifest.json"
        installer = content / "install.sh"
        if not manifest_path.is_file() or not installer.is_file():
            fail("el bundle debe incluir manifest.json e install.sh")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            fail("manifest.json del bundle no es válido")
        components = manifest.get("components", {})
        expected_components = {
            "wazuhManager": "4.14.8",
            "wazuhIndexer": "4.14.8",
            "wazuhFilebeat": "4.14.8",
            "wazuhDashboard": "4.14.8",
            "openSearchDashboards": "2.19.6",
            "qapaqCoreNode": "24.21.0",
        }
        if manifest.get("schemaVersion") != 1 or any(components.get(key) != value for key, value in expected_components.items()):
            fail("el manifiesto no fija Wazuh 4.14.8, OSD 2.19.6 y Node 24.21.0")
        if manifest.get("qapaqDashboardPackage") != "4.14.8-1qapaq1" or not re.fullmatch(
            r"[0-9a-f]{12}", manifest.get("qapaqCoreSourceCommit", "")
        ):
            fail("el manifiesto no fija el paquete de marca QAPAQ y la revisión del core")
        package_versions = manifest.get("debianPackages", {})
        if not isinstance(package_versions, dict) or any(
            not isinstance(package_versions.get(name), str) or not package_versions[name]
            for name in ("wazuh-manager", "wazuh-indexer", "filebeat", "wazuh-dashboard")
        ):
            fail("el manifiesto no fija las versiones exactas de los paquetes Debian")
        for name in ("wazuh-manager", "wazuh-indexer"):
            if not package_versions[name].startswith("4.14.8-"):
                fail(f"la versión de paquete {name} no corresponde a Wazuh 4.14.8")
        if package_versions["wazuh-dashboard"] != "4.14.8-1qapaq1":
            fail("el paquete instalado del Dashboard no corresponde al build QAPAQ 4.14.8")
        if package_versions["filebeat"] != "7.10.2-2":
            fail("la versión Debian de Filebeat no corresponde al pin 7.10.2-2")
        artifact_paths = manifest.get("artifacts", {})
        required_artifacts = {"managerDeb", "indexerDeb", "filebeatDeb", "qapaqDashboardDeb", "qapaqCoreArchive"}
        if not isinstance(artifact_paths, dict) or not required_artifacts.issubset(artifact_paths):
            fail("el bundle no declara paquetes de manager/indexer/Filebeat y build QAPAQ/core")
        file_hashes = manifest.get("files")
        if not isinstance(file_hashes, dict) or "install.sh" not in file_hashes:
            fail("el manifiesto debe fijar SHA-256 para install.sh y todos los artefactos")
        for relative_name, expected_hash in file_hashes.items():
            relative = pathlib.PurePosixPath(relative_name)
            if relative.is_absolute() or ".." in relative.parts or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
                fail("el manifiesto contiene una ruta o hash inválido")
            file_path = content.joinpath(*relative.parts)
            if not file_path.is_file():
                fail(f"falta el artefacto fijado {relative_name}")
            digest = hashlib.sha256()
            with file_path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            actual_hash = digest.hexdigest()
            if actual_hash != expected_hash:
                fail(f"el hash del artefacto {relative_name} no coincide")
        if any(artifact_paths[key] not in file_hashes for key in required_artifacts):
            fail("cada paquete de sistema debe estar fijado por SHA-256 en files")
        validate_debian_artifacts(content, manifest)
        for path in content.rglob("*.sh"):
            text = path.read_text(encoding="utf-8", errors="replace")
            if re.search(r"\baws\s+(?:ssm|secretsmanager)\b|aws-secretsmanager:", text, re.IGNORECASE):
                fail("el bundle contiene una llamada AWS SSM/Secrets Manager no permitida")
        if not already_extracted:
            os.replace(content, release)
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
    return release


def install_state_path() -> pathlib.Path:
    return DATA_ROOT / "bootstrap-install-state.json"


def package_status(package_name: str) -> tuple[str, str]:
    result = subprocess.run(
        ["dpkg-query", "--show", "-f=${db:Status-Status}|${Version}", package_name],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        fields = result.stdout.strip().split("|", 1)
        if len(fields) != 2:
            fail(f"no se pudo leer el estado/version de {package_name}")
        return fields[0], fields[1]
    if result.returncode == 1:
        return "", ""
    fail(f"no se pudo comprobar el estado de {package_name}")
    raise AssertionError("unreachable")


def require_clean_first_install_state(
    package_statuses: dict[str, tuple[str, str]], expected_manager_version: str
) -> None:
    package_names = ("wazuh-manager", "wazuh-indexer", "wazuh-dashboard", "filebeat")
    manager_status, manager_version = package_statuses.get("wazuh-manager", ("", ""))
    residual_manager_config = manager_status == "config-files"
    if residual_manager_config and manager_version != expected_manager_version:
        fail("el residuo config-files de wazuh-manager no corresponde a la versión fijada; se preserva")
    for name in package_names:
        status, _version = package_statuses.get(name, ("", ""))
        if name == "wazuh-manager" and residual_manager_config:
            continue
        if status not in ("", "not-installed"):
            fail("el host tiene paquetes Wazuh instalados o parcialmente instalados sin registro")

    if os.path.lexists(DATA_ROOT) is False or DATA_ROOT.is_symlink() or not DATA_ROOT.is_dir():
        fail("no se pudo verificar el disco durable vacío antes de instalar")

    expected_data_dirs = {
        "manager": DATA_ROOT / "manager",
        "indexer": DATA_ROOT / "indexer",
        "dashboard": DATA_ROOT / "dashboard",
    }
    for path in expected_data_dirs.values():
        if path.is_symlink() or not path.is_dir() or any(path.iterdir()):
            fail("el disco durable contiene datos o una estructura inesperada; se preserva sin cambios")

    for entry in DATA_ROOT.iterdir():
        if entry.name in expected_data_dirs:
            continue
        if entry.name == "lost+found" and not entry.is_symlink() and entry.is_dir() and not any(entry.iterdir()):
            continue
        fail("el disco durable contiene datos o una estructura inesperada; se preserva sin cambios")

    state_path = install_state_path()
    if os.path.lexists(state_path):
        fail("el host tiene un registro durable de instalación; se preserva sin cambios")

    if os.path.lexists(CORE_ROOT):
        fail("QAPAQ Core ya existe; se preserva sin cambios")

    for service in (
        "wazuh-indexer",
        "wazuh-manager",
        "filebeat",
        "wazuh-dashboard",
        "qapaq-core-api",
        "qapaq-core-worker",
    ):
        result = subprocess.run(
            ["systemctl", "show", "--property=ActiveState", "--value", service],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0 or result.stdout.strip() not in ("", "inactive"):
            fail("hay un servicio de Wazuh o Core activo/no verificable; se preserva el estado existente")


def installer_required(release: pathlib.Path, expected_manager_version: str | None = None) -> bool:
    """Run the one-shot installer only on a clean host or for its recorded release.

    The installer may generate credentials and initialize state-bearing services. Re-running
    it against an existing Wazuh data disk can be destructive, so a new release never triggers
    an implicit in-place upgrade.
    """
    state_path = install_state_path()
    if state_path.exists():
        try:
            state_stat = state_path.lstat()
        except OSError:
            fail("no se pudo inspeccionar el registro durable de instalación")
        if not stat.S_ISREG(state_stat.st_mode):
            fail("el registro durable no es un archivo normal; no se volverá a instalar")
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            fail("el registro durable de instalación no es válido; no se volverá a instalar")
        if (
            state.get("schemaVersion") != 1
            or not re.fullmatch(r"[0-9a-f]{64}", state.get("artifactSha256", ""))
            or state.get("artifactSha256") != release.name
        ):
            fail("el host ya registra otra release; no se ejecuta una actualización implícita")
        return False

    package_names = ("wazuh-manager", "wazuh-indexer", "wazuh-dashboard", "filebeat")
    package_statuses = {name: package_status(name) for name in package_names}
    require_clean_first_install_state(package_statuses, expected_manager_version or "")
    return True


def record_install_state(release: pathlib.Path) -> None:
    state_path = install_state_path()
    state_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary_path = state_path.with_name(f".{state_path.name}.tmp")
    file_descriptor = os.open(
        temporary_path,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(file_descriptor, "w", encoding="utf-8") as stream:
        json.dump({"schemaVersion": 1, "artifactSha256": release.name}, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_path, state_path)
    os.chmod(state_path, 0o600)


def install_release(release: pathlib.Path, config: dict) -> None:
    try:
        manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("manifest.json del bundle no es válido al instalar")

    debian_packages = manifest.get("debianPackages") if isinstance(manifest, dict) else None
    expected_manager_version = debian_packages.get("wazuh-manager") if isinstance(debian_packages, dict) else None
    if not isinstance(expected_manager_version, str) or not expected_manager_version:
        fail("manifest.json no fija la versión Debian de wazuh-manager")

    installer = release / "install.sh"
    needs_install = installer_required(release, expected_manager_version)
    if needs_install:
        os.chmod(installer, 0o700)
        environment = os.environ.copy()
        environment.update(
            {
                "QAPAQ_DATA_ROOT": str(DATA_ROOT),
                "QAPAQ_CORE_ENV_FILE": str(CORE_ENV_PATH),
                "QAPAQ_SECRET_DIR": str(WAZUH_SECRET_DIR),
                "QAPAQ_WAZUH_VERSION": EXPECTED["wazuh_version"],
                "QAPAQ_OSD_VERSION": EXPECTED["osd_version"],
                "QAPAQ_CORE_NODE_VERSION": EXPECTED["node_version"],
                "QAPAQ_RELEASE_DIR": str(release),
            }
        )
        office365 = config["office365"]
        environment.update(
            {
                "QAPAQ_O365_TENANT_ID": office365["tenant_id"],
                "QAPAQ_O365_CLIENT_ID": office365["client_id"],
                "QAPAQ_O365_API_TYPE": office365["api_type"],
                "QAPAQ_O365_ENABLE_DLP": str(office365["enable_dlp"]).lower(),
                "QAPAQ_PROVIDER_INGESTION_JSON": json.dumps(config.get("provider_ingestion", {}), separators=(",", ":")),
            }
        )
        # Wazuh's installation assistant prints generated credentials in its summary.
        # Do not inherit stdout/stderr into the Custom Script extension log. Keep
        # diagnostics intentionally generic so secrets cannot leak through a failure.
        result = subprocess.run(
            ["bash", str(installer)],
            cwd=release,
            env=environment,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            fail(f"el instalador del bundle falló (código {result.returncode}); salida suprimida por seguridad")

    manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    for package_name in ("wazuh-manager", "wazuh-indexer", "wazuh-dashboard", "filebeat"):
        actual = run("dpkg-query", "--show", "-f=${Version}", package_name, capture=True)
        if actual != manifest["debianPackages"][package_name]:
            fail(f"la versión instalada de {package_name} no coincide con el bundle fijado")

    node = pathlib.Path("/opt/qapaq-core/current/node/bin/node")
    if not node.exists():
        fail("el instalador no dejó el runtime Node de qapaq-core")
    node_version = run(str(node), "--version", capture=True)
    if node_version != f"v{EXPECTED['node_version']}":
        fail("la versión Node del core instalado no coincide con 24.21.0")
    validate_runtime_health()
    if needs_install:
        record_install_state(release)
    log("servicios de Wazuh QAPAQ y qapaq-core activos según systemd")


def main() -> None:
    if os.geteuid() != 0:
        fail("bootstrap requiere root")
    config = load_config()
    mount_data_disk(config["data_disk_size_gb"])
    with tempfile.TemporaryDirectory(prefix="qapaq-siem-bootstrap-") as temp_dir:
        bundle = pathlib.Path(temp_dir) / "siem-release.tar.gz"
        fetch_bundle(config, bundle)
        release = extract_and_verify(bundle, config)
        materialize_secrets(config)
        install_release(release, config)
        configure_indexer_proxy(config)
    log("bootstrap completo; sin cambios DNS ni aperturas adicionales de red")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - redact unexpected external error details.
        fail(f"error inesperado de bootstrap: {type(error).__name__}")
