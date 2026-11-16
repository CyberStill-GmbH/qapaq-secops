#!/usr/bin/env python3
"""QAPAQ SOC · listas CDB de reputación de IP para Wazuh, desde fuentes públicas gratuitas (docs/18).

Subcomandos:
  fetch --out DIR [--cache DIR] [--firehol] [--aws-regions us-east-1,GLOBAL] [--egress-static F]
      Descarga las fuentes y escribe en DIR las listas qapaq-ti-blocklist, qapaq-ti-tor y qapaq-egress-known.
      Si una fuente falla se usa su última copia buena del caché (y se avisa); si no hay copia, la lista
      sale sin esa fuente. Nunca escribe una lista vacía: deja un centinela .invalid (la API de Wazuh
      rechaza listas vacías).
  cloudflare --in RESPUESTA.json --out ARCHIVO [--min N]
      Convierte la agregación del indexer (IPs bloqueadas por el WAF de Cloudflare) en qapaq-cf-waf-attackers.
  expand CIDR...
      Muestra las claves CDB de cada red (para depurar).

Formato CDB de Wazuh con lookup address_match_key: la clave es una IP o un prefijo de OCTETOS terminado en
punto ("198.51.100." = /24, "198.51." = /16, "198." = /8). Un CIDR que no cae en un límite de octeto se
expande a los prefijos del octeto siguiente (un /22 son cuatro "/24"); más largo que /24, a IPs sueltas.
Solo IPv4: las claves CDB usan ":" como separador y no admiten IPv6.

Fuentes y licencias (verificadas 2026-11; ver docs/18 §Reputación):
  - Spamhaus DROP (drop_v4.json): uso libre, con atribución; máximo una descarga por hora (aquí: diaria).
  - abuse.ch Feodo Tracker, lista recomendada: CC0 (términos de abuse.ch §3.4).
  - Tor Project, lista de nodos de salida: datos públicos del Tor Project.
  - AWS ip-ranges.json: publicación oficial de AWS (solo para destinos de salida conocidos).
  - FireHOL level1 (opcional, --firehol): agregado de dshield, feodo, fullbogons y spamhaus_drop; los
    términos de DShield no son explícitos para uso comercial, por eso queda apagado por defecto.
Solo biblioteca estándar (Python 3.8+).
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import sys
import time
import urllib.request
from pathlib import Path

UA = "qapaq-soc-threat-intel/1.0 (+https://dev.security.qapaq.pe; soc@qapaq.pe)"
FEEDS = {
    "spamhaus-drop": "https://www.spamhaus.org/drop/drop_v4.json",
    "feodo": "https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt",
    "tor-exit": "https://check.torproject.org/torbulkexitlist",
    "aws-ranges": "https://ip-ranges.amazonaws.com/ip-ranges.json",
    "firehol-level1": "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset",
}
MAX_KEYS = 400_000  # tope de seguridad por lista (CDB de ~10 MB)


def log(msg: str) -> None:
    print(f"[qapaq-threat-intel] {msg}", file=sys.stderr)


def download(name: str, cache: Path | None, timeout: int = 60) -> str | None:
    url = FEEDS[name]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (URLs fijas https)
            body = resp.read(50_000_000).decode("utf-8", errors="replace")
        if cache:
            cache.mkdir(parents=True, exist_ok=True)
            (cache / f"{name}.txt").write_text(body, encoding="utf-8")
        log(f"{name}: descargado ({len(body)} bytes)")
        return body
    except Exception as exc:  # noqa: BLE001 (cualquier fallo de red cae al caché)
        cached = cache / f"{name}.txt" if cache else None
        if cached and cached.exists():
            age_h = (time.time() - cached.stat().st_mtime) / 3600
            log(f"AVISO {name}: {exc}; se usa el caché de hace {age_h:.0f} h")
            return cached.read_text(encoding="utf-8")
        log(f"AVISO {name}: {exc}; sin caché, la fuente queda fuera")
        return None


def cidr_keys(net: ipaddress.IPv4Network) -> list[str]:
    """Claves CDB (prefijos de octeto) que cubren exactamente la red."""
    p = net.prefixlen
    if p == 32:
        return [str(net.network_address)]
    if p > 24:
        return [str(ip) for ip in net]
    boundary = 8 if p <= 8 else 16 if p <= 16 else 24
    octets = boundary // 8
    return [".".join(str(net_sub.network_address).split(".")[:octets]) + "."
            for net_sub in net.subnets(new_prefix=boundary)]


def parse_networks(text: str, *, public_only: bool) -> list[ipaddress.IPv4Network]:
    nets = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].split(";", 1)[0].strip()
        if not line:
            continue
        token = line.split()[0]
        try:
            net = ipaddress.ip_network(token, strict=False)
        except ValueError:
            continue
        if net.version != 4:
            continue
        if public_only and not net.is_global:
            continue
        nets.append(net)
    return nets


def spamhaus(text: str) -> list[ipaddress.IPv4Network]:
    nets = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if "cidr" in obj:
            nets += parse_networks(obj["cidr"], public_only=True)
    return nets


def aws_ranges(text: str, regions: set[str]) -> list[ipaddress.IPv4Network]:
    data = json.loads(text)
    nets = []
    for p in data.get("prefixes", []):
        if p.get("region") in regions and p.get("service") in ("AMAZON", "EC2", "S3", "CLOUDFRONT"):
            nets.append(ipaddress.ip_network(p["ip_prefix"], strict=False))
    return list(ipaddress.collapse_addresses(nets))


def write_list(path: Path, entries: dict[str, set[str]], name: str) -> int:
    keys = sorted(entries, key=lambda k: [int(x) for x in k.rstrip(".").split(".")])
    if len(keys) > MAX_KEYS:
        raise SystemExit(f"{name}: {len(keys)} claves supera el tope {MAX_KEYS}; revisar las fuentes")
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        if not keys:
            fh.write(f"qapaq-sin-datos-{name}.invalid:placeholder\n")
        for k in keys:
            fh.write(f"{k}:{'+'.join(sorted(entries[k]))}\n")
    log(f"{name}: {len(keys)} claves")
    return len(keys)


def add(entries: dict[str, set[str]], nets, label: str) -> None:
    for net in nets:
        for key in cidr_keys(net):
            entries.setdefault(key, set()).add(label)


def cmd_fetch(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache) if args.cache else None

    block: dict[str, set[str]] = {}
    body = download("spamhaus-drop", cache)
    if body:
        add(block, spamhaus(body), "spamhaus-drop")
    body = download("feodo", cache)
    if body:
        add(block, parse_networks(body, public_only=True), "feodo")
    if args.firehol:
        body = download("firehol-level1", cache)
        if body:
            add(block, parse_networks(body, public_only=True), "firehol-level1")
    write_list(out / "qapaq-ti-blocklist", block, "qapaq-ti-blocklist")

    tor: dict[str, set[str]] = {}
    body = download("tor-exit", cache)
    if body:
        add(tor, parse_networks(body, public_only=True), "tor-exit")
    write_list(out / "qapaq-ti-tor", tor, "qapaq-ti-tor")

    egress: dict[str, set[str]] = {}
    body = download("aws-ranges", cache)
    if body:
        add(egress, aws_ranges(body, set(args.aws_regions.split(","))), "aws")
    if args.egress_static and Path(args.egress_static).exists():
        for raw in Path(args.egress_static).read_text(encoding="utf-8").splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            key, _, label = line.partition(":")
            label = label or "estatico"
            try:
                add(egress, [ipaddress.ip_network(key, strict=False)], label)
            except ValueError:
                if key.endswith("."):
                    egress.setdefault(key, set()).add(label)
    write_list(out / "qapaq-egress-known", egress, "qapaq-egress-known")
    return 0


def cmd_cloudflare(args) -> int:
    data = json.loads(Path(args.input).read_text(encoding="utf-8") or "{}")
    buckets = (((data.get("aggregations") or {}).get("ips") or {}).get("buckets")) or []
    entries: dict[str, set[str]] = {}
    for b in buckets:
        if b.get("doc_count", 0) < args.min:
            continue
        try:
            ip = ipaddress.ip_address(str(b.get("key")))
        except ValueError:
            continue
        if ip.version == 4 and ip.is_global:
            entries[str(ip)] = {f"cloudflare-waf-{b['doc_count']}"}
    write_list(Path(args.out), entries, "qapaq-cf-waf-attackers")
    return 0


def cmd_expand(args) -> int:
    for c in args.cidr:
        print(c, "->", " ".join(cidr_keys(ipaddress.ip_network(c, strict=False))))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--out", required=True)
    f.add_argument("--cache")
    f.add_argument("--firehol", action="store_true")
    f.add_argument("--aws-regions", default="us-east-1,GLOBAL")
    f.add_argument("--egress-static")
    c = sub.add_parser("cloudflare")
    c.add_argument("--in", dest="input", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--min", type=int, default=5)
    e = sub.add_parser("expand")
    e.add_argument("cidr", nargs="+")
    args = ap.parse_args(argv)
    return {"fetch": cmd_fetch, "cloudflare": cmd_cloudflare, "expand": cmd_expand}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
