# Integración de Qapaq `cintel` con QAPAQ SecOps

**Estado:** evaluación del componente fuente; integración de runtime pendiente de confirmar su ámbito de licencia.

## Componente localizado

La herramienta existente está en el repositorio privado `CyberStill-GmbH/qapaq-phishing-contrainteligencia`, versión `4.0.0`, paquete Python `cintel`. Es un analizador defensivo de mensajes `.eml`/`.msg`, direcciones, dominios y URL. Genera hallazgos explicables, veredicto, IOCs, mitigaciones y reportes PDF/JSON/STIX/MISP. Su ejecución es CLI local; no expone una API ni persiste en una base de datos.

La licencia del repositorio declara uso interno exclusivo de Qapaq y requiere autorización escrita de Riesgos No Financieros para copiar, modificar, sublicenciar o usar el software fuera de ese ámbito. Antes de incorporar su código o desplegarlo como servicio hay que confirmar que QAPAQ pertenece a ese ámbito o registrar esa autorización. Este documento no copia código fuente de `cintel`.

## Límite de lo que ya existe en QAPAQ

- `wazuh/alert-mail/qapaq_alert_mail.py` notifica alertas por Microsoft Graph; no analiza mensajes.
- La regla Wazuh `101100` detecta un proceso sospechoso iniciado por Outlook. Es experimental, requiere Sysmon y no confirma phishing.
- `phishing.m365-url-triage` y `qapaq.phishing-triage` son contratos de diseño read-only; no ejecutan `cintel` ni reciben un archivo de correo.

No presentar esas tres piezas como un analizador integrado.

## Integración propuesta

Mantener `cintel` como componente independiente y exponerlo a QAPAQ mediante un adaptador versionado. No importarlo dentro del proceso API ni del worker de Wazuh: la herramienta fue diseñada como CLI, hace consultas DNS/RDAP cuando está online y guarda reportes confidenciales por defecto.

1. El analista adjunta un `.eml` o `.msg` a un incidente QAPAQ existente y solicita **Analizar correo**. Autorizar la acción con capacidad específica, alcance por tenant, tamaño máximo, tipos admitidos y auditoría del actor.
2. Guardar la evidencia original en almacenamiento privado cifrado y con versión/retención definida. La API entrega al worker una referencia opaca y de un solo uso, no una ruta arbitraria.
3. Ejecutar el worker sin privilegios, con sistema de archivos temporal, límites de CPU/memoria/tiempo, sin salida a internet por defecto y sin montar secretos de Graph, Wazuh o AWS.
4. Invocar el CLI en modo sin red, sin guardar, sin PDF y sin correlación local; validar la versión y el código de salida. Revisar la combinación exacta de flags contra la versión fijada antes de habilitarla.
5. Validar el JSON contra un esquema QAPAQ y permitir solo campos necesarios: veredicto, índice, códigos/severidades de hallazgo, procedencia y referencias neutrales a IOCs. Eliminar asunto, cuerpo, direcciones personales, URL con parámetros, cabeceras sensibles y tokens antes de persistir en la cola o enviar a Qapaqzito.
6. Crear un documento de incidente versionado en almacenamiento cifrado y registrar hash SHA-256 de la evidencia, versión de `cintel`, versión del esquema, actor, timestamp y estado de análisis. El documento completo conserva clasificación CONFIDENCIAL; la cola muestra un resumen minimizado.
7. Qapaqzito recibe solo el resumen depurado y la referencia al documento; nunca la evidencia original por defecto. El veredicto sirve como evidencia de apoyo y no cierra alertas ni dispara aislamiento, bloqueo, purga o revocación.

La CLI soporta `--json`, `--sin-red`, `--sin-correlacion`, `--no-guardar` y `--sin-pdf`; el adaptador debe combinar y probar estas opciones para evitar que el modo predeterminado escriba copias locales o haga consultas externas. La herramienta está diseñada para no visitar URLs ni ejecutar adjuntos, pero el parser sigue procesando entrada hostil y debe permanecer aislado.

## Contrato del adaptador

Entrada: `tenantRef`, `incidentRef`, `evidenceRef`, `sha256`, `mediaType`, `sizeBytes`, `executionKey` y una versión de política. Rechazar URL remotas, rutas suministradas por el cliente, archivos sobre el límite, formatos no permitidos y replay de `executionKey`.

Salida persistible:

```json
{
  "engine": "qapaq-cintel",
  "engineVersion": "4.0.0",
  "assessment": "review_required",
  "riskIndex": 0,
  "findingCodes": [],
  "provenance": { "evidenceSha256": "…", "analyzedAt": "…" },
  "documentRef": "opaque-versioned-reference"
}
```

Mapear el veredicto original a estados explícitos de QAPAQ (`malicious_suspected`, `review_required`, `no_strong_indicators`, `analysis_incomplete`). No traducir "sin indicadores" a "limpio" y marcar las consultas omitidas como `unknown`.

## Gates antes de activar

- Confirmación documentada del ámbito de licencia y responsable de los reportes confidenciales.
- Revisión de la versión fijada, dependencias Python y resultados de `scripts/verificar.ps1`/CI del repositorio fuente.
- Contrato de almacenamiento, retención, borrado, backup y descarga autenticada para PDF/JSON.
- Pruebas sintéticas offline para `.eml`, `.msg`, parsers malformados, archivos grandes, timeout, duplicado, fallo parcial y neutralización de PII/URL.
- Revisión humana obligatoria; cero acciones de respuesta desde el analizador.
- Piloto sin red y con salida deshabilitada; después habilitar persistencia resumida y notificación según política de QAPAQ.

## Referencias

- Fuente: `CyberStill-GmbH/qapaq-phishing-contrainteligencia`, rama `main`, `README.md`, `LICENSE`, `pyproject.toml`, `docs/arquitectura.md` y `docs/seguridad.md`.
- Contratos QAPAQ relacionados: [`docs/security/ankay-playbooks/README.md`](ankay-playbooks/README.md), [`catalog.yaml`](ankay-playbooks/catalog.yaml), [`detections/windows/outlook-child-process/metadata.yaml`](../../detections/windows/outlook-child-process/metadata.yaml).
