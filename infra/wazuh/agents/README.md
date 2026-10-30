# Perfiles y despliegue de agentes Wazuh QAPAQ

**Estado: candidato para piloto.** Validado en CI con `verify-agent-conf` de Wazuh 4.14.8; no
instalado en el manager ni en equipos de QAPAQ.

- `shared/<grupo>/agent.conf`: ocho perfiles por clase de activo (misma estructura que
  `/var/ossec/etc/shared/`). Un agente pertenece a un solo perfil.
- `apply-agent-groups.sh`: crea los grupos en el manager e instala cada `agent.conf` con
  respaldo y `verify-agent-conf`.
- `group-mapping.example.json`: asignación por OU o nombre (plantilla con `TO_BE_PROVIDED`).
- `deploy/`: manifiesto con hashes del agente 4.14.8 y Sysmon, instaladores Windows/Linux,
  rollback y reglas auditd. La contraseña de inscripción sale de Key Vault y nunca va en argv.
- `tools/verify_agent.py`: heartbeat, versión, grupo, inventario y SCA vía API (solo lectura).
- `tests/test_agent_profiles.py`: invariantes (monitor-only, sin canales duplicados ni sin
  filtro, sin diffs de archivos con secretos, manifiesto fijado).

Documentación completa: [`docs/security/agents/`](../../../docs/security/agents/README.md).
