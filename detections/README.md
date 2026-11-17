# detections/ · Detección como código de QAPAQ SecOps

Programa: [docs/17-ingenieria-de-deteccion.md](../docs/17-ingenieria-de-deteccion.md) · Ciclo y estándar:
[docs/detection-engineering/01](../docs/detection-engineering/01-ciclo-de-vida.md).

```text
detections/
├── catalog.yaml                  rangos de IDs, fuentes, archivos canónicos, suites, listas y refinamientos
├── mitre/attack-qapaq.json         técnicas ATT&CK usadas + prioridades del entorno QAPAQ (análisis de brechas)
├── reports/mitre-coverage.{md,json}   generado por `qapaq_detections.py coverage` (no editar)
├── tools/
│   ├── qapaq_detections.py         lint · coverage · check-logtest · bundle · cases
│   ├── test-in-container.sh      todas las suites en un Wazuh 4.14.8 desechable (CI y host)
│   └── deploy-detections.sh      instalación en el manager con respaldo, analysisd -t, reinicio y rollback
└── <fuente>/<caso-de-uso>/
    ├── metadata.yaml             estándar de metadatos (siempre)
    ├── rule.xml                  solo reglas nuevas del programa → etc/rules/qapaq_soc_<fuente>_<caso>.xml
    ├── fixtures.jsonl            eventos sintéticos (RFC 5737, dominios .example) para wazuh-logtest
    ├── expected.txt              regla esperada por línea (`!id` = no debe ser; `0`/`none` = sin alerta)
    └── lists/                    ejemplo de lista CDB si la regla la usa
```

Las reglas que ya existían **no se mueven** (las instalan scripts de otros owners y la CI las monta por ruta):
su `metadata.yaml` las referencia (`rules.file`) junto con su suite de prueba. Así el árbol es el índice único
de casos de uso sin romper despliegues.

| Fuente | Casos de uso | Reglas |
| --- | --- | --- |
| m365 | credential-attacks, bec-mailbox-persistence, audit-tampering, data-exfiltration, **compromise-chain** | 100502–100530, **101700–101703** |
| entra | **privileged-role-assignment**, app-consent-and-credentials, auth-methods-and-federation | 100520–100526, **101704** |
| aws | **cloudtrail-tampering**, **console-bruteforce-success** | **101710–101713** (+ paquete 101600–101699) |
| bitdefender | malware-and-protection, **protection-disabled-malware** | 101401–101411, **101720–101723** |
| snyk | vulnerabilities, **exposed-critical-exploit** | 101451–101458, **101730–101731** |
| cloudflare | audit-and-waf, **waf-attack-surge** | 101501–101513, **101740** |
| linux | **ssh-bruteforce-success**, **privileged-group-membership**, **persistence-fim** | **101750–101760** |
| windows / ad / launch | outlook-child-process, privileged-groups-and-policy, kerberos-attacks, normalized-provider-pack | 101100, 101300–101307, 101201–101215 |

En negrita, lo nuevo del programa (24 reglas). Todas las descripciones empiezan por `QAPAQ <Fuente>:`.

```bash
python3 detections/tools/qapaq_detections.py lint
bash detections/tools/test-in-container.sh            # requiere docker
sudo bash detections/tools/deploy-detections.sh --check   # en el host, solo muestra cambios
```
