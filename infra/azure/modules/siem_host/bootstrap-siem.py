#!/usr/bin/python3
"""First-boot installer for a privately networked QAPAQ Wazuh host.

The only artifact input is a SHA-256-pinned private Blob. Runtime secret values
are read through the VM's user-assigned identity and are never printed or passed
in argv. The pinned release bundle owns package installation and service setup.
"""

from __future__ import annotations

import hashlib
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


CONFIG_PATH = pathlib.Path("/etc/qapaq-siem/bootstrap.json")
DATA_DEVICE = pathlib.Path("/dev/disk/azure/scsi1/lun0")
DATA_ROOT = pathlib.Path("/srv/qapaq-siem")
CORE_ENV_PATH = pathlib.Path("/etc/qapaq-core/core.env")
WAZUH_SECRET_DIR = pathlib.Path("/etc/qapaq-secrets")
RELEASE_ROOT = pathlib.Path("/opt/qapaq-siem/releases")
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
    return config


def mount_data_disk() -> None:
    for _ in range(180):
        if DATA_DEVICE.exists():
            break
        time.sleep(2)
    else:
        fail("el disco de datos LUN 0 no apareció; no se instaló el SIEM")

    device = str(DATA_DEVICE)
    fs_type = subprocess.run(
        ["blkid", "-p", "-s", "TYPE", "-o", "value", device],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if fs_type.returncode != 0:
        signatures = subprocess.run(
            ["wipefs", "-n", device], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        if signatures.returncode != 0 or signatures.stdout.strip():
            fail("el disco tiene una firma desconocida; se detuvo sin formatearlo")
        log("disco nuevo sin firmas: se crea ext4 antes de instalar paquetes")
        run("mkfs.ext4", "-m", "1", "-L", "qapaq-siem-data", device)
        fs_type = subprocess.run(
            ["blkid", "-p", "-s", "TYPE", "-o", "value", device],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
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


def systemd_quote(value: str) -> str:
    if "\n" in value or "\r" in value or "\x00" in value:
        fail("una variable de entorno contiene saltos de línea")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def materialize_secrets(config: dict) -> None:
    core_secret_names = config.get("core_secret_names", {})
    wazuh_secret_names = config.get("wazuh_secret_names", {})
    for key, name in core_secret_names.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key):
            fail("nombre de variable de entorno de core inválido")
    for filename, name in wazuh_secret_names.items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", filename):
            fail("nombre de archivo de secreto Wazuh inválido")

    all_names = set(core_secret_names.values()) | set(wazuh_secret_names.values())
    secret_values: dict[str, str] = {}
    if all_names:
        kv_token = get_token(config["identity_client_id"], "https://vault.azure.net")
        secret_values = {name: key_vault_get(config, kv_token, name) for name in sorted(all_names)}
        del kv_token

    environment = config.get("core_environment", {})
    if not isinstance(environment, dict):
        fail("core_environment debe ser un objeto")
    merged_env = dict(environment)
    merged_env.update({key: secret_values[name] for key, name in core_secret_names.items()})
    for key, value in merged_env.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) or not isinstance(value, str):
            fail("configuración de entorno core inválida")
    CORE_ENV_PATH.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with CORE_ENV_PATH.open("w", encoding="utf-8") as stream:
        for key in sorted(merged_env):
            stream.write(f"{key}={systemd_quote(merged_env[key])}\n")
    os.chmod(CORE_ENV_PATH, 0o640)
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
            stream.write(secret_values[secret_name])
        os.chmod(target, 0o600)
    del secret_values
    log(f"referencias Key Vault resueltas sin imprimir valores: {len(all_names)}")


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


def package_registered(package_name: str) -> bool:
    result = subprocess.run(
        ["dpkg-query", "--show", "-f=${db:Status-Status}", package_name],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        return bool(result.stdout.strip())
    if result.returncode == 1:
        return False
    fail(f"no se pudo comprobar el estado de {package_name}")
    raise AssertionError("unreachable")


def installer_required(release: pathlib.Path) -> bool:
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
    present = [name for name in package_names if package_registered(name)]
    state_dirs = (DATA_ROOT / "manager", DATA_ROOT / "indexer", DATA_ROOT / "dashboard")
    populated_dirs = [path for path in state_dirs if path.exists() and any(path.iterdir())]
    core_root = pathlib.Path("/opt/qapaq-core")
    if present or populated_dirs or core_root.exists():
        fail("hay instalación o datos previos sin registro; se detuvo para proteger el estado existente")
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


def install_release(release: pathlib.Path) -> None:
    try:
        manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("manifest.json del bundle no es válido al instalar")

    installer = release / "install.sh"
    needs_install = installer_required(release)
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
    mount_data_disk()
    with tempfile.TemporaryDirectory(prefix="qapaq-siem-bootstrap-") as temp_dir:
        bundle = pathlib.Path(temp_dir) / "siem-release.tar.gz"
        fetch_bundle(config, bundle)
        release = extract_and_verify(bundle, config)
        materialize_secrets(config)
        install_release(release)
    log("bootstrap completo; sin cambios DNS ni aperturas adicionales de red")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - redact unexpected external error details.
        fail(f"error inesperado de bootstrap: {type(error).__name__}")
