# Perfil defensivo de Active Directory para QAPAQ SecOps

Estado: **propuesta lista para evaluación en laboratorio; pendiente de despliegue y
prueba con el AD autorizado**. El paquete Wazuh separado vive en
[`infra/wazuh/active-directory`](../../infra/wazuh/active-directory/README.md).
Este documento define dependencias y límites para una demo financiera; no es una
declaración de cumplimiento ni afirma que haya agentes, reglas o GPOs ya instalados.

## Objetivo y límites

Detectar cambios de identidad privilegiada, debilitamiento de auditoría, señales de
abuso Kerberos y cambios sobre objetos de administración persistente. La alerta abre
triage con actor, miembro/objeto, DC, origen, hora y cambio aprobado; no ordena
bloqueos, revocaciones ni Active Response. Sophos aporta estado/XDR de endpoint, Cato
contexto de red y M365/Entra identidad cloud; correlación entre productos requiere
normalizar IDs estables y conservar fuente/tiempo. No hay contrato aquí que permita
afirmar esa integración como operativa.

## Casos y evidencia requerida

| Prioridad | Caso | Señal Wazuh / requisito | Control de ruido |
|---|---|---|---|
| P0 | Miembro agregado a grupo de privilegio integrado | 4728/4732/4756 y SID de grupo privilegiado; regla 101300 | SID reduce dependencia de idioma; revisar cambio/ticket, miembro y actor. Agregar grupos delegados del dominio mediante SIDs revisados. |
| P0 | Desactivación de auditoría o borrado del Security log | 4719/1102; reglas 101301/101302 | Exigir corroboración con health/lag del agente y cambios aprobados; el silenciamiento del agente por sí solo es otra señal. |
| P1 | Cambio a AdminSDHolder o GPO | 5136/5137/5141 y Directory Service Changes; regla 101303 | SACLs acotadas a objetos de alto valor; correlacionar con CAB/owner del GPO. |
| P1 | Kerberos RC4 / posible Kerberoasting | 4769, `ticketEncryptionType=0x17`; regla hunting 101304 | Nivel 5; baseline de cuentas legacy, cliente y servicio. No escalar por RC4 aislado. |
| P1 | Cuenta sin preautenticación / posible AS-REP roast | 4768, `preAuthType=0`; regla 101305 | Comprobar estado de cuenta, excepción documentada y actividad del origen. |
| P1 | Acceso de replicación candidato a DCSync | 4662, access mask y GUID de replicación; regla 101306 | Nivel moderado; medir generación real y separar DCs/servicios de replicación por SID validado. |
| P1 | Fallo Kerberos que puede integrar password spraying | 4771; regla 101307 | Correlacionar conteo de cuentas distintas por origen e intervalo; no alertar por un fallo aislado como spray. |
| P1 | Nueva cuenta, habilitación, cambios, bloqueo | Eventos base 4720/4722/4738/4740, reglas upstream 60109/60110/60115 | Distinguir provisión aprobada de uso posterior; observar cuenta, actor y cambios encadenados. |

## Recolección mínima en un DC piloto

Aplicar el grupo central dedicado a controladores de dominio. Registrar canales
Security, System, Directory Service, DNS Server, Group Policy Operational y
PowerShell Operational con eventchannel; verificar disponibilidad local del canal
antes de distribuirlo. Para 5136 y 4662 habilitar las subcategorías de auditoría y
SACLs explícitas solo para los objetos de alto valor indicados por el dueño de AD.
Recoger el Security log con política de tamaño/retención que evite sobrescritura
antes de la ingesta. Estimar EPS, disco de eventos y lag en el piloto.

No habilitar globalmente command-line logging ni Script Block Logging como parte
de este paquete: antes se debe revisar si argumentos o scripts contienen datos
personales, tokens o secretos y establecer retención/acceso.

## Falsos positivos y operación

- Toda operación administrativa conocida debe tener identidad, grupo, ticket,
  ventana, aprobador y vencimiento; no se agregan exclusiones globales por IP o usuario.
- Kerberos RC4, preautenticación ausente y replicación son candidatos de hunting;
  medirlos durante el periodo piloto, identificar compatibilidad heredada y ajustar
  severidad con evidencia de AD.
- La ausencia de eventos no significa estado saludable. Comparar heartbeat del agente,
  último evento del canal y retraso de ingesta; el estado queda `unknown/degraded`
  cuando no haya telemetría suficiente.
- Automatización Ankay puede abrir un caso/adjuntar contexto después de normalizar y
  deduplicar alertas. Cualquier contención requiere aprobación y prueba con reversa;
  estas reglas no invocan playbooks ni Active Response.

## Aceptación antes de activación

1. Manager y agentes reportan versión compatible (objetivo 4.14.8) y DC piloto sano.
2. GPO/SACL aprobadas y eventos reales de laboratorio demuestran campos esperados.
3. `wazuh-analysisd -t` y fixtures positivos/negativos pasan en Manager 4.14.8.
4. 2 semanas de observación o periodo aprobado miden volumen, FPs y EPS por regla.
5. El propietario de AD firma grupos privilegiados, SIDs, excepciones, retención,
   responsables y procedimiento de rollback.
6. Para respuesta automatizada, aprobación separada del playbook, acción, SoD,
   idempotencia, evidencia y rollback.
