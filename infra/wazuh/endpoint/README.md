# Detecciones endpoint QAPAQ sobre Wazuh

**Estado: candidata; todavía no instalada en Manager ni observada en endpoints QAPAQ.**

Este paquete incorpora una adaptación acotada de la idea de SigmaHQ “Suspicious Outlook
Child Process” (UUID `208748f7-881d-47ac-a29c-07ea84bf691d`) para Wazuh 4.14.x. Busca
un evento Sysmon Process Create (Event ID 1) donde Outlook inicia un intérprete o
binario de ejecución de riesgo. Se excluye `rundll32.exe` porque Sigma documenta falsos
positivos conocidos para ese hijo. Se emite nivel 8 para triage humano: por sí sola,
la alerta no confirma phishing ni compromiso.

La regla local `101100` utiliza el grupo oficial `sysmon_event1` que publica el ruleset
de Wazuh (regla base 61603). Requiere que Sysmon Event ID 1 llegue al Manager y que el
evento incluya `win.eventdata.parentImage` y `win.eventdata.image`. No activar la regla
si la telemetría no existe. Este paquete no añade Sysmon a los endpoints ni cambia su
política.

## Reducción de falsos positivos

- Correlaciona padre e hijo en el mismo evento de creación de proceso; no alerta solo
  por PowerShell, script hosts o actividad normal de Outlook.
- Mantiene una lista corta de hijos de alto riesgo y omite `rundll32.exe` por el caso
  de impresión/fotos documentado por Sigma.
- No excluye por usuario, dominio, IP, firma o ruta sin evidencia del entorno.
- Los fixtures prueban Outlook→PowerShell y Outlook→MSHTA, junto con Outlook→Chrome y
  Explorer→PowerShell como negativos cercanos.
- La severidad y el volumen se deben observar por clase de activo antes de elevarla.
  Excepciones futuras requieren regla/actor/activo concretos, owner y vencimiento.

## Verificación y uso

`tests/run-logtest.sh` valida la configuración del Manager y compara la salida de
`wazuh-logtest` con los resultados esperados. Como el decoder EventChannel nativo no se
prueba directamente con `wazuh-logtest`, el workflow monta
`tests/0000-sysmon-fixture-decoder.xml`, un puente de decoder exclusivo del contenedor efímero
de CI. Ese puente normaliza los fixtures JSON con una regla base de nivel 1. CI verifica
que la regla de producción conserva su grupo `sysmon_event1` y cambia ese vínculo por
`if_sid` solo en una copia temporal, porque `wazuh-logtest` no reproduce el decoder
EventChannel nativo. Así los fixtures prueban los campos y patrones positivos/negativos
de la regla real, sin instalar el puente ni modificar el overlay de producción. El
workflow de GitHub Actions usa
`wazuh/wazuh-manager:4.14.8`, la misma
versión base del Dashboard QAPAQ fijado para el despliegue actual. Una prueba verde verifica sintaxis y
comportamiento con fixtures sintéticos; no acredita cobertura de Sysmon ni tasa de
falsos positivos en endpoints reales.

La regla aún no está cableada al forwarder Wazuh→Ankay: el adaptador actual solo eleva
alertas desde nivel 12. No reducir ese umbral global por esta regla. El paso posterior
es admitirla mediante un caso QAPAQ y un allowlist versionado, después de validar el
contrato de eventos y volumen; el playbook correspondiente es de triage read-only.

## Procedencia y licencia

- SigmaHQ, `proc_creation_win_office_outlook_susp_child_processes.yml`, UUID
  `208748f7-881d-47ac-a29c-07ea84bf691d`, status `test`, level `high`; autores:
  Michael Haag, Florian Roth, Markus Neis, Elastic y FPT.EagleEye Team.
- Adaptación manual de condiciones; no es un archivo Sigma ni una traducción automática.
- Conservar origen, UUID, fecha de revisión y texto de licencia según la DRL 1.1 al
  redistribuir derivaciones de reglas Sigma.
- No copiar/instalar el ruleset oficial dentro de `ruleset/`; Wazuh recomienda mantener
  las personalizaciones bajo `/var/ossec/etc/` y probarlas con `wazuh-logtest`.

## Fuentes

- https://github.com/SigmaHQ/sigma/blob/master/rules/windows/process_creation/proc_creation_win_office_outlook_susp_child_processes.yml
- https://github.com/SigmaHQ/Detection-Rule-License
- https://github.com/wazuh/wazuh-ruleset/blob/master/rules/0595-win-sysmon_rules.xml
- https://documentation.wazuh.com/current/user-manual/ruleset/testing.html
- https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html
