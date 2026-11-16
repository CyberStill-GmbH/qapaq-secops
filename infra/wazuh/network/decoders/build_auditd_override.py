#!/usr/bin/env python3
"""QAPAQ SOC · genera etc/decoders/qapaq_auditd_decoders.xml a partir del 0040-auditd_decoders.xml del manager.

Los decoders hermanos (mismo nombre) solo se encadenan dentro del archivo del ruleset: uno agregado en otro
archivo no se aplica. Para que los eventos de auditd traigan la IP del registro SOCKADDR enriquecido
(`SADDR={ saddr_fam=inet laddr=… lport=… }`) como dstip/dstport, se copia el archivo oficial, se inserta
este hermano después del último `auditd-syscall` y el original se excluye con
`<decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>` (mecanismo documentado de
Wazuh para modificar decoders oficiales). Se regenera en cada despliegue desde el archivo del manager, así
que sigue a las actualizaciones de Wazuh. Uso: build_auditd_override.py <0040 original> <salida>
"""

import re
import sys
from pathlib import Path

SIBLING = """
<!-- QAPAQ SOC (docs/18): dirección remota de connect()/bind()/accept() en el registro SOCKADDR enriquecido
     de auditd 3.x (log_format = ENRICHED). Insertado por infra/wazuh/network/decoders/build_auditd_override.py. -->
<decoder name="auditd-syscall">
  <parent>auditd</parent>
  <regex>saddr_fam=(\\S+) laddr=(\\S+) lport=(\\d+)</regex>
  <order>audit.qapaq.family,dstip,dstport</order>
</decoder>
"""


def main(src: str, dst: str) -> int:
    text = Path(src).read_text(encoding="utf-8")
    blocks = list(re.finditer(r'<decoder name="auditd-syscall">.*?</decoder>\n', text, flags=re.S))
    if not blocks:
        sys.exit("no se encontró ningún decoder auditd-syscall en " + src)
    end = blocks[-1].end()
    out = (f"<!-- Copia de {Path(src).name} del manager con un decoder QAPAQ agregado; no editar a mano. -->\n"
           + text[:end] + SIBLING + text[end:])
    Path(dst).write_text(out, encoding="utf-8", newline="\n")
    print(f"{dst}: {len(blocks)} hermanos auditd-syscall oficiales + 1 QAPAQ")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
