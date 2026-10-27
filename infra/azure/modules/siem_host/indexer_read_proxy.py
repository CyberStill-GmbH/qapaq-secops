#!/usr/bin/python3
"""Provision the private, read-only Wazuh Indexer proxy on an Azure SIEM host.

Secret values stay in process memory and HTTPS requests. They are never passed in
argv, emitted to logs, or included in Terraform configuration/state. The VM
Managed Identity may get/set only the two pre-created Key Vault secret scopes
supplied by the opt-in KrakenD configuration.
"""

from __future__ import annotations

import base64
import fnmatch
import http.client
import ipaddress
import json
import os
import pathlib
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

try:
    import grp
except ImportError:  # Tests can run on Windows; production host is Ubuntu.
    grp = None

INDEXER_PORT = 9200
PROXY_PORT = 9443
INDEXER_CA = pathlib.Path("/etc/wazuh-indexer/certs/root-ca.pem")
INSTALL_ARCHIVE = pathlib.Path("/root/wazuh-install-files.tar")
PROXY_ROOT = pathlib.Path("/etc/qapaq/indexer-proxy")
PROXY_CERT = PROXY_ROOT / "cert.pem"
PROXY_KEY = PROXY_ROOT / "key.pem"
PROXY_CONF = pathlib.Path("/etc/nginx/conf.d/qapaq-indexer-proxy.conf")
READER_USER = "qapaq_reader"
READER_ROLE = "qapaq_alerts_read"
PLACEHOLDER = "bootstrap-pending"
ALERTS_PATTERN = "wazuh-alerts-*"


class IndexerProxyError(RuntimeError):
    """Safe-to-log provisioning failure; never carries a secret or response body."""


def _fail(message: str) -> None:
    raise IndexerProxyError(message)


def _run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
    )
    if result.returncode != 0:
        _fail(f"falló una herramienta requerida: {pathlib.Path(args[0]).name}")
    return result.stdout.strip() if capture else ""


def validate_config(config: dict) -> None:
    if not isinstance(config, dict) or set(config) != {
        "private_ip_address", "reader_secret_name", "proxy_ca_secret_name"
    }:
        _fail("la configuración del proxy Indexer no tiene el contrato esperado")
    ip = config["private_ip_address"]
    parts = ip.split(".") if isinstance(ip, str) else []
    if len(parts) != 4 or any(
        not part.isdigit() or str(int(part)) != part or int(part) > 255 for part in parts
    ):
        _fail("la IP privada del proxy Indexer no es IPv4 válida")
    address = ipaddress.IPv4Address(ip)
    if not any(
        address in ipaddress.ip_network(network)
        for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    ):
        _fail("la IP del proxy Indexer debe pertenecer a RFC1918")
    for name in (config["reader_secret_name"], config["proxy_ca_secret_name"]):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,127}", name):
            _fail("la referencia de Key Vault del proxy Indexer no es válida")
    if config["reader_secret_name"] == config["proxy_ca_secret_name"]:
        _fail("el lector y el certificado requieren referencias Key Vault distintas")


def reader_password_from_secret(value: str | None) -> tuple[str, str, bool]:
    """Return (password, Basic-auth-B64, should_publish), without logging values."""
    if value is None or value.strip() == PLACEHOLDER:
        # OpenSearch's default password policy requires all four character classes.
        # Avoid ':' (the Basic-auth separator), whitespace, and control characters.
        classes = (
            "abcdefghijklmnopqrstuvwxyz",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "0123456789",
            "!@#$%^&*()-_=+[]{}.,?",
        )
        alphabet = "".join(classes)
        characters = [secrets.choice(group) for group in classes]
        characters.extend(secrets.choice(alphabet) for _ in range(44))
        secrets.SystemRandom().shuffle(characters)
        password = "".join(characters)
        encoded = base64.b64encode(f"{READER_USER}:{password}".encode("ascii")).decode("ascii")
        return password, encoded, True
    try:
        decoded = base64.b64decode(value, validate=True).decode("ascii")
    except (ValueError, UnicodeDecodeError):
        _fail("el secreto del lector debe contener Basic auth Base64 válido o el marcador inicial")
    username, separator, password = decoded.partition(":")
    if (
        username != READER_USER
        or not separator
        or not password
        or any(ord(char) < 0x21 or ord(char) > 0x7E for char in password)
    ):
        _fail("el secreto del lector no corresponde a la identidad read-only QAPAQ")
    return password, value, False


def _indexer_request(
    base_url: str,
    method: str,
    path: str,
    admin_password: str,
    payload: dict | None = None,
    tls_name: str | None = None,
) -> tuple[int, dict]:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname is None or parsed.port != INDEXER_PORT:
        _fail("el endpoint local de Indexer no coincide con el contrato TLS")
    tls_name = tls_name or parsed.hostname
    if not re.fullmatch(r"[A-Za-z0-9.-]+", tls_name):
        _fail("el nombre TLS local del Indexer no es válido")
    credential = base64.b64encode(f"admin:{admin_password}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {credential}", "Content-Type": "application/json"}
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
    context = ssl.create_default_context(cafile=str(INDEXER_CA))
    connection = _PinnedLocalHTTPSConnection(
        connect_host=parsed.hostname,
        tls_name=tls_name,
        port=parsed.port,
        context=context,
        timeout=12,
    )
    try:
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            _fail("Indexer devolvió una respuesta mayor al límite de bootstrap")
        if response.status < 200 or response.status >= 300 or not body:
            # Never include response bodies: upstream errors can contain sensitive data.
            return response.status, {}
        return response.status, json.loads(body)
    except (OSError, http.client.HTTPException, ssl.SSLError, json.JSONDecodeError):
        _fail("no se pudo consultar el Indexer con TLS verificado")
    finally:
        connection.close()
    raise AssertionError("unreachable")


class _PinnedLocalHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a local IP while validating TLS against the Indexer's cert name."""

    def __init__(self, connect_host: str, tls_name: str, port: int, **kwargs) -> None:
        super().__init__(host=tls_name, port=port, **kwargs)
        self.connect_host = connect_host

    def connect(self) -> None:
        raw = socket.create_connection((self.connect_host, self.port), self.timeout, self.source_address)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def _admin_password() -> str:
    try:
        with tarfile.open(INSTALL_ARCHIVE, "r:") as archive:
            member = archive.getmember("wazuh-install-files/wazuh-passwords.txt")
            if member.size > 1024 * 1024:
                _fail("el archivo de contraseñas Wazuh excede el límite")
            stream = archive.extractfile(member)
            if stream is None:
                _fail("el archivo de contraseñas Wazuh no se puede leer")
            lines = stream.read().decode("utf-8").splitlines()
    except (OSError, KeyError, tarfile.TarError, UnicodeDecodeError):
        _fail("no se pudieron leer credenciales del archivo de instalación Wazuh")
    for index, line in enumerate(lines):
        key, separator, value = line.partition(":")
        if separator and key.strip().lower() == "indexer_username" and value.strip().strip("'\"") == "admin":
            for next_line in lines[index + 1:index + 4]:
                next_key, next_separator, next_value = next_line.partition(":")
                if next_separator and next_key.strip().lower() == "indexer_password":
                    password = next_value.strip().strip("'\"")
                    if password:
                        return password
    _fail("no se encontró la credencial admin del Indexer en el bundle instalado")
    raise AssertionError("unreachable")


def _public_key(path: pathlib.Path, is_certificate: bool) -> str:
    args = (
        ["openssl", "x509", "-in", str(path), "-pubkey", "-noout"]
        if is_certificate
        else ["openssl", "pkey", "-in", str(path), "-pubout"]
    )
    return _run(*args, capture=True)


def _validate_proxy_certificate(private_ip: str, certificate: pathlib.Path, key: pathlib.Path) -> None:
    san = _run("openssl", "x509", "-in", str(certificate), "-noout", "-ext", "subjectAltName", capture=True)
    if f"IP Address:{private_ip}" not in san:
        _fail("el certificado TLS local no está emitido para la IP privada del proxy")
    if _public_key(certificate, True) != _public_key(key, False):
        _fail("el certificado TLS local no coincide con su clave privada")
    _run("openssl", "x509", "-in", str(certificate), "-checkend", "86400", "-noout")


def _secure_proxy_certificate_permissions() -> None:
    if grp is None:
        _fail("el proxy requiere un sistema Unix con grupo Nginx www-data")
    try:
        group_id = grp.getgrnam("www-data").gr_gid
        os.chown(PROXY_ROOT, 0, group_id)
        os.chown(PROXY_KEY, 0, group_id)
        os.chown(PROXY_CERT, 0, 0)
        os.chmod(PROXY_ROOT, 0o750)
        os.chmod(PROXY_KEY, 0o640)
        os.chmod(PROXY_CERT, 0o644)
    except (KeyError, OSError):
        _fail("no se pudo asignar acceso restringido al worker Nginx para el certificado")


def _prepare_proxy_certificate(private_ip: str, stored: str | None) -> tuple[str, bool]:
    PROXY_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    cert_exists, key_exists = PROXY_CERT.exists(), PROXY_KEY.exists()
    if cert_exists != key_exists:
        _fail("el proxy conserva solo parte de su par TLS; se detuvo para rotación coordinada")
    if cert_exists:
        _validate_proxy_certificate(private_ip, PROXY_CERT, PROXY_KEY)
        _secure_proxy_certificate_permissions()
        certificate = PROXY_CERT.read_text(encoding="ascii")
        if stored not in (None, PLACEHOLDER) and stored != certificate:
            _fail("el certificado local difiere de Key Vault; se requiere rotación coordinada")
        return certificate, stored in (None, PLACEHOLDER)
    if stored not in (None, PLACEHOLDER):
        _fail("Key Vault conserva una CA sin clave privada local; se requiere rotación coordinada")

    with tempfile.TemporaryDirectory(prefix="qapaq-indexer-cert-", dir=PROXY_ROOT) as temporary:
        cert_path, key_path = pathlib.Path(temporary) / "cert.pem", pathlib.Path(temporary) / "key.pem"
        _run(
            "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-days", "825", "-subj", "/CN=qapaq-indexer-proxy",
            "-addext", f"subjectAltName=IP:{private_ip}", "-keyout", str(key_path), "-out", str(cert_path),
        )
        os.chmod(key_path, 0o640)
        os.chmod(cert_path, 0o644)
        _validate_proxy_certificate(private_ip, cert_path, key_path)
        certificate = cert_path.read_text(encoding="ascii")
        os.replace(key_path, PROXY_KEY)
        os.replace(cert_path, PROXY_CERT)
    _secure_proxy_certificate_permissions()
    return certificate, True


def _select_indexer_endpoint(private_ip: str) -> str:
    """Prefer loopback; accept the VM address only when the Indexer binds there."""
    candidates = list(dict.fromkeys(("127.0.0.1", private_ip)))
    for host in candidates:
        try:
            with socket.create_connection((host, INDEXER_PORT), timeout=3):
                return f"https://{host}:{INDEXER_PORT}"
        except OSError:
            continue
    _fail("el Indexer no escucha en loopback ni en la IP privada local esperada")
    raise AssertionError("unreachable")


def _upstream_tls_name(indexer_url: str, private_ip: str, workdir: pathlib.Path) -> str:
    parsed = urllib.parse.urlparse(indexer_url)
    if parsed.scheme != "https" or parsed.hostname is None or parsed.port != INDEXER_PORT:
        _fail("el endpoint local de Indexer no coincide con el contrato TLS")
    try:
        certificate = ssl.get_server_certificate((parsed.hostname, INDEXER_PORT), timeout=10)
    except (OSError, ssl.SSLError):
        _fail("no se pudo obtener el certificado TLS del Indexer local")
    path = workdir / "indexer-upstream.pem"
    path.write_text(certificate, encoding="ascii")
    san = _run("openssl", "x509", "-in", str(path), "-noout", "-ext", "subjectAltName", capture=True)
    names = re.findall(r"DNS:([A-Za-z0-9.-]+)", san)
    ips = re.findall(r"IP Address:([0-9.]+)", san)
    ssl_name = parsed.hostname if parsed.hostname in ips else ""
    ssl_name = ssl_name or (private_ip if private_ip in ips else "")
    ssl_name = ssl_name or (names[0] if names else "")
    if not ssl_name:
        subject = _run(
            "openssl", "x509", "-in", str(path), "-noout", "-subject", "-nameopt", "sep_multiline", capture=True
        )
        match = re.search(r"(?:^|\n)\s*CN\s*=\s*([A-Za-z0-9.-]+)\s*$", subject)
        ssl_name = match.group(1) if match else ""
    try:
        ipaddress.ip_address(ssl_name)
        is_ip = True
    except ValueError:
        is_ip = False
    if not is_ip and not re.fullmatch(r"[A-Za-z0-9.-]+", ssl_name):
        _fail("el certificado TLS del Indexer no declara una identidad DNS/IP verificable")
    verify_flag = "-verify_ip" if is_ip else "-verify_hostname"
    _run("openssl", "verify", "-CAfile", str(INDEXER_CA), verify_flag, ssl_name, str(path))
    return ssl_name


def _nginx_configuration(private_ip: str, indexer_url: str, upstream_name: str) -> str:
    return f"""# QAPAQ SecOps — Azure read-only Wazuh Indexer proxy.
# Only alert search and cluster health are exposed; all other paths return 403.
server {{
  listen {private_ip}:{PROXY_PORT} ssl;
  ssl_certificate     {PROXY_CERT};
  ssl_certificate_key {PROXY_KEY};
  ssl_protocols TLSv1.2 TLSv1.3;
  access_log off;
  client_max_body_size 64k;

  location ~ ^/wazuh-alerts-[A-Za-z0-9.*-]+/_search$ {{
    limit_except POST {{ deny all; }}
    proxy_pass {indexer_url};
    proxy_set_header Authorization $http_authorization;
    proxy_ssl_trusted_certificate {INDEXER_CA};
    proxy_ssl_verify on;
    proxy_ssl_server_name on;
    proxy_ssl_name {upstream_name};
    proxy_read_timeout 15s;
  }}
  location = /_cluster/health {{
    limit_except GET {{ deny all; }}
    proxy_pass {indexer_url};
    proxy_set_header Authorization $http_authorization;
    proxy_ssl_trusted_certificate {INDEXER_CA};
    proxy_ssl_verify on;
    proxy_ssl_server_name on;
    proxy_ssl_name {upstream_name};
  }}
  location / {{ return 403; }}
}}
"""


def _probe(private_ip: str, certificate: pathlib.Path, basic_auth: str, method: str, path: str, body: bytes | None = None) -> int:
    context = ssl.create_default_context(cafile=str(certificate))
    request = urllib.request.Request(
        f"https://{private_ip}:{PROXY_PORT}{path}",
        data=body,
        headers={"Authorization": f"Basic {basic_auth}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, context=context, timeout=10) as response:
            response.read(64 * 1024)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, urllib.error.URLError, ssl.SSLError):
        return 0


def _restore_nginx(previous: bytes | None, previous_mode: int | None) -> bool:
    try:
        if previous is None:
            PROXY_CONF.unlink(missing_ok=True)
        else:
            PROXY_CONF.write_bytes(previous)
            os.chmod(PROXY_CONF, previous_mode if previous_mode is not None else 0o640)
        _run("nginx", "-t")
        result = subprocess.run(
            ["systemctl", "reload", "nginx"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return True
        result = subprocess.run(
            ["nginx", "-s", "reload"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0
    except (OSError, IndexerProxyError):
        return False


def _apply_nginx(config_text: str) -> tuple[bytes | None, int | None]:
    if shutil.which("nginx") is None:
        _run("apt-get", "install", "-y", "nginx")
    PROXY_CONF.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    previous = PROXY_CONF.read_bytes() if PROXY_CONF.exists() else None
    previous_mode = PROXY_CONF.stat().st_mode & 0o777 if PROXY_CONF.exists() else None
    temporary = PROXY_CONF.with_name(f".{PROXY_CONF.name}.tmp")
    temporary.write_text(config_text, encoding="utf-8")
    os.chmod(temporary, 0o640)
    os.replace(temporary, PROXY_CONF)
    try:
        _run("nginx", "-t")
        result = subprocess.run(["systemctl", "reload", "nginx"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode != 0:
            _run("nginx", "-s", "reload")
    except IndexerProxyError:
        if not _restore_nginx(previous, previous_mode):
            _fail("Nginx no pasó la validación y tampoco se pudo restaurar su configuración previa")
        raise
    return previous, previous_mode


def _restore_security_object(
    base_url: str,
    admin_password: str,
    tls_name: str,
    path: str,
    previous: dict | None,
) -> bool:
    method = "DELETE" if previous is None else "PUT"
    status, _ = _indexer_request(base_url, method, path, admin_password, previous, tls_name)
    return status in ((200, 201, 404) if previous is None else (200, 201))


def _rollback_indexer_security(
    base_url: str,
    admin_password: str,
    tls_name: str,
    role: dict | None,
    user_existed: bool,
    mapping: dict | None,
    log: Callable[[str], None],
) -> None:
    """Restore only the QAPAQ-owned objects changed by this bootstrap."""
    ok = True
    if not user_existed:
        status, _ = _indexer_request(
            base_url, "DELETE", f"/_plugins/_security/api/internalusers/{READER_USER}", admin_password,
            tls_name=tls_name,
        )
        ok = ok and status in (200, 404)
    ok = _restore_security_object(
        base_url,
        admin_password,
        tls_name,
        f"/_plugins/_security/api/rolesmapping/{READER_ROLE}",
        mapping,
    ) and ok
    ok = _restore_security_object(
        base_url,
        admin_password,
        tls_name,
        f"/_plugins/_security/api/roles/{READER_ROLE}",
        role,
    ) and ok
    if not ok:
        log("rollback parcial de objetos Indexer; revisar estado del bootstrap sin exponer credenciales")


def _restore_key_vault_placeholders(
    config: dict,
    publish_reader: bool,
    publish_ca: bool,
    set_secret: Callable[[str, str], None],
    log: Callable[[str], None],
) -> bool:
    """Compensate a partial write without logging generated secret values.

    Both selected values were required to be the fixed placeholder before any
    bootstrap mutation, so that marker is the only safe rollback value. Restore
    both eligible references because a Key Vault request can commit server-side
    even when its response is lost by the caller.
    """
    ok = True
    for name, should_restore in (
        (config["proxy_ca_secret_name"], publish_ca),
        (config["reader_secret_name"], publish_reader),
    ):
        if not should_restore:
            continue
        try:
            set_secret(name, PLACEHOLDER)
        except Exception:
            ok = False
    if not ok:
        log("rollback parcial de Key Vault; un marcador del proxy podría requerir reintento")
    return ok


def configure(
    config: dict,
    reader_secret: str | None,
    proxy_ca_secret: str | None,
    set_secret: Callable[[str, str], None],
    log: Callable[[str], None],
) -> None:
    """Create Indexer reader role/user and proxy, test, then publish only two values."""
    validate_config(config)
    if reader_secret is None or proxy_ca_secret is None:
        _fail("precrea los dos secretos Key Vault del proxy con valor bootstrap-pending antes del apply")

    private_ip = config["private_ip_address"]
    password, basic_auth, publish_reader = reader_password_from_secret(reader_secret)
    certificate, publish_ca = _prepare_proxy_certificate(private_ip, proxy_ca_secret)
    admin_password = _admin_password()

    indexer_url = _select_indexer_endpoint(private_ip)
    with tempfile.TemporaryDirectory(prefix="qapaq-indexer-tls-") as tls_work:
        upstream_name = _upstream_tls_name(indexer_url, private_ip, pathlib.Path(tls_work))
    request_indexer = lambda method, path, payload=None: _indexer_request(  # noqa: E731
        indexer_url, method, path, admin_password, payload, upstream_name
    )
    role_status, role_response = request_indexer("GET", f"/_plugins/_security/api/roles/{READER_ROLE}")
    if role_status not in (200, 404):
        _fail(f"Indexer rechazó la lectura del rol read-only (HTTP {role_status})")
    previous_role = role_response.get(READER_ROLE) if role_status == 200 else None
    if role_status == 200 and not isinstance(previous_role, dict):
        _fail("Indexer devolvió un rol read-only incompatible")

    user_status, user_response = request_indexer(
        "GET", f"/_plugins/_security/api/internalusers/{READER_USER}"
    )
    if user_status not in (200, 404):
        _fail(f"Indexer rechazó la lectura del usuario read-only (HTTP {user_status})")
    user_existed = user_status == 200
    if user_existed and publish_reader:
        _fail("existe el lector pero Key Vault conserva el marcador; no se rotará una cuenta que no pueda restaurarse")

    all_mappings_status, all_mappings = request_indexer(
        "GET", "/_plugins/_security/api/rolesmapping"
    )
    if all_mappings_status != 200 or not isinstance(all_mappings, dict):
        _fail("Indexer no permitió verificar los mapeos de seguridad del lector")
    user_backend_roles: list[str] = []
    if user_existed:
        user_record = user_response.get(READER_USER) if isinstance(user_response, dict) else None
        if not isinstance(user_record, dict):
            _fail("Indexer devolvió un usuario read-only incompatible")
        user_backend_roles = user_record.get("backend_roles", [])
        if not isinstance(user_backend_roles, list) or any(
            not isinstance(role, str) for role in user_backend_roles
        ):
            _fail("Indexer devolvió roles de backend del lector incompatibles")
        if user_backend_roles:
            _fail("el lector existente tiene roles de backend; se detuvo para evitar permisos heredados")

    for mapped_role, mapped_config in all_mappings.items():
        if not isinstance(mapped_config, dict):
            _fail("Indexer devolvió un mapeo de seguridad incompatible")
        mapped_users = mapped_config.get("users", [])
        mapped_backend_roles = mapped_config.get("backend_roles", [])
        if not all(isinstance(entries, list) for entries in (mapped_users, mapped_backend_roles)):
            _fail("Indexer devolvió listas de mapeo de roles incompatibles")
        if mapped_role == READER_ROLE:
            continue
        if any(
            not isinstance(pattern, str) or fnmatch.fnmatchcase(READER_USER, pattern)
            for pattern in mapped_users
        ):
            _fail("el lector está asignado a otro rol Indexer; se detuvo para evitar privilegios heredados")

    mapping_status, mapping_response = request_indexer("GET", f"/_plugins/_security/api/rolesmapping/{READER_ROLE}")
    if mapping_status not in (200, 404):
        _fail(f"Indexer rechazó la lectura del mapeo de roles (HTTP {mapping_status})")
    previous_mapping = mapping_response.get(READER_ROLE) if mapping_status == 200 else None
    if previous_mapping is not None and not isinstance(previous_mapping, dict):
        _fail("Indexer devolvió un mapeo de roles incompatible")

    role_changed = False
    user_created = False
    mapping_changed = False
    nginx_previous: tuple[bytes | None, int | None] | None = None
    try:
        code, _ = request_indexer(
            "PUT", f"/_plugins/_security/api/roles/{READER_ROLE}",
            {
                "description": "QAPAQ: lectura de alertas para la ingesta; sin escritura ni administración",
                "cluster_permissions": ["cluster:monitor/health"],
                "index_permissions": [{"index_patterns": [ALERTS_PATTERN], "allowed_actions": ["read"]}],
            },
        )
        if code not in (200, 201):
            _fail(f"Indexer rechazó el rol de lectura (HTTP {code})")
        role_changed = True

        if not user_existed:
            code, _ = request_indexer(
                "PUT", f"/_plugins/_security/api/internalusers/{READER_USER}",
                {"password": password, "description": "QAPAQ: lector read-only para KrakenD", "backend_roles": []},
            )
            if code not in (200, 201):
                _fail(f"Indexer rechazó el usuario read-only (HTTP {code})")
            user_created = True

        current = previous_mapping or {}
        users = current.get("users", [])
        if not isinstance(users, list) or any(not isinstance(user, str) for user in users):
            _fail("Indexer devolvió listas de mapeo de roles incompatibles")
        mapping_payload = dict(current)
        mapping_payload["users"] = sorted(set(users) | {READER_USER})
        mapping_payload.setdefault("backend_roles", [])
        mapping_payload.setdefault("hosts", [])
        code, _ = request_indexer(
            "PUT", f"/_plugins/_security/api/rolesmapping/{READER_ROLE}", mapping_payload
        )
        if code not in (200, 201):
            _fail(f"Indexer rechazó el mapeo del usuario read-only (HTTP {code})")
        mapping_changed = True

        with tempfile.TemporaryDirectory(prefix="qapaq-indexer-proxy-") as work:
            nginx_previous = _apply_nginx(_nginx_configuration(private_ip, indexer_url, upstream_name))
            search_code = _probe(private_ip, PROXY_CERT, basic_auth, "POST", "/wazuh-alerts-*/_search", b'{"size":0}')
            health_code = _probe(private_ip, PROXY_CERT, basic_auth, "GET", "/_cluster/health")
            security_code = _probe(private_ip, PROXY_CERT, basic_auth, "GET", "/_plugins/_security/api/internalusers")
            write_code = _probe(private_ip, PROXY_CERT, basic_auth, "POST", "/wazuh-alerts-qapaq-probe/_doc", b"{}")
            if search_code != 200 or health_code != 200 or security_code != 403 or write_code != 403:
                _fail("la autoprueba del proxy no confirma lectura permitida y rutas restringidas")
            if publish_reader:
                set_secret(config["reader_secret_name"], basic_auth)
            if publish_ca:
                set_secret(config["proxy_ca_secret_name"], certificate)
    except Exception:
        if publish_reader or publish_ca:
            _restore_key_vault_placeholders(
                config,
                publish_reader,
                publish_ca,
                set_secret,
                log,
            )
        if nginx_previous is not None and not _restore_nginx(*nginx_previous):
            log("no se pudo confirmar el rollback de Nginx tras fallar el proxy")
        if mapping_changed or user_created or role_changed:
            _rollback_indexer_security(
                indexer_url,
                admin_password,
                upstream_name,
                previous_role if role_changed else None,
                user_existed,
                previous_mapping if mapping_changed else None,
                log,
            )
        raise

    log("proxy read-only del Indexer validado; referencias Basic auth y CA actualizadas en Key Vault")
