# Integración de la interfaz oficial de Wazuh con QAPAQ SecOps

**Estado: arquitectura verificada; primeras adaptaciones locales, aún sin CI ni despliegue.** Este documento
reemplaza el plan anterior, que confundía la plataforma OpenSearch Dashboards con la UI de Wazuh y
describía como existentes cambios que todavía no están en los repositorios.

## Qué existe hoy

- `CyberStill-GmbH/qapaq-dashboard` es un fork de `wazuh/wazuh-dashboard`. El README upstream dice
  explícitamente que ese repositorio aporta la plataforma OpenSearch Dashboards; la UI de Wazuh vive
  en su repositorio de plugins. Su HEAD observado fue
  `8bc0893be3cd2e33a17462865752984b775dfbf7`. En ese commit no hay una implementación QAPAQ que se
  pueda trasladar. El checkout está en OpenSearch Dashboards `3.6.0`, con metadata Wazuh `5.1.0`.
- La UI oficial se mantiene en `wazuh/wazuh-kibana-app`; su `package.json` la identifica como
  `wazuh-dashboard-plugins`. El README de ambos nombres (`wazuh-kibana-app` y
  `wazuh-dashboard-plugins`) describe los plugins que componen Wazuh UI. HEAD observado:
  `01add796adf15794c05005b7568dd33242f2811b`.
- La plataforma oficial declara `wazuh-kibana-app` como su plugin de UI y su workflow de build
  construye la plataforma junto con los plugins. Por tanto, el trabajo visual de QAPAQ debe vivir en
  un fork de esa UI y en los assets/tema compatibles del fork de plataforma, con ambas versiones
  fijadas como una pareja de build.
- `qapaq-secops` ya contiene el backend de negocio, el BFF de identidad, RBAC, casos, SOAR y
  auditoría. El Manager oficial `wazuh/wazuh` aporta agentes, recolección, decoders, ruleset y alertas;
  no es el backend de casos de QAPAQ. No se encontró un fork backend QAPAQ dentro de la organización.

Estas referencias se verificaron leyendo los README y metadatos de los repositorios oficiales y
consultando sus refs Git. No se validó el estado de sus workflows de CI ni un despliegue funcional.

## Arquitectura objetivo

La comparación de capacidades y el plan para integrar los diferenciales sin duplicar Case
Management, detección ni Active Response están en
[Migración de capacidades QAPAQ a Wazuh](qapaq-wazuh-capability-migration.md).

```text
Analista → QAPAQ Wazuh Dashboard (qapaq-dashboard + plugins Wazuh adaptados)
             ├─ funciones SIEM nativas → Wazuh Indexer (solo lectura)
             └─ funciones SOC QAPAQ → módulo de servidor QAPAQ del Dashboard
                                       └─ PostgreSQL (casos, grants y auditoría)

Wazuh Manager → agentes, ingesta, decoders y reglas → Wazuh Indexer
Microsoft Entra ID → BFF de identidad QAPAQ → sesión QAPAQ + sesión OpenID Dashboard
```

### Decisión de producto

QAPAQ se entrega como una edición integrada de Wazuh. No se incrusta la SPA actual de
QAPAQ ni se copian sus vistas: la consola se construye como aplicaciones nativas de los
plugins Wazuh y usa sus componentes, manteniendo el sistema visual y las referencias de
QAPAQ. El login QAPAQ es la única pantalla existente cuya identidad visual y flujo de
acceso se conservan en esta primera integración.

`qapaq-secops` es la referencia funcional y de contratos para casos, investigación,
RBAC/capabilities, auditoría y respuesta autorizada. Esas funciones se migran al módulo
de servidor QAPAQ en los plugins del Dashboard, reutilizando contratos y reglas ya
implementados. No se reimplementan funciones existentes de Wazuh para agentes, recolección,
decoders, reglas y alertas. El Manager permanece enfocado en su motor; PostgreSQL mantiene
el estado operacional QAPAQ y el Indexer se consulta con mínimo privilegio.

El login llama al BFF existente en `/api/auth/start`; su callback crea la cookie de sesión
QAPAQ y vuelve a la página de acceso del Dashboard. La página valida la sesión en
`/api/auth/session` y entrega la navegación al flujo OpenID del Dashboard. Ambos canjes
ocurren en servidor, con Entra como IdP y sin tokens en el navegador. El Dashboard debe
usar el mismo tenant Entra y deshabilitar el acceso humano local. Roles/capabilities de
QAPAQ continúan validándose en el servidor de cada operación.

Para este flujo, el ingress debe servir el BFF y OpenSearch Dashboards bajo el mismo
origen/base path, enrutar `/api/auth/*` al BFF y permitir ese `returnTo`. La integración
de logout, la configuración OpenID del Dashboard y las pruebas con Entra son gates antes
de producción.

- Conservar el login visual QAPAQ y el flujo de autenticación aprobado en
  [identidad y autorización](../architecture/identity-and-authorization.md). No reemplazarlo por un
  formulario genérico de Wazuh ni entregar tokens de Entra al navegador. La integración entre la
  sesión del BFF y la sesión del Dashboard requiere diseño y prueba de SSO antes de producción.
- Mantener la autorización de negocio en las reglas y contratos QAPAQ durante la migración al
  módulo de servidor de los plugins Wazuh. Cada operación protegida comprueba la capability en
  servidor y deja auditoría cuando corresponde. La UI oculta acciones sin permiso como ayuda de
  navegación, nunca como control de seguridad.
- Mapear roles del Dashboard/Indexer con mínimo privilegio. No asignar `all_access` por defecto ni
  usar un claim de Entra como sustituto de las políticas por recurso de QAPAQ. El dueño del grupo
  recibe administración; `qapaq.soc.analyst` ve las herramientas de análisis autorizadas.
- Mantener Wazuh Indexer como fuente de alertas Wazuh en solo lectura para el dashboard y para el
  conector de QAPAQ. PostgreSQL/API QAPAQ conserva la fuente de verdad de casos, autorizaciones y
  auditoría. No duplicar reglas base, decoders, ingesta Office 365 ni workflows de casos entre ambos
  backends.
- Provisionar dashboards guardados de investigación con objetos/versiones revisados y verificables.
  El despliegue debe fallar si el bundle no coincide con la versión fijada del plugin/plataforma; los
  dashboards deben cubrir alertas recientes, severidad, agente/fuente, investigación temporal y
  pivote a caso sin mostrar datos fuera del scope del analista.

## Repositorios y límites de cambios

1. Mantener `CyberStill-GmbH/qapaq-dashboard` como fork de la **plataforma** y sincronizarlo desde
   `wazuh/wazuh-dashboard`; no volver a crear un repositorio con el mismo nombre.
2. Adaptar forks QAPAQ de `wazuh/wazuh-dashboard-plugins` para las aplicaciones SOC, y
   `wazuh/wazuh-security-dashboards-plugin` para el acceso visual y el puente de autenticación.
   Fijar ambos a la versión compatible con `qapaq-dashboard`.
3. Conservar `CyberStill-GmbH/qapaq-secops` como referencia funcional mientras sus funciones
   diferenciales se migran al backend de los plugins del Dashboard. Modificar `wazuh/wazuh`
   Manager solo ante un requisito probado; mantener ese delta mínimo, separado y rebajable.
   No llevar casos, RBAC, SOAR o auditoría al motor Manager.
4. Si la integración exige cambiar APIs internas del Indexer/security plugin, evaluar el repositorio
   oficial correspondiente por separado; no empaquetar esa lógica dentro del Manager sin una
   necesidad demostrada.
5. En cada fork conservar licencias, avisos y procedencia upstream. Documentar el commit base, el
   delta QAPAQ y el procedimiento de rebase. No mezclar actualizaciones upstream con personalización
   visual en un único commit opaco.

## Gate antes de desplegar

- Crear los forks y confirmar permiso de escritura/CI en la organización.
- Fijar una matriz compatible de versiones y pasar build/lint/tests upstream y QAPAQ para ambos
  repositorios del Dashboard. El build de la plataforma requiere recursos que exceden el espacio
  disponible en este entorno, por lo que debe ejecutarse en CI con runner suficiente.
- Probar login/SSO, logout, expiración de sesión, CSRF, navegación directa a una URL no autorizada,
  endpoints API con 401/403 y acceso read-only al Indexer.
- Probar cada rol (`qapaq.platform.admin`, `qapaq.soc.analyst`, auditor) en servidor y UI. El analista
  no debe poder ejecutar mutaciones administrativas aunque invoque las rutas directamente.
- Instalar y comprobar los dashboards guardados en un entorno limpio; probar búsqueda, rangos de
  tiempo, pivotes y scopes sin alertas/índices de otras organizaciones.
- Publicar imágenes inmutables por digest y usar despliegue rolling con health checks, capacidad
  adicional, rollback al digest previo y pruebas de pérdida de una réplica. No aplicar Terraform
  hasta reconciliar el state remoto y revisar el plan exacto de cambios/destrucciones.

## Estado operativo de esta tarea

La lectura Git y la autenticación de GitHub como `CyberStill-GmbH` funcionan. La llamada de escritura
para crear el fork de UI fue rechazada con `403 Resource not accessible by integration`; no se creó
ningún fork. Se necesita que la credencial activa pueda crear forks en la organización y que la
política de `CyberStill-GmbH` lo permita. No se debe copiar un token desde el chat. La configuración
AWS de esta sesión no contiene perfiles ni credenciales y no hay CLI de AWS/Terraform disponible;
Terraform no se ejecutó.

### Avance local del login QAPAQ en Wazuh Dashboard — 2026-10-13

Se preparó un cambio local en `/workspace/qapaq-wazuh-security-dashboard-plugin`, rama
`feat/qapaq-entra-login`, sobre `wazuh/wazuh-security-dashboards-plugin` (`b81e52f`). Reproduce
el login QAPAQ —pantalla de bienvenida, ilustración Q, luz/grano, movimiento, aviso de cookies y
layout responsive— y comienza el acceso en el BFF existente (`/api/auth/start`,
`/api/auth/session`). Tras validar la cookie QAPAQ, el navegador continúa por OpenID del Dashboard
para obtener su propia sesión. Entra mantiene ambos flujos; no se entregan tokens al navegador.

Este cambio aún no está probado con el tenant Entra ni desplegado: requiere que el ingress enrute
`/api/auth/*` al BFF bajo el mismo origen, que Dashboard tenga OpenID configurado y que se verifiquen
callback, logout, SSO, cookie `Secure`/`SameSite`, CSRF y comportamiento tras fallos. La rama de login conserva solo la pantalla de acceso; la rama del plugin Wazuh ya tiene un primer puente al backend QAPAQ, pero aún no porta los módulos de dominio completos.

El código local de Manager no es el backend de sesión del Dashboard. Sus credenciales de servicio
se usan para las llamadas internas entre Dashboard y Manager y deben conservarse protegidas. La
autenticación humana del Dashboard se controla en el Security plugin del Indexer/OpenSearch y en la
configuración del Dashboard; esos archivos de despliegue no están en el checkout del plugin UI. Por
eso todavía no se ha deshabilitado Basic Auth en el Security plugin. Antes de producción hay que
deshabilitar el acceso humano local en esa capa, mantener la identidad de servicio de mínimo
privilegio y comprobar que no exista una ruta de acceso alternativa; ocultar el formulario no basta.


### Puente inicial a las capacidades QAPAQ

El backend ya implementado en `qapaq-secops` se reutiliza mientras se migra por
verticales al servidor del plugin Wazuh. La rama local del plugin incluye un cliente web
same-origin y rutas `/api/qapaq/*` con allowlist, que reenvían solo la cookie de sesión
QAPAQ (nunca las cookies de OpenSearch), CSRF y
correlación al API privado configurado con `wazuh.qapaqApiUrl`. No se publica la URL del
servicio al navegador ni se crea un segundo API de casos. Esta etapa conecta la consola
nativa al código funcional existente; no equivale al port completo del dominio ni está
lista para producción.

Las primeras capacidades a portar son triage de alertas, incidente/case, tareas, notas,
timeline, RBAC por capability/scope y audit trail. Se mantienen las funciones SIEM, agentes,
ruleset y Active Response de Wazuh. Shuffle queda seleccionado como motor SOAR no-code por
webhook; aprobaciones, idempotencia y auditoría permanecen bajo control QAPAQ.
