# Perfil QAPAQ de detección para Active Directory

Estado: **candidate/disabled**. Reglas y perfiles están versionados para revisión; no
se instalan en el bundle ni se aplican a agentes o dominios. Se limita a observación:
no configura Active Response, aislamiento, bloqueo o cambios de identidad.

## Cobertura

`rules/qapaq_active_directory_rules.xml` reserva IDs `101300–101307` y depende de
los decoders/reglas Windows de Wazuh 4.14.x:

| ID QAPAQ | Señal                                                  | Requisito/precaución                                                                                                                                          |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 101300   | Miembro añadido a grupo privilegiado conocido          | Eventos 4728/4732/4756; SID integrado para evitar nombres localizados. No cubre grupos delegados propios: añadir sus SIDs con revisión del dueño del dominio. |
| 101301   | Cambio a política de auditoría                         | Evento 4719; regla base 60112.                                                                                                                                |
| 101302   | Limpieza de Security log                               | Evento 1102; preservar evidencia del host antes de remediar.                                                                                                  |
| 101303   | Cambio a AdminSDHolder o GPO                           | Eventos 5136/5137/5141; requiere Directory Service Changes y SACLs.                                                                                           |
| 101304   | Ticket Kerberos de servicio con RC4                    | Evento 4769; hunting nivel 5. RC4 legado no es por sí solo Kerberoasting.                                                                                     |
| 101305   | TGT emitido sin preautenticación                       | Evento 4768; revisar cuentas legacy aprobadas y otros campos antes de escalar.                                                                                |
| 101306   | Acceso de replicación de directorio candidato a DCSync | Evento 4662 y GUIDs de replicación; nivel moderado porque la replicación legítima genera la misma señal.                                                      |
| 101307   | Fallo de preautenticación Kerberos                     | Evento 4771; requiere correlación por identidad/origen/ventana para clasificar spray.                                                                         |

Además, se mantienen las reglas base Wazuh para cuentas creadas/habilitadas (4720,
4722; 60109), cambios de cuenta y grupos (60110–60114), bloqueo (4740; 60115),
fallos y éxitos de autenticación (60105/60106). Evitamos duplicarlas; el SOC debe
correlacionar los eventos base con identidad, origen, criticidad del activo y ventana.

El perfil `agent-groups/windows-domain-controller.agent.conf` añade solo la etiqueta
`qapaq_profile=active-directory-pilot`, sin canales adicionales: el grupo Windows
base ya recoge `Security` y `System`, y las reglas AD consumen `Security`. Se excluyen
los canales `Directory Service`, DNS Server y Group Policy porque no tienen una regla QAPAQ consumidora
vigente. La matriz exacta está en `profile-catalog.json`.

| Fuente / canal                        | Event IDs mapeados                                                     | Dataset/campos Wazuh                                                                              | Reglas existentes                                                       | Decisión de recolección                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Security · `Security`         | 4728, 4732, 4756; 4719; 1102; 5136, 5137, 5141; 4769; 4768; 4662; 4771 | `wazuh-alerts-*`; `win.system.channel=Security`, `win.system.eventID`                             | QAPAQ 101300–101307; el detalle evento→regla está en la tabla Cobertura | Ya lo recoge el Windows base para conservar el ruleset upstream; el perfil DC no crea un duplicado ni filtra otros eventos existentes.                                                                                     |
| Windows System · `System`             | 7045                                                                   | `wazuh-alerts-*`; `win.system.channel=System`, `win.system.eventID`                               | Wazuh upstream 61138 (Wazuh 4.14.8)                                     | Heredado del Windows base; no duplicar.                                                                                                                                                                                    |
| Directory Service                     | —                                                                      | No se recoge en este candidato                                                                    | Ninguna regla actual; los eventos 5136/5137/5141 llegan por `Security`  | Excluido hasta que exista caso de uso, regla consumidora y validación de volumen.                                                                                                                                          |
| PowerShell Operational                | —                                                                      | No se recoge                                                                                      | Ninguna regla AD QAPAQ actual consume este canal                        | Excluido por minimización: eventos de scripts/módulos pueden incluir contenido y el evento 400 puede incluir argumentos de `HostApplication`. No habilitar 4103/4104 sin aprobación de privacidad y protección de eventos. |
| Sysmon Operational                    | 1 (Process Create)                                                     | `wazuh-alerts-*`; `win.system.channel=Microsoft-Windows-Sysmon/Operational`, `win.system.eventID` | QAPAQ endpoint 101100                                                   | Perfil separado y disabled; Event ID 1 puede incluir command line. Requiere aprobación de privacidad/retención y revisar la configuración Sysmon antes de asignarlo.                                                       |
| DNS Server / Group Policy Operational | —                                                                      | No se recoge en este candidato                                                                    | Ninguna regla QAPAQ vigente                                             | Excluidos hasta que una detección aprobada consuma señales específicas.                                                                                                                                                    |

La configuración base `windows-pilot.agent.conf` conserva `Security` y `System`
sin filtros para no perder detecciones upstream fuera de este paquete. Se quitó su
recolección PowerShell sin filtro. El candidato de Sysmon queda separado y no se
activa con la instalación de reglas. Asignar grupos que duplican una misma fuente
podría duplicar eventos; el operador debe confirmar la composición efectiva antes
de un piloto. `profile-catalog.json` enumera las reglas padre upstream (601xx) para
cada evento que usa una regla QAPAQ y fija el único ID upstream adicional de este
mapa (61138) a Wazuh v4.14.8.

## Política de auditoría del DC

Configurar mediante GPO dedicada para Domain Controllers, siguiendo el estándar
aprobado del dominio y probando antes en un DC piloto:

- **Account Logon:** Credential Validation, Kerberos Authentication Service y
  Kerberos Service Ticket Operations (success/failure según el subcomponente).
- **Account Management:** User, Computer, Security Group y Distribution Group
  Management (success y failure).
- **Logon/Logoff:** Logon (success/failure), Special Logon (success), Account
  Lockout y Group Membership (success/failure).
- **Policy Change:** Audit Policy Change y Authentication Policy Change (success/failure).
- **DS Access:** Directory Service Changes (success/failure) y Directory Service
  Access solo con SACLs específicas para objetos de alto valor. 4662 sin SACL
  específica puede generar ruido y costo de ingestión.
- **System:** Security System Extension, System Integrity y Security State Change.

Validar los GUIDs/campos del evento 4662 con un evento de laboratorio del sistema
objetivo. Excluir las identidades de replicación autorizadas solo después de
inventariar sus SID, origen y necesidad; no crear allowlists amplias en las reglas.
El perfil no habilita PowerShell Script Block Logging ni el registro de línea de
comandos para evitar exponer argumentos sensibles sin una decisión de privacidad.
Sysmon no es requisito para estas reglas; su perfil se gestiona separadamente.

## Despliegue y rollback

1. Confirmar versión exacta del Manager, IDs existentes y configuración vigente del
   agente; instalar la regla local en un Manager aislado/piloto, sin modificar el
   ruleset upstream.
2. Asegurar que el archivo esté incluido una sola vez en el ruleset activo; ejecutar
   `wazuh-analysisd -t` y el `wazuh-logtest` fijado a `wazuh/wazuh-manager:4.14.8`.
3. Revisar volúmenes/FP de 101304, 101305, 101306 y 101307 en modo observación antes
   de asignar severidad operativa o automatización. No importar las reglas a producción
   desde este repo hasta disponer de aprobación del dueño del dominio y evidencia.
4. Antes de asignar cualquier agent group, confirmar que `profile-catalog.json` siga
   en `candidate-disabled`, que el DC no tenga grupos duplicados y que se aprobaron
   privacidad, retención y volumen. El bundle solo adjunta los perfiles como archivos
   de referencia; su instalador no los copia a `/var/ossec/etc/shared` ni los aplica.
5. Para rollback, retirar solo la referencia local QAPAQ y el perfil de grupo piloto;
   validar `wazuh-analysisd -t`, recargar según el procedimiento controlado del Manager
   y comprobar que la colección upstream sigue activa.

## Pruebas

```bash
docker run --detach --rm --name qapaq-wazuh-ad-test \
  --ulimit nofile=458752:458752 \
  --volume "$PWD/infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml:/var/ossec/etc/rules/qapaq_active_directory_rules.xml:ro" \
  wazuh/wazuh-manager:4.14.8
docker exec qapaq-wazuh-ad-test sed -i \
  -e '/<category>ossec<\/category>/d' \
  -e 's|<decoded_as>windows_eventchannel</decoded_as>|<decoded_as>json</decoded_as>|' \
  /var/ossec/ruleset/rules/0575-win-base_rules.xml
docker exec qapaq-wazuh-ad-test /var/ossec/bin/wazuh-control start
bash infra/wazuh/active-directory/tests/run-logtest.sh qapaq-wazuh-ad-test
python -m unittest discover -s infra/wazuh/active-directory/tests -p 'test_profile_catalog.py' -v
docker rm -f qapaq-wazuh-ad-test
```

Fixtures `.example`/RFC 5737 sintéticas cubren positivos y negativos cercanos. Pasar
`logtest` demuestra evaluación del ruleset en ese contenedor; no prueba recepción
de eventos de un tenant, exactitud del formato de un DC real, ni falsos positivos
operativos. Esta config no fue aplicada a Azure ni a ningún Manager.

## Fuentes primarias

- [Wazuh 4.14.8 ruleset Windows Security](https://github.com/wazuh/wazuh/tree/v4.14.8/ruleset/rules)
- [Wazuh 4.14.8 Windows System rule 61138](https://github.com/wazuh/wazuh/blob/v4.14.8/ruleset/rules/0590-win-system_rules.xml)
- [Wazuh Windows event-channel filters](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/configuration.html#monitoring-specific-events-from-windows-event-channel)
- [Wazuh centralized agent configuration](https://documentation.wazuh.com/current/user-manual/reference/centralized-configuration.html)
- [Wazuh: reglas personalizadas](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html)
- [Wazuh: probar decoders y reglas](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)
- [Microsoft: auditoría de seguridad de Windows](https://learn.microsoft.com/windows/security/threat-protection/auditing/basic-audit-policy-recommendations)
- [Microsoft: auditoría de cambios de servicio de directorio](https://learn.microsoft.com/windows/security/threat-protection/auditing/audit-directory-service-changes)
- [Microsoft: PowerShell logging y contenido sensible de Script Block Logging](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_logging?view=powershell-5.1)
- [CERT-EU: PowerShell security guidance, event 400/403](https://cert.europa.eu/publications/security-guidance/CERT-EU-SWP2019-001/pdf)
- [MITRE ATT&CK: DCSync](https://attack.mitre.org/techniques/T1003/006/)
- [MITRE ATT&CK: Kerberoasting](https://attack.mitre.org/techniques/T1558/003/)
