#!/usr/bin/env python3
"""Genera los fixtures sintéticos de wazuh-logtest de detections/sharepoint/* y su resultado esperado.

    python3 wazuh/provider-ingestion/sharepoint/tests/make_fixtures.py

Eventos sintéticos (RFC 5737, dominios .example) con la forma del módulo office365 de Wazuh y, cuando
corresponde, el contexto qapaq.* del collector Purview. El resultado esperado de las reglas de frecuencia se
calcula con un modelo del algoritmo de Wazuh (Search_LastSids): N-1 coincidencias previas del mismo
campo; al disparar marca la previa más nueva y la más vieja con el nivel de la regla, y una regla de nivel
igual o menor deja de contar al encontrar una marca (reinicio); una de nivel mayor la atraviesa.
"""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[4]
DET = ROOT / "detections" / "sharepoint"
ORG = "00000000-0000-4000-8000-000000000001"
SITE = "https://qapaqlab.sharepoint.example/sites/finanzas"
ONEDRIVE = "https://qapaqlab-my.sharepoint.example/personal/ana_qapaq-lab_example"
_counter = [0]


def o365(op: str, rt: int, user: str, ip: str = "198.51.100.20", workload: str = "SharePoint", obj: str | None = None,
         qapaq: dict | None = None, **extra) -> dict:
    _counter[0] += 1
    n = _counter[0]
    name = f"documento-{n:04d}.xlsx"
    record = {
        "CreationTime": "2026-11-09T15:00:00", "Id": f"00000000-0000-4000-9000-{n:012d}", "Operation": op,
        "OrganizationId": ORG, "RecordType": rt, "ResultStatus": "Succeeded", "UserKey": "i:0h.f|membership|synthetic",
        "UserType": 0, "Workload": workload, "ClientIP": ip, "UserId": user,
        "ObjectId": obj or f"{SITE}/Documentos/{name}", "SiteUrl": SITE + "/", "SourceFileName": name,
        "SourceRelativeUrl": "Documentos", "EventSource": "SharePoint", "ItemType": "File",
        "Subscription": "Audit.SharePoint",
    }
    record.update(extra)
    event = {"integration": "office365", "office365": record}
    if qapaq is not None:
        event["qapaq"] = {"vendor": "m365", "source": "sharepoint_audit", "api": "graph-audit-search", "event_type": "audit",
                        "collected_at": "2026-11-09T15:40:00Z", "after_hours": "false", "ip_first_seen": "false",
                        "user_disabled": "false", "user_guest": "false", "local_hour": "10", **qapaq}
    return event


class FrequencyChain:
    """Modelo de una regla padre con hijas de frecuencia (if_matched_sid) para calcular lo esperado."""

    def __init__(self, parent: int, rules: list[dict]) -> None:
        self.parent = parent
        self.rules = sorted(rules, key=lambda r: -r["level"])
        self.nodes: list[dict] = []

    def process(self, event: dict) -> int:
        for rule in self.rules:
            if not rule.get("cond", lambda e: True)(event):
                continue
            key = rule["same"](event)
            count, first = 0, None
            for node in reversed(self.nodes):
                if node["matched"] >= rule["level"]:
                    break
                if rule["same"](node["event"]) != key:
                    continue
                if count < rule["n"] - 2:
                    if count == 0:
                        first = node
                    count += 1
                    continue
                node["matched"] = rule["level"]
                if first is not None:
                    first["matched"] = rule["level"]
                for child in rule.get("children", []):
                    if child["cond"](event):
                        return child["id"]
                return rule["id"]
        self.nodes.append({"event": event, "matched": 0})
        return self.parent


def user_of(e: dict) -> str:
    return e["office365"]["UserId"]


def ip_of(e: dict) -> str:
    return e["office365"]["ClientIP"]


def qapaq(e: dict, key: str) -> str:
    return (e.get("qapaq") or {}).get(key, "")


# ---------------------------------------------------------------------------------------------- casos


def exfiltration() -> list[tuple[dict, str]]:
    cases: list[tuple[dict, str]] = []
    downloads = FrequencyChain(101900, [
        {"id": 101903, "level": 12, "n": 40, "same": user_of, "cond": lambda e: qapaq(e, "after_hours") == "true"},
        {"id": 101902, "level": 10, "n": 150, "same": user_of,
         "children": [{"id": 101904, "cond": lambda e: qapaq(e, "ip_first_seen") == "true"}]},
    ])
    guests = FrequencyChain(101905, [{"id": 101906, "level": 10, "n": 30, "same": user_of}])
    anon = FrequencyChain(101910, [{"id": 101911, "level": 10, "n": 50, "same": ip_of}])

    # Contexto de origen (TP) y control benigno.
    cases.append((o365("FileDownloaded", 6, "mario@qapaq-lab.example", ip="203.0.113.211"), "101908"))
    cases.append((o365("FileAccessed", 6, "mario@qapaq-lab.example", ip="203.0.113.221"), "101909"))
    cases.append((o365("FileAccessed", 6, "ex.empleado@qapaq-lab.example", qapaq={"user_disabled": "true"}), "101907"))
    cases.append((o365("FileAccessed", 6, "mario@qapaq-lab.example"), "91537"))
    # Invitado: 30 accesos en 10 min.
    guest = "socio_partner.example#ext#@qapaqlab.onmicrosoft.example"
    for _ in range(30):
        cases.append((o365("FileAccessed", 6, guest, ip="192.0.2.40"), str(guests.process({"office365": {"UserId": guest}}))))
    # Cuenta de sincronización aprobada (FP reducido) y descarga normal.
    cases.append((o365("FileSyncDownloadedFull", 6, "app@sharepoint", workload="OneDrive"), "101901"))
    one = o365("FileDownloaded", 6, "lucia@qapaq-lab.example")
    cases.append((one, str(downloads.process(one))))
    # Descarga masiva en horario (vía nativa, sin qapaq.*): 150 en 10 min.
    for i in range(150):
        e = o365("FileDownloaded", 6, "ana@qapaq-lab.example", workload="OneDrive" if i % 2 else "SharePoint")
        cases.append((e, str(downloads.process(e))))
    # Sincronización (cliente OneDrive): 499 marcas y la 500 en 10 min es P3 (calibración con datos reales);
    # la misma cantidad de descargas web habría sido P2.
    sync = FrequencyChain(101912, [{"id": 101913, "level": 7, "n": 500, "same": user_of,
                                    "children": [{"id": 101914, "cond": lambda e: qapaq(e, "ip_first_seen") == "true"}]}])
    for i in range(500):
        e = o365("FileSyncDownloadedFull", 6, "equipo.nuevo@qapaq-lab.example", workload="OneDrive",
                 ApplicationDisplayName="OneDrive SyncEngine", Platform="WinDesktop")
        cases.append((e, str(sync.process(e))))
    for i in range(500):
        e = o365("FileSyncDownloadedFull", 6, "viajero@qapaq-lab.example", workload="OneDrive", ip="192.0.2.88",
                 qapaq={"ip_first_seen": "true" if i == 499 else "false"})
        cases.append((e, str(sync.process(e))))
    # Fuera de horario (vía Purview): 40 en 30 min.
    for _ in range(40):
        e = o365("FileDownloaded", 6, "bruno@qapaq-lab.example", qapaq={"after_hours": "true", "local_hour": "23"})
        cases.append((e, str(downloads.process(e))))
    # Masiva desde una red nueva para el usuario (línea base del collector).
    for i in range(150):
        e = o365("FileDownloaded", 6, "carla@qapaq-lab.example", ip="192.0.2.77",
                 qapaq={"ip_first_seen": "true" if i == 149 else "false"})
        cases.append((e, str(downloads.process(e))))
    # Benigno: pocas descargas fuera de horario no alcanzan el umbral.
    for _ in range(10):
        e = o365("FileDownloaded", 6, "diego@qapaq-lab.example", qapaq={"after_hours": "true", "local_hour": "21"})
        cases.append((e, str(downloads.process(e))))
    # Enlaces anónimos usados: 50 desde la misma IP en 10 min; otra IP con un uso queda en la marca.
    for _ in range(50):
        e = o365("AnonymousLinkUsed", 14, "anonymous", ip="198.51.100.150", UserType=10)
        cases.append((e, str(anon.process(e))))
    e = o365("AnonymousLinkUsed", 14, "anonymous", ip="198.51.100.151", UserType=10)
    cases.append((e, str(anon.process(e))))
    return cases


def mass_deletion() -> list[tuple[dict, str]]:
    cases: list[tuple[dict, str]] = []
    deletes = FrequencyChain(101915, [
        {"id": 101918, "level": 13, "n": 300, "same": user_of},
        {"id": 101917, "level": 10, "n": 100, "same": user_of},
    ])
    purge = FrequencyChain(101919, [{"id": 101920, "level": 12, "n": 25, "same": user_of}])
    cases.append((o365("FileDeleted", 6, "app@sharepoint"), "101916"))
    e = o365("FileRecycled", 6, "lucia@qapaq-lab.example")
    cases.append((e, str(deletes.process(e))))
    for i in range(303):
        e = o365(["FileDeleted", "FileRecycled", "FolderRecycled", "FileDeletedFirstStageRecycleBin"][i % 4], 6,
                 "saboteador@qapaq-lab.example", workload="OneDrive" if i % 5 == 0 else "SharePoint")
        cases.append((e, str(deletes.process(e))))
    for i in range(25):
        e = o365("FileDeletedSecondStageRecycleBin" if i % 2 else "FolderDeletedSecondStageRecycleBin", 6,
                 "saboteador@qapaq-lab.example")
        cases.append((e, str(purge.process(e))))
    e = o365("FileDeletedSecondStageRecycleBin", 6, "lucia@qapaq-lab.example")
    cases.append((e, str(purge.process(e))))
    return cases


def external_sharing() -> list[tuple[dict, str]]:
    cases: list[tuple[dict, str]] = []
    anon = FrequencyChain(100515, [{"id": 101926, "level": 11, "n": 10, "same": user_of}])
    personal = FrequencyChain(101927, [{"id": 101930, "level": 12, "n": 5, "same": user_of}])
    cases.append((o365("AnonymousLinkCreated", 14, "marketing.publico@qapaq-lab.example"), "101925"))
    for _ in range(10):
        e = o365("AnonymousLinkCreated", 14, "rosa@qapaq-lab.example")
        cases.append((e, str(anon.process(e))))
    share = dict(TargetUserOrGroupType="Guest", EventData="<Type>Edit</Type>")
    e = o365("SharingInvitationCreated", 14, "pablo@qapaq-lab.example", TargetUserOrGroupName="amigo.personal@gmail.com", **share)
    cases.append((e, str(personal.process(e))))
    e = o365("AddedToSecureLink", 14, "pablo@qapaq-lab.example",
             TargetUserOrGroupName="amigo.personal_outlook.com#ext#@qapaqlab.onmicrosoft.example", **share)
    cases.append((e, str(personal.process(e))))
    cases.append((o365("SharingInvitationCreated", 14, "pablo@qapaq-lab.example", TargetUserOrGroupName="contacto@socio.example",
                       **share), "101928"))
    cases.append((o365("SharingInvitationCreated", 14, "marketing.publico@qapaq-lab.example",
                       TargetUserOrGroupName="prensa@medio.example", **share), "101929"))
    # Benignos: interno y un dominio que solo se parece a uno personal.
    cases.append((o365("SharingSet", 14, "pablo@qapaq-lab.example", TargetUserOrGroupName="colega@qapaq-lab.example",
                       TargetUserOrGroupType="Member"), "91544"))
    cases.append((o365("SharingInvitationCreated", 14, "pablo@qapaq-lab.example",
                       TargetUserOrGroupName="persona@gmail.com.socio.example", **share), "101928"))
    for i in range(5):
        e = o365("SharingInvitationCreated", 14, "tomas@qapaq-lab.example",
                 TargetUserOrGroupName=f"destino{i}@proton.me", **share)
        cases.append((e, str(personal.process(e))))
    return cases


def sharing_policy() -> list[tuple[dict, str]]:
    admin = "admin.sp@qapaq-lab.example"
    tenant = "https://qapaqlab-admin.sharepoint.example/"
    mp = lambda old, new: [{"Name": "SharingCapability", "OldValue": old, "NewValue": new}]  # noqa: E731
    return [
        (o365("SharingPolicyChanged", 4, admin, obj=tenant, ModifiedProperties=mp("Disabled", "ExistingExternalUserSharingOnly")), "101935"),
        (o365("SharingPolicyChanged", 4, admin, obj=tenant, ModifiedProperties=mp("ExternalUserSharingOnly", "ExternalUserAndGuestSharing")), "101936"),
        (o365("SharingPolicyChanged", 4, admin, obj=SITE,
              EventData="<SharingCapability><OldValue>Disabled</OldValue><NewValue>ExternalUserAndGuestSharing</NewValue></SharingCapability>"), "101937"),
        (o365("NetworkAccessPolicyChanged", 4, admin, obj=tenant), "101935"),
        (o365("SiteCollectionAdminAdded", 4, admin, obj=SITE, TargetUserOrGroupName="lucia@qapaq-lab.example"), "101938"),
        (o365("SiteCollectionAdminAdded", 4, "app@sharepoint", obj=ONEDRIVE, TargetUserOrGroupName="ana@qapaq-lab.example"), "101939"),
        (o365("SiteCollectionAdminAdded", 4, admin, obj=ONEDRIVE, TargetUserOrGroupName=admin), "101940"),
        (o365("SiteCollectionAdminAdded", 4, admin, obj=SITE,
              TargetUserOrGroupName="externo_socio.example#ext#@qapaqlab.onmicrosoft.example"), "101941"),
    ]


def labels_and_dlp() -> list[tuple[dict, str]]:
    cases: list[tuple[dict, str]] = []
    removed = FrequencyChain(101945, [{"id": 101947, "level": 12, "n": 10, "same": user_of}])
    f1 = f"{SITE}/Documentos/plan-confidencial.docx"
    e = o365("FileSensitivityLabelRemoved", 6, "leo@qapaq-lab.example", obj=f1)
    cases.append((e, str(removed.process(e))))
    cases.append((o365("AnonymousLinkCreated", 14, "leo@qapaq-lab.example", obj=f1), "101948"))
    cases.append((o365("AnonymousLinkCreated", 14, "maria@qapaq-lab.example"), "100515"))
    f3 = f"{SITE}/Documentos/nomina.xlsx"
    e = o365("FileSensitivityLabelRemoved", 6, "nora@qapaq-lab.example", obj=f3)
    cases.append((e, str(removed.process(e))))
    cases.append((o365("SharingInvitationCreated", 14, "nora@qapaq-lab.example", obj=f3, TargetUserOrGroupType="Guest",
                       TargetUserOrGroupName="nora.casa@gmail.com"), "101948"))
    label = lambda kind: {"SensitivityLabelEventData": {"LabelEventType": kind, "SensitivityLabelId": "11111111-0000-4000-8000-000000000002",  # noqa: E731
                                                       "OldSensitivityLabelId": "11111111-0000-4000-8000-000000000001"}}
    cases.append((o365("SensitivityLabelUpdated", 83, "leo@qapaq-lab.example", workload="SharePoint", **label(2)), "101946"))
    cases.append((o365("SensitivityLabelUpdated", 83, "leo@qapaq-lab.example", workload="SharePoint", **label(1)), "91608"))
    for i in range(10):
        e = o365("FileSensitivityLabelRemoved", 6, "quitaetiquetas@qapaq-lab.example", obj=f"{SITE}/Documentos/x{i}.docx")
        cases.append((e, str(removed.process(e))))
    policy = lambda severity: [{"PolicyId": "p1", "PolicyName": "Datos personales", "Rules": [  # noqa: E731
        {"RuleId": "r1", "RuleName": "DNI", "Severity": severity, "Actions": ["NotifyUser"]}]}]
    cases.append((o365("DLPRuleMatch", 11, "leo@qapaq-lab.example", PolicyDetails=policy("Low")), "101949"))
    cases.append((o365("DLPRuleMatch", 11, "leo@qapaq-lab.example", PolicyDetails=policy("High")), "101950"))
    cases.append((o365("DLPRuleMatch", 11, "leo@qapaq-lab.example", PolicyDetails=policy("Medium"),
                       ExceptionInfo={"Reason": "Override", "Justification": "BusinessJustification"}), "101951"))
    return cases


def posture() -> list[tuple[dict, str]]:
    def ev(event_type: str, source: str = "sharepoint_posture", **body) -> dict:
        return {"qapaq": {"vendor": "m365", "source": source, "event_type": event_type, "collected_at": "2026-11-09T15:00:00Z",
                        **body.pop("qapaq", {})}, **body}

    cap = lambda feature, status, previous, changed, missing: {"capability": {  # noqa: E731
        "feature": feature, "status": status, "previous": previous, "changed": changed, "missing": missing}}
    site = {"id": "qapaqlab.sharepoint.example,1,2", "url": SITE, "name": "Finanzas", "created": "2026-11-08T10:00:00Z",
            "personal": "false", "recent": "true"}
    item = {"name": "plan.xlsx", "url": f"{SITE}/Documentos/plan.xlsx", "is_folder": "false"}
    return [
        (ev("capability", "sharepoint_audit", qapaq=cap("audit_graph_sharepoint", "blocked", "unknown", "false",
                                                      "AuditLogsQuery-SharePoint.Read.All")), "101969"),
        (ev("capability", "sharepoint_audit", qapaq=cap("audit_graph_sharepoint", "blocked", "enabled", "true",
                                                      "AuditLogsQuery-SharePoint.Read.All")), "101970"),
        (ev("capability", qapaq=cap("sites", "enabled", "blocked", "true", "")), "101969"),
        (ev("tenant_settings_snapshot", sharepoint={"tenant": {"sharing_capability": "existingExternalUserSharingOnly",
                                                              "anyone_links_enabled": "false"}}), "101961"),
        (ev("tenant_settings_snapshot", sharepoint={"tenant": {"sharing_capability": "externalUserAndGuestSharing",
                                                              "anyone_links_enabled": "true"}}), "101972"),
        (ev("tenant_setting_changed", sharepoint={"change": {"setting": "sharingCapability", "old": "externalUserAndGuestSharing",
                                                            "new": "existingExternalUserSharingOnly", "direction": "strengthened"}}), "101962"),
        (ev("tenant_setting_changed", sharepoint={"change": {"setting": "sharingCapability", "old": "existingExternalUserSharingOnly",
                                                            "new": "externalUserAndGuestSharing", "direction": "weakened"}}), "101963"),
        (ev("inventory_snapshot", sharepoint={"inventory": {"sites": "42", "known_findings": "3"}}), "101971"),
        (ev("site_created", sharepoint={"site": site}), "101964"),
        (ev("recent_site_external_sharing", sharepoint={"site": site}), "101965"),
        (ev("sharing_finding", sharepoint={"finding": {"kind": "anonymous_link", "key": "k1"}, "site": site, "item": item,
                                           "link": {"scope": "anonymous", "type": "view", "roles": "read"}}), "101966"),
        (ev("sharing_finding", sharepoint={"finding": {"kind": "anonymous_link", "key": "k2"}, "site": site, "item": item,
                                           "link": {"scope": "anonymous", "type": "edit", "roles": "write"}}), "101967"),
        (ev("sharing_finding", sharepoint={"finding": {"kind": "external_permission", "key": "k3"}, "site": site, "item": item,
                                           "link": {"scope": "direct", "roles": "read"},
                                           "grantee": {"email": "contacto@socio.example"}}), "101968"),
        # Un registro de auditoría del collector NO es postura: sigue la cadena oficial de office365.
        (o365("FileAccessed", 6, "lucia@qapaq-lab.example", qapaq={}), "91537"),
    ]


SUITES = {
    "exfiltration": exfiltration,
    "mass-deletion": mass_deletion,
    "external-sharing": external_sharing,
    "sharing-policy-and-admins": sharing_policy,
    "labels-and-dlp": labels_and_dlp,
    "posture": posture,
}


def main() -> None:
    for name, build in SUITES.items():
        cases = build()
        folder = DET / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "fixtures.jsonl").write_text(
            "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e, _ in cases),
            encoding="utf-8", newline="\n")
        (folder / "expected.txt").write_text("".join(f"{want}\n" for _, want in cases), encoding="utf-8", newline="\n")
        print(f"{name}: {len(cases)} casos")


if __name__ == "__main__":
    main()
