#!/usr/bin/env python3
"""Genera los casos sintéticos de wazuh-logtest para las reglas financieras QAPAQ.

Escribe `logtest-cases.jsonl` y `expected-rules.txt` en este directorio. Cada línea de
expected-rules.txt es la regla esperada para el evento homólogo:

- `<id>`: debe disparar esa regla.
- `!<id>`: esa regla NO debe disparar (caso negativo).
- `<id>|<id>`: vale cualquiera de las dos (solo para reglas que dependen del día).
- `---` (en ambos archivos): inicia una sesión nueva de wazuh-logtest.

Las reglas de frecuencia dependen del orden y `ignore` suprime una regla durante su
ventana dentro de la sesión; por eso cada escenario con estado va en su propia sesión. Las reglas con <time> exigen que el Manager de prueba corra en horario nocturno
(run-logtest.sh fija TZ para que la hora local sea 23:00).

Datos solo sintéticos: dominios .example, IPs RFC 5737, sin cuentas ni montos reales.
Uso: python3 generate_cases.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
TENANT = "00000000-0000-4000-8000-000000000001"
SESSION = "---"
cases: list[tuple[dict | str, str]] = []


def o365(operation: str, user: str, workload: str = "Exchange", record_type: int = 1,
         ip: str = "203.0.113.24", **extra) -> dict:
    body = {
        "CreationTime": "2026-10-27T12:00:00",
        "Id": "11111111-2222-4333-8444-555555555555",
        "Operation": operation,
        "OrganizationId": TENANT,
        "RecordType": record_type,
        "ResultStatus": "Succeeded",
        "UserKey": "10032000A1B2C3D4",
        "UserType": 0,
        "Workload": workload,
        "ClientIP": ip,
        "UserId": user,
        "Subscription": f"Audit.{'SharePoint' if workload in ('SharePoint', 'OneDrive') else 'Exchange' if workload == 'Exchange' else 'AzureActiveDirectory' if workload == 'AzureActiveDirectory' else 'General'}",
    }
    body.update(extra)
    return {"integration": "office365", "office365": body}


def provider(vendor: str, event_type: str, record: str, **fields) -> dict:
    event = {"integration": "qapaq-provider", "qapaq_vendor": vendor,
             "qapaq_event_type": event_type, "qapaq_source_record_id": record}
    event.update(fields)
    return event


def windows(event_id: str, channel: str, computer: str, **eventdata) -> dict:
    provider_name = ("Microsoft-Windows-Sysmon" if channel.startswith("Microsoft-Windows-Sysmon")
                     else "Microsoft-Windows-Security-Auditing")
    severity = "INFORMATION" if provider_name.endswith("Sysmon") else "AUDIT_SUCCESS"
    return {"win": {"system": {"providerName": provider_name, "eventID": event_id,
                               "severityValue": severity, "channel": channel,
                               "computer": computer},
                    "eventdata": eventdata}}


def sysmon_process(computer: str, image: str, command_line: str) -> dict:
    return windows("1", "Microsoft-Windows-Sysmon/Operational", computer,
                   image=image, commandLine=command_line,
                   parentImage="C:\\Windows\\System32\\cmd.exe", user="QAPAQ-LAB\\usuario")


def add(event: dict, expected: str) -> None:
    cases.append((event, expected))


def session() -> None:
    """Separa un escenario con estado (frecuencia o ignore) en otra sesión de logtest."""
    cases.append((SESSION, SESSION))


# ------------------------------------------------------------ BEC y fraude de pagos
add(o365("New-InboxRule", "tesoreria@qapaq-lab.example", Parameters=[
    {"Name": "SubjectOrBodyContainsWords", "Value": "factura;transferencia"},
    {"Name": "MoveToFolder", "Value": "RSS Feeds"},
    {"Name": "Name", "Value": "."}]), "101400")
# Regla que oculta correo pero sin palabras de pagos: queda en 100510.
add(o365("New-InboxRule", "tesoreria@qapaq-lab.example", Parameters=[
    {"Name": "SubjectContainsWords", "Value": "newsletter"},
    {"Name": "MoveToFolder", "Value": "Archivo"},
    {"Name": "Name", "Value": "orden"}]), "100510")

session()
# Toma de cuenta: 10 fallos + éxito (100505) y luego regla de buzón y cambio MFA.
for _ in range(9):
    add(o365("UserLoginFailed", "pagos@qapaq-lab.example", "AzureActiveDirectory", 15,
             "198.51.100.61", ResultStatus="Failed"), "100502")
add(o365("UserLoginFailed", "pagos@qapaq-lab.example", "AzureActiveDirectory", 15,
         "198.51.100.61", ResultStatus="Failed"), "100503")
add(o365("UserLoggedIn", "pagos@qapaq-lab.example", "AzureActiveDirectory", 15,
         "198.51.100.61"), "100505")
add(o365("Set-Mailbox", "pagos@qapaq-lab.example", Parameters=[
    {"Name": "ForwardingSmtpAddress", "Value": "smtp:proveedor@ajeno.example"}]), "101401")
add(o365("User registered security info", "pagos@qapaq-lab.example", "AzureActiveDirectory", 8),
    "101410")
# Otro usuario sin fuerza bruta previa: el cambio MFA queda en 100526.
add(o365("User registered security info", "normal@qapaq-lab.example", "AzureActiveDirectory", 8),
    "100526")

add(provider("erp", "vendor_bank_account_changed", "syn-erp-001", qapaq_vendor_ref="vendor-ref-0001",
             qapaq_user_id="compras@qapaq-lab.example", qapaq_change_status="approved"), "101402")
add(provider("erp", "vendor_bank_account_changed", "syn-erp-002", qapaq_vendor_ref="vendor-ref-0002",
             qapaq_user_id="compras@qapaq-lab.example", qapaq_change_status="sod_violation"), "101403")
add(provider("erp", "payment_released", "syn-erp-003", qapaq_vendor_ref="vendor-ref-0002",
             qapaq_beneficiary_age="changed_72h"), "101404")
add(provider("erp", "payment_released", "syn-erp-004", qapaq_vendor_ref="vendor-ref-0003",
             qapaq_beneficiary_age="established"), "!101404")

# ------------------------------------------------------- Toma de cuenta core créditos
session()
add(provider("entra", "risky_signin", "syn-entra-101", qapaq_severity="high",
             qapaq_user_id="analista.creditos@qapaq-lab.example", qapaq_source_ip="198.51.100.62"),
    "101411")
add(provider("entra", "risky_signin", "syn-entra-102", qapaq_severity="high",
             qapaq_user_id="marketing@qapaq-lab.example", qapaq_source_ip="198.51.100.62"),
    "101205")
for _ in range(9):
    add(o365("UserLoginFailed", "jefe.agencia@qapaq-lab.example", "AzureActiveDirectory", 15,
             "198.51.100.63", ResultStatus="Failed"), "100502")
add(o365("UserLoginFailed", "jefe.agencia@qapaq-lab.example", "AzureActiveDirectory", 15,
         "198.51.100.63", ResultStatus="Failed"), "100503")
add(o365("UserLoggedIn", "jefe.agencia@qapaq-lab.example", "AzureActiveDirectory", 15,
         "198.51.100.63"), "101412")

# ------------------------------------------------------------------- Exfiltración
session()
# 100 descargas del mismo usuario. El runner fuerza 23:00 local: la descarga 30 dispara
# 101417 (fuera de horario), que luego queda en su ventana `ignore`; la 31 puede disparar
# 101418 solo si el día es fin de semana; la 100 dispara 101416 (volumen).
for index in range(99):
    expected = {29: "101417", 30: "101415|101418"}.get(index, "101415")
    add(o365("FileSyncDownloadedFull", "masivo@qapaq-lab.example", "OneDrive", 6,
             ObjectId=f"https://qapaqlab-my.sharepoint.example/personal/doc-{index}.pdf"), expected)
add(o365("FileSyncDownloadedFull", "masivo@qapaq-lab.example", "OneDrive", 6,
         ObjectId="https://qapaqlab-my.sharepoint.example/personal/doc-99.pdf"), "101416")
session()
# Una descarga de Exchange no es SharePoint/OneDrive.
add(o365("FileDownloaded", "otro@qapaq-lab.example", "Exchange", 1), "!101415")

for index in range(9):
    add(o365("AnonymousLinkCreated", "compartidor@qapaq-lab.example", "SharePoint", 14,
             ObjectId=f"https://qapaqlab.sharepoint.example/sites/clientes/lista-{index}.xlsx"), "100515")
add(o365("AnonymousLinkCreated", "compartidor@qapaq-lab.example", "SharePoint", 14,
         ObjectId="https://qapaqlab.sharepoint.example/sites/clientes/lista-9.xlsx"), "101419")

for _ in range(4):
    add(o365("DLPRuleMatch", "dlp@qapaq-lab.example", "Exchange", 13), "101420")
add(o365("DLPRuleMatch", "dlp@qapaq-lab.example", "Exchange", 13), "101421")

add(provider("cato", "cloud_upload", "syn-cato-101", qapaq_app_sanctioned="false",
             qapaq_volume_class="high", qapaq_source_ip="192.0.2.31",
             qapaq_destination="storage-no-autorizado.example"), "101422")
add(provider("cato", "cloud_upload", "syn-cato-102", qapaq_app_sanctioned="true",
             qapaq_volume_class="high", qapaq_source_ip="192.0.2.31",
             qapaq_destination="onedrive.example"), "!101422")

# ---------------------------------------------------------- Privilegios y break-glass
add(o365("Add member to role.", "bg-01@qapaq-lab.example", "AzureActiveDirectory", 8,
         ModifiedProperties=[{"Name": "Role.DisplayName", "NewValue": "Global Administrator",
                              "OldValue": ""}]), "101425")
# Asignación privilegiada por un admin normal de noche: 101426.
add(o365("Add member to role.", "admin.ti@qapaq-lab.example", "AzureActiveDirectory", 8,
         ModifiedProperties=[{"Name": "Role.DisplayName", "NewValue": "Exchange Administrator",
                              "OldValue": ""}]), "101426")
add(windows("4728", "Security", "DC01.qapaq-lab.example",
            targetSid="S-1-5-21-111111111-222222222-333333333-512",
            memberSid="S-1-5-21-111111111-222222222-333333333-1107",
            subjectUserName="svc-change", subjectDomainName="QAPAQ-LAB"), "101427")
add(windows("4624", "Security", "DC01.qapaq-lab.example", targetUserName="bg-ad-01",
            targetDomainName="QAPAQ-LAB", logonType="10", ipAddress="192.0.2.40"), "101428")
add(windows("4624", "Security", "DC01.qapaq-lab.example", targetUserName="usuario.normal",
            targetDomainName="QAPAQ-LAB", logonType="2", ipAddress="192.0.2.41"), "!101428")

# ----------------------------------------------------------------------- Ransomware
add(sysmon_process("AGENCIA01-PC01.qapaq-lab.example", "C:\\Windows\\System32\\vssadmin.exe",
                   "vssadmin.exe Delete Shadows /All /Quiet"), "101430")
add(sysmon_process("AGENCIA01-PC02.qapaq-lab.example", "C:\\Windows\\System32\\wbem\\WMIC.exe",
                   "wmic shadowcopy delete /nointeractive"), "101430")
add(sysmon_process("AGENCIA01-PC03.qapaq-lab.example", "C:\\Windows\\System32\\bcdedit.exe",
                   "bcdedit /set {default} recoveryenabled No"), "101431")
add(sysmon_process("AGENCIA01-PC04.qapaq-lab.example", "C:\\Windows\\System32\\vssadmin.exe",
                   "vssadmin.exe list shadows"), "!101430")

add(provider("sophos", "threat_detected", "syn-sophos-101", qapaq_severity="critical",
             qapaq_status="active", qapaq_endpoint_id="endpoint-agencia-01",
             qapaq_threat_name="CryptoGuard ransomware protection"), "101432")
add(provider("sophos", "threat_detected", "syn-sophos-102", qapaq_severity="critical",
             qapaq_status="active", qapaq_endpoint_id="endpoint-agencia-02",
             qapaq_threat_name="Troj/Agent-ABC"), "101201")

for index in range(4):
    add(provider("cato", "threat_verdict", f"syn-cato-2{index:02d}", qapaq_action="allowed",
                 qapaq_severity="high", qapaq_site="agencia-lab-01",
                 qapaq_source_ip=f"192.0.2.{50 + index}", qapaq_destination="c2-lab.example"), "101203")
add(provider("cato", "threat_verdict", "syn-cato-204", qapaq_action="allowed",
             qapaq_severity="high", qapaq_site="agencia-lab-01",
             qapaq_source_ip="192.0.2.54", qapaq_destination="c2-lab.example"), "101433")

# ----------------------------------------------------- Marca y phishing a clientes
add(provider("brand_monitor", "lookalike_domain_detected", "syn-brand-001",
             qapaq_domain="qapaq-creditos.example", qapaq_domain_capability="none"), "101435")
add(provider("brand_monitor", "lookalike_domain_detected", "syn-brand-002",
             qapaq_domain="qapaq-pe.example", qapaq_domain_capability="mx,certificate"), "101436")
add(provider("cato", "web_access", "syn-cato-301", qapaq_source_ip="192.0.2.60",
             qapaq_destination="qapaq-pe.example", qapaq_action="allowed"), "101437")
add(provider("cato", "web_access", "syn-cato-302", qapaq_source_ip="192.0.2.60",
             qapaq_destination="proveedor-legitimo.example", qapaq_action="allowed"), "!101437")

# ------------------------------------------------------------------- Fraude interno
for index in range(49):
    add(o365("FileAccessed", "curioso@qapaq-lab.example", "SharePoint", 6,
             SiteUrl="https://qapaqlab.sharepoint.example/sites/creditos",
             ObjectId=f"https://qapaqlab.sharepoint.example/sites/creditos/exp-{index}.pdf"), "101440")
add(o365("FileAccessed", "curioso@qapaq-lab.example", "SharePoint", 6,
         SiteUrl="https://qapaqlab.sharepoint.example/sites/creditos",
         ObjectId="https://qapaqlab.sharepoint.example/sites/creditos/exp-49.pdf"), "101441")
add(o365("FileAccessed", "curioso@qapaq-lab.example", "SharePoint", 6,
         SiteUrl="https://qapaqlab.sharepoint.example/sites/marketing",
         ObjectId="https://qapaqlab.sharepoint.example/sites/marketing/plan.pptx"), "!101440")

for index in range(19):
    add(provider("core_banking", "customer_record_viewed", f"syn-core-{index:03d}",
                 qapaq_user_id="asesor.agencia@qapaq-lab.example", qapaq_role_match="false",
                 qapaq_customer_ref=f"customer-ref-{index:04d}"), "101442")
add(provider("core_banking", "customer_record_viewed", "syn-core-019",
             qapaq_user_id="asesor.agencia@qapaq-lab.example", qapaq_role_match="false",
             qapaq_customer_ref="customer-ref-0019"), "101443")
add(provider("core_banking", "customer_record_viewed", "syn-core-100",
             qapaq_user_id="asesor.cartera@qapaq-lab.example", qapaq_role_match="true",
             qapaq_customer_segment="pep", qapaq_access_justification="none",
             qapaq_customer_ref="customer-ref-0100"), "101444")
add(provider("core_banking", "customer_record_viewed", "syn-core-101",
             qapaq_user_id="asesor.cartera@qapaq-lab.example", qapaq_role_match="true",
             qapaq_customer_segment="pep", qapaq_access_justification="ticket",
             qapaq_customer_ref="customer-ref-0101"), "!101444")
add(provider("core_banking", "customer_report_exported", "syn-core-200",
             qapaq_user_id="practicante@qapaq-lab.example", qapaq_role_match="false"), "101445")


def render() -> tuple[str, str]:
    events = "".join((event if event == SESSION else
                      json.dumps(event, ensure_ascii=False, separators=(",", ":"))) + "\n"
                     for event, _ in cases)
    expected = "".join(f"{wanted}\n" for _, wanted in cases)
    return events, expected


if __name__ == "__main__":
    events, expected = render()
    targets = {here / "logtest-cases.jsonl": events, here / "expected-rules.txt": expected}
    if "--check" in sys.argv[1:]:
        stale = [path.name for path, text in targets.items()
                 if not path.exists() or path.read_text(encoding="utf-8") != text]
        if stale:
            sys.exit(f"Casos desactualizados, ejecutar generate_cases.py: {', '.join(stale)}")
        print(f"PASS: {sum(e != SESSION for e, _ in cases)} casos sincronizados")
    else:
        for path, text in targets.items():
            path.write_text(text, encoding="utf-8", newline="\n")
        print(f"{sum(e != SESSION for e, _ in cases)} casos escritos")
