# Integración de la interfaz oficial de Wazuh con QAPAQ SecOps

**Estado: arquitectura verificada; forks y adaptación aún no implementados.** Este documento
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

```text
Analista → UI QAPAQ (fork de Wazuh UI sobre qapaq-dashboard)
             ├─ funciones SIEM nativas → Wazuh Indexer (solo lectura)
             └─ casos, triaje, SOAR, auditoría → BFF/API QAPAQ

Wazuh Manager → ingesta, decoders, reglas → Wazuh Indexer
Microsoft Entra ID → identidad humana → BFF QAPAQ y sesión de Dashboard
```

- Conservar el login visual QAPAQ y el flujo de autenticación aprobado en
  [identidad y autorización](../architecture/identity-and-authorization.md). No reemplazarlo por un
  formulario genérico de Wazuh ni entregar tokens de Entra al navegador. La integración entre la
  sesión del BFF y la sesión del Dashboard requiere diseño y prueba de SSO antes de producción.
- Mantener la autorización de negocio en QAPAQ API. Las vistas de casos, SOAR y auditoría llaman al
  BFF/API; cada operación protegida comprueba la capability en servidor y deja auditoría cuando
  corresponde. La UI oculta acciones sin permiso como ayuda de navegación, nunca como control de
  seguridad.
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
2. Crear en `CyberStill-GmbH` un fork del UI oficial `wazuh/wazuh-kibana-app` (nombre sugerido
   `qapaq-wazuh-ui`) para aplicar el arte, navegación QAPAQ, integración BFF y dashboards iniciales.
   Fijarlo al commit compatible con la versión Wazuh/OSD de `qapaq-dashboard`.
3. Conservar `CyberStill-GmbH/qapaq-secops` como backend de negocio. Crear un fork de `wazuh/wazuh`
   solo si un requisito probado exige cambiar el Manager; mantener ese delta mínimo, separado y
   rebajable. No copiar RBAC, casos, SOAR o auditoría hacia el Manager: eso crearía dos fuentes de
   verdad y más complejidad operacional.
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
