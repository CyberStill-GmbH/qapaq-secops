# Perfil QAPAQ de detección para Active Directory

Estado: **configuración candidata versionada, no instalada ni aplicada a un dominio**.
El paquete separa las reglas locales QAPAQ de la configuración de recolección de DC.
Se limita a observación; no configura Active Response, aislamiento, bloqueo o cambios
de identidad.

## Cobertura

`rules/qapaq_active_directory_rules.xml` reserva IDs `101300–101307` y depende de
los decoders/reglas Windows de Wazuh 4.14.x:

| ID QAPAQ | Señal | Requisito/precaución |
|---|---|---|
| 101300 | Miembro añadido a grupo privilegiado conocido | Eventos 4728/4732/4756; SID integrado para evitar nombres localizados. No cubre grupos delegados propios: añadir sus SIDs con revisión del dueño del dominio. |
| 101301 | Cambio a política de auditoría | Evento 4719; regla base 60112. |
| 101302 | Limpieza de Security log | Evento 1102; preservar evidencia del host antes de remediar. |
| 101303 | Cambio a AdminSDHolder o GPO | Eventos 5136/5137/5141; requiere Directory Service Changes y SACLs. |
| 101304 | Ticket Kerberos de servicio con RC4 | Evento 4769; hunting nivel 5. RC4 legado no es por sí solo Kerberoasting. |
| 101305 | TGT emitido sin preautenticación | Evento 4768; revisar cuentas legacy aprobadas y otros campos antes de escalar. |
| 101306 | Acceso de replicación de directorio candidato a DCSync | Evento 4662 y GUIDs de replicación; nivel moderado porque la replicación legítima genera la misma señal. |
| 101307 | Fallo de preautenticación Kerberos | Evento 4771; requiere correlación por identidad/origen/ventana para clasificar spray. |

Además, se mantienen las reglas base Wazuh para cuentas creadas/habilitadas (4720,
4722; 60109), cambios de cuenta y grupos (60110–60114), bloqueo (4740; 60115),
fallos y éxitos de autenticación (60105/60106). Evitamos duplicarlas; el SOC debe
correlacionar los eventos base con identidad, origen, criticidad del activo y ventana.

El perfil `agent-groups/windows-domain-controller.agent.conf` complementa el grupo
Windows piloto existente (que ya recoge Security y System) con Directory Service,
DNS Server, Group Policy y PowerShell Operational. Aplicarlo solo al grupo central
de Domain Controllers, como merge con la configuración central vigente. Evita
asignar más de un grupo que colecte los mismos canales. La existencia/retención de
cada canal y su volumen deben comprobarse primero en un DC piloto.

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
4. Para rollback, retirar solo la referencia local QAPAQ y el perfil de grupo piloto;
   validar `wazuh-analysisd -t`, recargar según el procedimiento controlado del Manager
   y comprobar que la colección upstream sigue activa.

## Pruebas

```bash
docker run --detach --rm --name qapaq-wazuh-ad-test wazuh/wazuh-manager:4.14.8
bash infra/wazuh/active-directory/tests/run-logtest.sh qapaq-wazuh-ad-test
docker rm -f qapaq-wazuh-ad-test
```

Fixtures `.example`/RFC 5737 sintéticas cubren positivos y negativos cercanos. Pasar
`logtest` demuestra evaluación del ruleset en ese contenedor; no prueba recepción
de eventos de un tenant, exactitud del formato de un DC real, ni falsos positivos
operativos. Esta config no fue aplicada a Azure ni a ningún Manager.

## Fuentes primarias

- [Wazuh 4.14.8 ruleset Windows Security](https://github.com/wazuh/wazuh/tree/v4.14.8/ruleset/rules)
- [Wazuh: reglas personalizadas](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html)
- [Wazuh: probar decoders y reglas](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)
- [Microsoft: auditoría de seguridad de Windows](https://learn.microsoft.com/windows/security/threat-protection/auditing/basic-audit-policy-recommendations)
- [Microsoft: auditoría de cambios de servicio de directorio](https://learn.microsoft.com/windows/security/threat-protection/auditing/audit-directory-service-changes)
- [MITRE ATT&CK: DCSync](https://attack.mitre.org/techniques/T1003/006/)
- [MITRE ATT&CK: Kerberoasting](https://attack.mitre.org/techniques/T1558/003/)
