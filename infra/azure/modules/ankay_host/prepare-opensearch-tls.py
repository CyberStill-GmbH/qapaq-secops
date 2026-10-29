#!/usr/bin/env python3
"""Prepara los directorios persistentes de Ankay y la PKI propia de OpenSearch.

Idempotente: en el primer arranque crea, en el disco de datos, una CA y un certificado
de nodo para «opensearch»/«localhost» (claves PKCS#8 que nunca salen del host) en lugar
de los certificados demo públicos de OpenSearch. En arranques siguientes solo corrige
dueños y permisos. No lee secretos de Key Vault.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(os.environ.get("ANKAY_DATA_ROOT", "/mnt/ankay"))
OPENSEARCH_UID = 1000
SHUFFLE_UID = 10001
SUBJECT_CA = "/O=QAPAQ/OU=Ankay/CN=ankay-opensearch-ca"
SUBJECT_NODE = "/O=QAPAQ/OU=Ankay/CN=opensearch"


def log(message: str) -> None:
    print(f"ankay-opensearch-tls: {message}", file=sys.stderr, flush=True)


def openssl(*args: str, cwd: pathlib.Path) -> None:
    result = subprocess.run(["openssl", *args], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SystemExit(f"ankay-opensearch-tls: openssl {args[0]} falló")


def ensure_dir(path: pathlib.Path, uid: int, gid: int, mode: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def generate(tls: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory(dir=tls) as work_name:
        work = pathlib.Path(work_name)
        openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", "ca-key.pem", cwd=work)
        openssl(
            "req", "-x509", "-new", "-key", "ca-key.pem", "-sha256", "-days", "3650", "-subj", SUBJECT_CA,
            "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            "-out", "ca.pem", cwd=work,
        )
        openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", "node-key.pem", cwd=work)
        openssl("req", "-new", "-key", "node-key.pem", "-subj", SUBJECT_NODE, "-out", "node.csr", cwd=work)
        (work / "node.ext").write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth,clientAuth\n"
            "subjectAltName=DNS:opensearch,DNS:localhost,IP:127.0.0.1\n",
            encoding="utf-8",
        )
        openssl(
            "x509", "-req", "-in", "node.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial",
            "-sha256", "-days", "825", "-extfile", "node.ext", "-out", "node.pem", cwd=work,
        )
        openssl("verify", "-CAfile", "ca.pem", "node.pem", cwd=work)
        private, node, ca = tls / "private", tls / "node", tls / "ca"
        shutil.move(str(work / "ca-key.pem"), private / "ca-key.pem")
        for name in ("ca.pem", "node.pem", "node-key.pem"):
            shutil.copy2(work / name, node / name)
        shutil.copy2(work / "ca.pem", ca / "ca.pem")


def main() -> int:
    if os.geteuid() != 0:
        raise SystemExit("ankay-opensearch-tls: debe ejecutarse como root")
    if not os.path.ismount(ROOT) and not os.environ.get("ANKAY_DATA_ROOT"):
        raise SystemExit("ankay-opensearch-tls: /mnt/ankay no está montado")
    ensure_dir(ROOT / "opensearch", OPENSEARCH_UID, OPENSEARCH_UID, 0o750)
    ensure_dir(ROOT / "files", SHUFFLE_UID, SHUFFLE_UID, 0o750)
    tls = ROOT / "opensearch-tls"
    ensure_dir(tls, 0, 0, 0o755)
    ensure_dir(tls / "private", 0, 0, 0o700)
    ensure_dir(tls / "node", OPENSEARCH_UID, OPENSEARCH_UID, 0o750)
    ensure_dir(tls / "ca", 0, 0, 0o755)
    if not (tls / "node" / "node.pem").exists():
        generate(tls)
        log("CA y certificado de nodo creados en el disco persistente")
    for name in ("ca.pem", "node.pem", "node-key.pem"):
        path = tls / "node" / name
        os.chown(path, OPENSEARCH_UID, OPENSEARCH_UID)
        os.chmod(path, 0o400 if name == "node-key.pem" else 0o444)
    os.chmod(tls / "ca" / "ca.pem", 0o444)
    os.chmod(tls / "private" / "ca-key.pem", 0o400)
    log("directorios y permisos verificados")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
