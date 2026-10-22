#!/usr/bin/python3
"""Mount Ankay LUN 0, formatting only a positively verified empty Azure disk."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


DEVICE_LINK = pathlib.Path("/dev/disk/azure/scsi1/lun0")
MOUNT_PATH = pathlib.Path("/mnt/ankay")
COMPOSE_PATH = pathlib.Path("/etc/ankay/compose.yaml")
COMPOSE_HASH_PATH = pathlib.Path("/etc/ankay/compose.sha256")


def fail(message: str) -> None:
    print(f"ankay-disk-bootstrap: ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def probe(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def run(*args: str) -> str:
    result = probe(list(args))
    if result.returncode != 0:
        fail(f"comando requerido falló: {pathlib.Path(args[0]).name}")
    return result.stdout.strip()


def inspect_layout(device: str, expected_size: int) -> dict:
    if not DEVICE_LINK.is_symlink():
        fail("LUN 0 no es el enlace de dispositivo Azure esperado")
    try:
        info = os.stat(device)
    except OSError:
        fail("no se pudo inspeccionar el dispositivo Azure LUN 0")
    if not stat.S_ISBLK(info.st_mode):
        fail("LUN 0 no resuelve a un dispositivo de bloques")

    result = probe([
        "lsblk", "--json", "--paths", "--output",
        "NAME,TYPE,PKNAME,FSTYPE,UUID,PARTUUID,PTTYPE,MOUNTPOINTS", device,
    ])
    if result.returncode != 0:
        fail("no se pudo verificar la identidad y estructura de LUN 0")
    try:
        devices = json.loads(result.stdout).get("blockdevices", [])
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
        or disk.get("mountpoints") not in (None, [], [None], [str(MOUNT_PATH)])
    ):
        fail("LUN 0 no es un disco sin particiones ni montajes")

    size = probe(["blockdev", "--getsize64", device])
    if size.returncode != 0 or size.stdout.strip() != str(expected_size):
        fail("el tamaño de LUN 0 no coincide con el disco Ankay declarado")
    return disk


def filesystem_type(device: str) -> str | None:
    result = probe(["blkid", "-p", "-o", "export", device])
    if result.returncode == 2 and not result.stdout.strip():
        return None
    if result.returncode != 0:
        fail("blkid no pudo identificar LUN 0 de forma segura")
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return fields.get("TYPE")


def initialize_if_blank(device: str, expected_size: int) -> None:
    fs_type = filesystem_type(device)
    if fs_type is not None:
        if fs_type != "ext4":
            fail("LUN 0 contiene un formato distinto de ext4; no se modificó")
        return

    signatures = probe(["wipefs", "-n", device])
    if signatures.returncode != 0 or signatures.stdout.strip():
        fail("LUN 0 contiene firmas desconocidas; se detuvo sin formatearlo")
    zeros = probe(["cmp", "--silent", f"--bytes={expected_size}", device, "/dev/zero"])
    if zeros.returncode == 1:
        fail("LUN 0 contiene datos aunque no tenga firmas; se detuvo sin formatearlo")
    if zeros.returncode != 0:
        fail("no se pudo confirmar que LUN 0 esté completamente vacío")

    print("ankay-disk-bootstrap: LUN 0 verificado vacío; se crea ext4", flush=True)
    run("mkfs.ext4", "-F", "-L", "ankay-data", device)
    if filesystem_type(device) != "ext4":
        fail("no se pudo confirmar ext4 después de inicializar LUN 0")


def mount_data(device: str) -> str:
    uuid = run("blkid", "-s", "UUID", "-o", "value", device)
    if not uuid:
        fail("no se pudo leer el UUID ext4 de LUN 0")
    MOUNT_PATH.mkdir(mode=0o750, parents=True, exist_ok=True)

    mounted = probe(["mountpoint", "-q", str(MOUNT_PATH)])
    if mounted.returncode == 0:
        source = run("findmnt", "-n", "-o", "SOURCE", "--target", str(MOUNT_PATH)).split("[", 1)[0]
        if os.path.realpath(source) != device:
            fail("/mnt/ankay está montado desde otro dispositivo; no se alteró")
    elif mounted.returncode == 1:
        if any(MOUNT_PATH.iterdir()):
            fail("/mnt/ankay contiene datos locales que quedarían ocultos; no se montó")
        fstab = pathlib.Path("/etc/fstab")
        lines = fstab.read_text(encoding="utf-8").splitlines()
        entries = [
            line.split() for line in lines
            if line.strip() and not line.lstrip().startswith("#")
            and len(line.split()) >= 2 and line.split()[1] == str(MOUNT_PATH)
        ]
        desired = f"UUID={uuid} {MOUNT_PATH} ext4 defaults,nofail 0 2"
        if entries and any(entry[:2] != [f"UUID={uuid}", str(MOUNT_PATH)] for entry in entries):
            fail("/etc/fstab ya asigna /mnt/ankay a otro origen; requiere revisión")
        if not entries:
            with fstab.open("a", encoding="utf-8") as stream:
                stream.write(desired + "\n")
        run("mount", str(MOUNT_PATH))
        source = run("findmnt", "-n", "-o", "SOURCE", "--target", str(MOUNT_PATH)).split("[", 1)[0]
        if os.path.realpath(source) != device:
            fail("/mnt/ankay no quedó montado desde el LUN 0 esperado")
    else:
        fail("no se pudo comprobar el estado de montaje de /mnt/ankay")
    return uuid


def verify_compose() -> None:
    expected = COMPOSE_HASH_PATH.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        fail("el SHA-256 de Compose no es válido")
    digest = hashlib.sha256(COMPOSE_PATH.read_bytes()).hexdigest()
    if digest != expected:
        fail("el SHA-256 del Compose no coincide")


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        fail("falta el tamaño esperado del disco Ankay")
    expected_size = int(sys.argv[1]) * 1024**3
    device = os.path.realpath(str(DEVICE_LINK))
    inspect_layout(device, expected_size)
    initialize_if_blank(device, expected_size)
    mount_data(device)
    for path in ("opensearch", "apps", "files"):
        (MOUNT_PATH / path).mkdir(mode=0o750, parents=True, exist_ok=True)
    verify_compose()
    print("ankay-disk-bootstrap: disco montado; Compose verificado; servicios no iniciados", flush=True)


if __name__ == "__main__":
    main()
