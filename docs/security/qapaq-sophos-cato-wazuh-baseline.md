# Baseline SOC QAPAQ: Wazuh, Sophos Central y Cato

**Estado:** propuesta técnica para revisión; no aplicada en las consolas de los
proveedores. **Ámbito:** endpoints corporativos, servidores y telemetría de red de
la financiera. **Principio:** Sophos protege y contiene endpoint; Cato protege el
tráfico SASE; Wazuh centraliza telemetría de host/reglas y QAPAQ gobierna casos,
aprobación y auditoría. El mismo evento no debe generar acciones autónomas
duplicadas.

## 1. Perfiles y grupos de activos

Crear grupos con asignación administrada por inventario, no por etiquetas libres:

| Grupo | Agentes y controles | Clasificación |
|---|---|---|
| `qapaq-windows-workstations` | Sophos Endpoint, agente Wazuh Windows, telemetría Security/System/PowerShell según política, Syscollector, FIM acotada, SCA | usuario corporativo |
| `qapaq-privileged-workstations` | Todo lo anterior; monitor reforzado de autenticación privilegiada, PowerShell y cambios de seguridad; sin exclusiones generales | administración TI/SOC |
| `qapaq-windows-servers` | Sophos Server con política específica, Wazuh, canales de seguridad, syscollector, FIM de configuración/datos críticos, SCA | servidor |
| `qapaq-linux-servers` | Sophos Linux según licencia, Wazuh, auth/audit/journald, syscollector, FIM de configuración/binarios, SCA | servidor |
| `qapaq-critical-services` | Subconjunto identificado por CMDB: identidad, correo, finanzas, bases de datos; retención y alertado reforzados | crítico |
| `qapaq-lab` | Análisis YARA/ClamAV y pruebas de políticas en datos sintéticos; sin acceso a producción | laboratorio |

No crear grupos nominales para personas. El dueño del activo aprueba la membresía;
SOC consume alertas. El enrolamiento exige identidad individual del equipo,
autenticación/validación de Manager, rotación de claves, inventario y fecha de
retiro. No distribuir claves de agente por navegador, correo o logs.

## 2. Políticas de endpoint y malware

### Sophos Central

1. Mantener activa la política recomendada de **Threat Protection** para equipos y
   una variante separada para servidores; no heredar sin revisar cargas de bases
   de datos, aplicaciones financieras y ventanas de mantenimiento.
2. Mantener Live Protection, protección en tiempo real, detección por Deep Learning
   cuando la licencia lo soporte, protección contra ransomware/CryptoGuard, exploit
   prevention, limpieza automática y protección contra conexiones maliciosas según
   sistema/licencia.
3. Activar Tamper Protection en Windows/macOS; proteger políticas con roles de
   administración separados. No guardar contraseñas de tamper en tickets de
   incidente.
4. Aplicar primero a un piloto representativo. Medir CPU, latencia, falsos
   positivos y aplicaciones bloqueadas durante al menos un ciclo operativo; ampliar
   por grupos aprobados. Las excepciones deben ser puntuales por hash/ruta/proceso,
   con motivo, owner, evidencia, vencimiento y revisión. No excluir carpetas
   completas ni el árbol temporal/descargas sin evaluación.
5. Ejecutar simulaciones benignas de EICAR en laboratorio y pruebas de detección
   permitidas por Sophos; comprobar evento, equipo, acción, hora y disponibilidad
   de detalle. No ejecutar malware real ni usar endpoints de finanzas para pruebas.

### Cato SASE

1. Inventariar enlaces/sites, usuarios SDP, subredes, rutas, DNS y flujos que
   atraviesan Cato. Threat Prevention inspecciona tráfico WAN/Internet que transita
   Cato; no asumir visibilidad de MPLS/bypass fuera de su plano de inspección.
2. Revisar Anti-Malware y NG Anti-Malware, IPS, DNS protection y URL filtering en
   modo observación/piloto primero; pasar a bloqueo por regla revisada, con exclusión
   mínima, owner y expiración. Habilitar inspección TLS solo con evaluación legal,
   privacidad, certificados, aplicaciones incompatibles y tratamiento de datos; no
   ejecutar el cambio global sin piloto y plan de rollback.
3. Mantener reglas de firewall con deny-by-default en segmentos sensibles, acceso
   administrativo por grupos dedicados y registro de cambios; separar sitios,
   usuarios y servidores por zonas. No usar una política global para mitigar un IOC
   puntual sin corroborar el destino y el impacto de negocio.
4. Probar el flujo de alerta con simulaciones y tráfico aprobado, no con dominios
   maliciosos activos. Confirmar que los eventos contienen site/usuario/host,
   política/servicio, veredicto y timestamp antes de aprobar automatización.

## 3. Detección y análisis en Wazuh

- **M365:** mantener el módulo Office 365 autorizado existente. Revisar logs de
  errores, última lectura y frescura por workload; mapear Azure AD, Exchange,
  SharePoint y General a reglas revisadas. Alertar cambios de privilegios, consent,
  reglas de forwarding/inbox, sign-ins de riesgo y cambios de seguridad; no asumir
  que la ausencia de eventos es saludable.
- **Sophos:** ingerir primero alertas/eventos mediante Sophos SIEM Integration API
  con `client_credentials`, `X-Tenant-ID`, host regional y cursor; pedir solo los
  campos necesarios, paginar, persistir checkpoint y alertar gaps/throttling.
  Sophos SIEM Events documenta ventana de 24 horas, páginas y `next_cursor`; no
  promete backfill indefinido.
- **Cato:** consumir el API GraphQL `eventsFeed` con permiso dedicado mínimo para
  Events, checkpoint opaco `marker` guardado sin parsear, paginación y monitoreo de
  retención aproximada de tres días. Separar eventos security, connectivity,
  system, routing y administración; no compartir credenciales de operador ni pedir
  permisos globales si el contrato solo requiere Events.
- **Agentes:** comprobar versión soportada, heartbeat, inventario y drift de
  políticas; canalizar errores de `wazuh-agentd` y módulos. Aplicar SCA por OS,
  vulnerability detection con feeds vigentes y FIM de ubicaciones de alto valor.
  Evitar FIM recursivo sin límite sobre perfiles y volúmenes de datos.
- **Malware:** Sophos es el control primario de endpoint; Wazuh correlaciona alerta,
  FIM, proceso y telemetría. YARA/ClamAV se reservan para laboratorio o casos
  aprobados para no crear doble cuarentena/consumo. No descargar muestras a los
  agentes SOC ni a Shuffle.
- **Playbooks:** Shuffle recibe por webhook validado el evento mínimo y enruta a
  triage/enriquecimiento read-only. La consulta de evidencia completa requiere
  permisos de lectura y una llamada just-in-time. Contener endpoint, bloquear IOC,
  revocar sesión o deshabilitar usuario requiere aprobación humana, registro de
  ticket, expiración y verificación posterior.

## 4. Severidad, respuesta y gobernanza

| Nivel operativo | Criterio de ejemplo | Respuesta inicial |
|---|---|---|
| P1 | malware confirmado en activo crítico, ransomware, persistencia/credencial privilegiada o propagación | escalar on-call; preservar evidencia; aprobación del responsable antes de aislar salvo playbook de emergencia aprobado |
| P2 | detección de alta confianza en equipo corporativo o movimiento lateral limitado | investigar host/usuario/IOC; Sophos/Cato action solo tras corroboración |
| P3 | bloqueo preventivo sin ejecución, IOC de reputación o desviación SCA | correlacionar, revisar repetición y cerrar con evidencia |
| P4 | drift informativo, software permitido o evento sin impacto | backlog/higiene y ajuste de falso positivo con owner |

Toda respuesta automática debe tener alcance explícito, condición de reversión,
ventana, aprobación, auditoría y prueba de no impacto. La respuesta automática no
debe borrar evidencia o borrar alertas del proveedor. El acuse en Teams no equivale
a aprobación.

## 5. Requisitos para pasar de propuesta a política aplicada

Antes de aplicar controles en Sophos/Cato: confirmar tenant/producto/licencias,
propietario, grupo de prueba, configuración actual exportable, cambio exacto,
impacto esperado, ventana, rollback y API permissions. Guardar antes/después y
audit trail, no secretos. El inventario actual del repo no trae contrato validado
para conectores Sophos/Cato; por ello las políticas anteriores son baseline
propuesto y no una certificación de configuración ya activa.

Acceptance del conector: evento sintético/proveedor aprobado, scope correcto, pages
and checkpoint, dedupe/replay, 401/403/429/5xx, timeout, lag/gap alarm, lineage,
redacción de PII, least privilege, y retención aprobada. Seguridad/legal del negocio
debe determinar inspección TLS, tratamiento de PII y retención antes del corte.

El catálogo de automatización inicial, estados de conectores, permisos y límites de
VirusTotal está en [`ankay-playbooks/README.md`](ankay-playbooks/README.md). La
metodología para adaptar reglas abiertas y reducir falsos positivos está en
[`detection-engineering-qapaq.md`](detection-engineering-qapaq.md).

## Referencias oficiales

- [Sophos: Threat Protection policy](https://docs.sophos.com/central/customer/help/en-us/ManageYourProducts/EndpointProtection/ThreatProtectionPolicy/index.html)
- [Sophos: Tamper Protection](https://docs.sophos.com/central/customer/help/en-us/ManageYourProducts/GlobalSettings/ProductsServices/Endpoint/TamperProtection/index.html)
- [Sophos: SIEM Integration API](https://developer.sophos.com/reference/siem-v1/events/get-events/)
- [Cato: Threat Prevention overview](https://knowledge.catonetworks.com/docs/overview-of-cato-s-threat-prevention)
- [Cato: Anti-Malware policy](https://support.catonetworks.com/hc/en-us/articles/4413280529297-What-is-the-Cato-Anti-Malware-Policy)
- [Cato: GraphQL API eventsFeed](https://api.catonetworks.com/documentation/)
- [Wazuh: Malware detection](https://documentation.wazuh.com/current/user-manual/capabilities/malware-detection/index.html)
- [Wazuh: centralized agent configuration](https://documentation.wazuh.com/current/user-manual/reference/centralized-configuration.html)
