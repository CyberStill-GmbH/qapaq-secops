#!/bin/sh
# QAPAQ SecOps · visibilidad de conexiones de red para el command monitoring de Wazuh
# (docs/18-visibilidad-de-red-y-capacidades-wazuh.md).
#
# Fuente: wazuh/manager/policy/shared/linux-servers/qapaq-netconn.sh; se distribuye con el grupo linux-servers y lo ejecuta
# wazuh-logcollector como root desde el agent.conf del grupo:
#
#   sh etc/shared/qapaq-netconn.sh listen   → foto ordenada de los puertos en escucha (TCP/UDP) con el
#                                           proceso dueño; alias "netstat listening ports" para que la
#                                           regla oficial 533 (check_diff) avise de cualquier cambio.
#   sh etc/shared/qapaq-netconn.sh events   → una línea por puerto en escucha o conexión TCP establecida
#                                           NUEVA respecto a la ejecución anterior (estado en
#                                           /var/ossec/tmp/qapaq-netconn). La primera ejecución emite el
#                                           inventario completo de escuchas. Formato (decoder qapaq-netconn):
#     type=listen dir=listen proto=tcp src=0.0.0.0 sport=0 dst=0.0.0.0 dport=22 proc=sshd uid=0
#     type=conn dir=out proto=tcp src=10.89.0.12 sport=51234 dst=198.51.100.9 dport=443 proc=curl uid=1000
#
# Sin dependencias fuera de iproute2 (ss) y awk. No guarda PIDs (cambian y generarían diferencias falsas).
# Límite de 200 líneas por ejecución para no inundar al manager (se informa con type=truncated).
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mode="${1:-events}"
max_lines="${QAPAQ_NETCONN_MAX_LINES:-200}"
state_dir="${QAPAQ_NETCONN_STATE:-/var/ossec/tmp/qapaq-netconn}"

if ! command -v ss >/dev/null 2>&1; then
  echo "type=error dir=none proto=none src=0.0.0.0 sport=0 dst=0.0.0.0 dport=0 proc=ss-no-disponible uid=0"
  exit 0
fi

# Normaliza la salida de `ss -H ... -p -e` a: proto local_ip local_port peer_ip peer_port proc uid
# (las columnas cambian entre versiones de ss y según los filtros: se buscan por forma, no por posición).
normalize() { # normalize <proto>
  awk -v proto="$1" '
    function host(a,  h) { h = a; sub(/:[^:]*$/, "", h); gsub(/^\[|\]$/, "", h); sub(/%.*/, "", h)
                           sub(/^::ffff:/, "", h); if (h == "*") h = "0.0.0.0"; return h }
    function port(a,  q) { q = a; sub(/.*:/, "", q); if (q == "*") q = "0"; return q }
    {
      l = ""; p = ""; proc = "-"; uid = 0
      for (i = 1; i <= NF; i++) {
        f = $i
        if (f ~ /^users:/) {
          if (match(f, /"[^"]+"/)) proc = substr(f, RSTART + 1, RLENGTH - 2)
        } else if (f ~ /^uid:[0-9]+$/) {
          uid = substr(f, 5)
        } else if (f ~ /:[0-9*]+$/ && f !~ /^(ino|sk|cgroup|timer|v6only|uid|bpf):/) {
          if (l == "") l = f; else if (p == "") p = f
        }
      }
      if (l == "") next
      gsub(/[^A-Za-z0-9._@+-]/, "_", proc)
      print proto, host(l), port(l), (p == "" ? "0.0.0.0" : host(p)), (p == "" ? "0" : port(p)), proc, uid
    }'
}

listeners() {
  { ss -H -ltn -p -e 2>/dev/null | normalize tcp; ss -H -lun -p -e 2>/dev/null | normalize udp; } | sort -u
}

case "$mode" in
  listen)
    # Foto para la regla 533: "proto dirección:puerto proceso", ordenada y sin PIDs.
    listeners | awk '{ printf "%s %s:%s %s\n", $1, $2, $3, $6 }' | sort -u
    ;;
  events)
    umask 077
    mkdir -p "$state_dir" 2>/dev/null || exit 0
    cur="$state_dir/current.$$"
    first=0
    [ -f "$state_dir/seen" ] || first=1
    lports="$(listeners | awk '$1 == "tcp" { print $3 }' | sort -u | tr '\n' ' ')"
    {
      # Escuchas: clave proto|dirección|puerto|proceso.
      listeners | awk '{ printf "L|%s|%s|%s|%s|%s\n", $1, $2, $3, $6, $7 }'
      # Conexiones TCP establecidas (sin loopback). Entrante si el puerto local está en escucha.
      ss -H -tn -p -e state established 2>/dev/null | normalize tcp | awk -v lp=" $lports " '
        $2 ~ /^127\./ || $2 == "::1" { next }
        $4 ~ /^127\./ || $4 == "::1" { next }
        { dir = (index(lp, " " $3 " ") > 0) ? "in" : "out"
          # Clave sin el puerto efímero: entrante = remoto+puerto local; saliente = remoto+puerto remoto.
          if (dir == "in") printf "C|in|%s|%s|%s|%s|%s|%s|%s\n", $1, $4, $5, $2, $3, $6, $7
          else             printf "C|out|%s|%s|%s|%s|%s|%s|%s\n", $1, $2, $3, $4, $5, $6, $7 }'
    } | sort -u >"$cur"

    # Clave de deduplicación (sin puertos efímeros) → solo se emite lo nuevo.
    awk -F'|' '
      $1 == "L" { print "L|" $2 "|" $3 "|" $4 "|" $5; next }
      $2 == "in" { print "C|in|" $4 "|" $7 "|" $8; next }
      { print "C|out|" $6 "|" $7 "|" $8 }' "$cur" | sort -u >"$cur.keys"
    if [ "$first" = 1 ]; then
      : >"$state_dir/seen"
    fi
    n=0
    while IFS='|' read -r kind a b c d e f g h; do
      case "$kind" in
        L) key="L|$a|$b|$c|$d" ;;
        C) if [ "$a" = in ]; then key="C|in|$c|$f|$g"; else key="C|out|$e|$f|$g"; fi ;;
        *) continue ;;
      esac
      grep -qxF "$key" "$state_dir/seen" && continue
      # Primera ejecución: inventario de escuchas, pero no de conexiones (serían todas "nuevas").
      if [ "$first" = 1 ] && [ "$kind" = C ]; then continue; fi
      n=$((n + 1))
      if [ "$n" -gt "$max_lines" ]; then
        echo "type=truncated dir=none proto=none src=0.0.0.0 sport=0 dst=0.0.0.0 dport=0 proc=qapaq-netconn uid=0"
        break
      fi
      if [ "$kind" = L ]; then
        echo "type=listen dir=listen proto=$a src=0.0.0.0 sport=0 dst=$b dport=$c proc=$d uid=$e"
      elif [ "$a" = in ]; then
        # C|in|proto|remote_ip|remote_port|local_ip|local_port|proc|uid
        echo "type=conn dir=in proto=$b src=$c sport=$d dst=$e dport=$f proc=$g uid=$h"
      else
        # C|out|proto|local_ip|local_port|remote_ip|remote_port|proc|uid
        echo "type=conn dir=out proto=$b src=$c sport=$d dst=$e dport=$f proc=$g uid=$h"
      fi
    done <"$cur"
    # El estado es la foto actual: una conexión que desaparece y vuelve se informa de nuevo.
    mv -f "$cur.keys" "$state_dir/seen"
    rm -f "$cur"
    ;;
  *)
    echo "uso: $0 listen|events" >&2
    exit 2
    ;;
esac
exit 0
