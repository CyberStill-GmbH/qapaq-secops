"""Genera tests/fixtures/sample-alerts.json (datos 100 % sinteticos: example.test, 203.0.113.0/24).

Uso:  python tests/make_sample.py > tests/fixtures/sample-alerts.json
"""
import json
import random
from datetime import datetime, timedelta, timezone

rnd = random.Random(8901)
base = datetime(2026, 11, 12, 14, 0, tzinfo=timezone.utc)  # 09:00 America/Lima

RULES = [
    ("Autenticación fallida repetida", "Más de 10 intentos fallidos de inicio de sesión en 5 minutos"),
    ("Inicio de sesión desde ubicación inusual", "Acceso exitoso desde un país sin actividad previa del usuario"),
    ("Escaneo de puertos desde IP externa", "Barrido de puertos TCP contra varios hosts de la DMZ"),
    ("Ejecución de PowerShell codificado", "Línea de comandos con -EncodedCommand lanzada por un proceso de Office"),
    ("Cambio de integridad en archivo crítico", "Modificación de un archivo monitoreado en /etc"),
    ("Creación de cuenta privilegiada", "Nueva cuenta añadida al grupo de administradores"),
    ("Tráfico saliente hacia dominio de baja reputación", "Consulta DNS y conexión TLS a un dominio recién registrado"),
    ("Servicio detenido inesperadamente", "El agente de endpoint dejó de reportar durante más de 15 minutos"),
]
HOSTS = [f"srv-{n}.example.test" for n in ("app-01", "app-02", "db-01", "web-01", "vpn-01", "mail-01", "wks-014", "wks-027")]
STATUS = ["Abierta", "En análisis", "Contenida", "Cerrada"]
rows = []
for i in range(64):
    rule, detail = RULES[rnd.randrange(len(RULES))]
    pr = rnd.choices(["P1", "P2", "P3", "P4"], [1, 3, 5, 3])[0]
    when = base - timedelta(minutes=rnd.randrange(0, 7 * 24 * 60))
    host = HOSTS[rnd.randrange(len(HOSTS))]
    rows.append({
        "occurredAt": when.isoformat().replace("+00:00", "Z"),
        "priority": pr,
        "title": f"{rule} · {host}" if i % 5 else f"{rule} · {host} — {detail}",
        "source": f"203.0.113.{rnd.randrange(2, 250)}",
        "score": rnd.randrange(20, 100),
        "status": STATUS[rnd.randrange(len(STATUS))],
        "link": f"https://soc.example.test/alerts/{i + 1:05d}",
    })
rows.sort(key=lambda r: r["occurredAt"], reverse=True)

days = [(base - timedelta(days=d)).astimezone(timezone(timedelta(hours=-5))).strftime("%Y-%m-%d") for d in range(6, -1, -1)]
def series(label, lo, hi):
    return {"label": label, "points": [{"x": d, "y": rnd.randrange(lo, hi)} for d in days]}

spec = {
    "version": 1,
    "format": "pdf",
    "kind": "alerts",
    "title": "Informe semanal de alertas",
    "subtitle": "Resumen operativo del SOC para la semana del 6 al 12 de noviembre de 2026",
    "generatedAt": "2026-11-13T17:00:00Z",
    "generatedBy": "Analista Demo",
    "timeZone": "America/Lima",
    "classification": "Confidencial · uso interno QAPAQ",
    "period": {"from": "2026-11-06T05:00:00Z", "to": "2026-11-13T04:59:59Z"},
    "kpis": [
        {"label": "Alertas totales", "value": "64", "hint": "+9 vs. periodo anterior"},
        {"label": "Alertas P1", "value": "4", "hint": "+1 vs. periodo anterior"},
        {"label": "Abiertas", "value": "21", "hint": "33 % del total"},
        {"label": "Tiempo medio de respuesta", "value": "38 min", "hint": "-6 min vs. periodo anterior"},
    ],
    "sections": [
        {"type": "markdown", "heading": "Resumen ejecutivo", "body": (
            "Durante la semana se registraron **64 alertas**, con un incremento moderado frente al periodo anterior. "
            "La actividad se concentró en autenticaciones fallidas y en escaneos desde `203.0.113.0/24`.\n\n"
            "- Cuatro alertas de prioridad **P1** fueron atendidas dentro del objetivo de respuesta.\n"
            "- Dos hosts de la DMZ concentraron el 40 % de los eventos de escaneo.\n"
            "- No se confirmó compromiso de datos; se recomienda mantener la vigilancia reforzada.\n\n"
            "> Nota: las cifras provienen de Wazuh y pueden variar si se reclasifican alertas.\n\n"
            "<script>alert('esto se muestra como texto, no se ejecuta')</script>")},
        {"type": "chart", "heading": "Alertas por día y prioridad", "chart": "bar",
         "series": [series("P1", 0, 2), series("P2", 1, 6), series("P3", 2, 9)]},
        {"type": "chart", "heading": "Distribución por prioridad", "chart": "donut",
         "series": [{"label": "Prioridad", "points": [
             {"x": "P1", "y": 4}, {"x": "P2", "y": 15}, {"x": "P3", "y": 27}, {"x": "P4", "y": 18}]}]},
        {"type": "chart", "heading": "Tendencia de alertas totales", "chart": "line",
         "series": [{"label": "Total", "points": [{"x": d, "y": rnd.randrange(5, 16)} for d in days]}]},
        {"type": "table", "heading": "Alertas del periodo", "primary": True,
         "columns": [
             {"key": "occurredAt", "label": "Ocurrió", "kind": "datetime"},
             {"key": "priority", "label": "Prioridad", "kind": "priority"},
             {"key": "title", "label": "Alerta", "kind": "text"},
             {"key": "source", "label": "IP origen", "kind": "text"},
             {"key": "status", "label": "Estado", "kind": "text"},
             {"key": "score", "label": "Puntuación", "kind": "number"},
             {"key": "link", "label": "Abrir", "kind": "link"}],
         "rows": rows,
         "note": "Ordenadas de la más reciente a la más antigua. Horas en America/Lima."},
        {"type": "timeline", "heading": "Cronología de eventos relevantes", "items": [
            {"at": "2026-11-09T13:42:00Z", "title": "Primer escaneo de puertos detectado", "detail": "Origen 203.0.113.45 contra la DMZ.", "priority": "P3"},
            {"at": "2026-11-09T14:10:00Z", "title": "Bloqueo preventivo de la IP de origen", "detail": "Regla aplicada en el firewall perimetral por el analista de turno.", "priority": "P4"},
            {"at": "2026-11-10T22:03:00Z", "title": "Inicio de sesión desde ubicación inusual", "detail": "Cuenta de servicio svc-reports@example.test; sesión revocada y credenciales rotadas.", "priority": "P2"},
            {"at": "2026-11-11T15:27:00Z", "title": "PowerShell codificado en estación de trabajo", "detail": "Proceso padre: aplicación de ofimática. Equipo aislado de la red.", "priority": "P1"},
            {"at": "2026-11-11T16:05:00Z", "title": "Equipo reimaginado y devuelto al usuario", "detail": "Sin indicios de persistencia tras el análisis forense básico.", "priority": ""},
            {"at": "2026-11-12T13:15:00Z", "title": "Cierre de la alerta P1", "detail": "Informe de incidente registrado en el caso INC-0042."}]},
        {"type": "markdown", "heading": "Recomendaciones", "body": (
            "1. Mantener el bloqueo de rangos con actividad de escaneo recurrente.\n"
            "2. Revisar la política de bloqueo de cuentas tras intentos fallidos.\n"
            "3. Completar la capacitación sobre macros y archivos adjuntos antes del cierre de mes.\n\n"
            "| Acción | Responsable | Plazo |\n|---|---|---|\n"
            "| Revisar reglas de firewall | Redes | 2026-11-20 |\n"
            "| Ajustar umbrales de autenticación | SOC | 2026-11-18 |\n")},
    ],
    "sources": [
        "Wazuh Indexer · wazuh-alerts-* (consulta 2026-11-13 12:00)",
        "QAPAQ SecOps API",
    ],
}
print(json.dumps(spec, ensure_ascii=False, indent=2))
