"""Invariantes de los perfiles de agente y del paquete de despliegue QAPAQ.

No sustituye a verify-agent-conf ni a un piloto: comprueba en cada PR que ningún perfil
reabre Active Response, comandos remotos o canales duplicados, y que el paquete nunca
transporta la contraseña de inscripción en argv ni en propiedades del MSI.
"""

from __future__ import annotations

import json
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
AGENTS = ROOT / "infra/wazuh/agents"
EXPECTED_GROUPS = {
    "qapaq-dc",
    "qapaq-srv-core",
    "qapaq-srv-db",
    "qapaq-srv-web",
    "qapaq-ws-sensitive",
    "qapaq-ws-general",
    "qapaq-linux-server",
    "qapaq-laptop-remote",
}


def load_profile(group: str) -> ET.Element:
    text = (AGENTS / "shared" / group / "agent.conf").read_text(encoding="utf-8")
    # agent.conf admite varios <agent_config> en la raíz; se envuelven para parsear.
    return ET.fromstring(f"<root>{text}</root>")


class AgentProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads((AGENTS / "profile-catalog.json").read_text(encoding="utf-8"))
        cls.profiles = {group: load_profile(group) for group in EXPECTED_GROUPS}

    def test_catalog_and_shared_directories_match_the_eight_profiles(self) -> None:
        on_disk = {path.name for path in (AGENTS / "shared").iterdir() if path.is_dir()}
        self.assertEqual(on_disk, EXPECTED_GROUPS)
        self.assertEqual({profile["group"] for profile in self.catalog["profiles"]}, EXPECTED_GROUPS)
        self.assertFalse(self.catalog["safety"]["activeResponse"])
        self.assertFalse(self.catalog["safety"]["remoteCommands"])

    def test_each_os_block_has_one_localfile_per_location(self) -> None:
        for group, root in self.profiles.items():
            for block in root.findall("agent_config"):
                with self.subTest(group=group, os=block.get("os")):
                    locations = [node.findtext("location") for node in block.findall("localfile")]
                    self.assertEqual(len(locations), len(set(locations)), locations)

    def test_profiles_are_monitor_only_and_never_run_commands(self) -> None:
        for group, root in self.profiles.items():
            for block in root.findall("agent_config"):
                with self.subTest(group=group, os=block.get("os")):
                    self.assertEqual(block.findtext("active-response/disabled"), "yes")
                    formats = {node.findtext("log_format") for node in block.findall("localfile")}
                    self.assertTrue(formats.isdisjoint({"command", "full_command"}))
                    self.assertIsNone(block.find("wodle[@name='command']"))
                    self.assertEqual(block.findtext("wodle[@name='syscollector']/disabled"), "no")
                    self.assertEqual(block.findtext("wodle[@name='syscollector']/processes"), "no")
                    self.assertEqual(block.findtext("sca/enabled"), "yes")
                    self.assertEqual(block.findtext("syscheck/disabled"), "no")
                    self.assertIsNotNone(block.find("client_buffer"))
                    self.assertEqual(block.findtext("labels/label[@key='qapaq_profile']"), group.removeprefix("qapaq-"))

    def test_rootcheck_only_on_linux_and_windows_channels_are_filtered(self) -> None:
        for group, root in self.profiles.items():
            for block in root.findall("agent_config"):
                with self.subTest(group=group, os=block.get("os")):
                    windows = block.get("os") == "^Windows"
                    self.assertEqual(block.findtext("rootcheck/disabled"), "yes" if windows else "no")
                    for node in block.findall("localfile"):
                        if node.findtext("log_format") == "eventchannel":
                            # Sin consulta, un canal de Windows envía todo: es el mayor riesgo de costo.
                            self.assertTrue((node.findtext("query") or "").startswith("*[System["))

    def test_security_channel_keeps_events_that_qapaq_rules_consume(self) -> None:
        dc = load_profile("qapaq-dc").find("agent_config/localfile[location='Security']/query").text
        for event_id in ("1102", "4719", "4771", "4662", "4768", "4769", "4624", "5136"):
            self.assertIn(event_id, dc)
        # Rangos que cubren 4728/4732/4756 (grupos) y 4740 (bloqueo).
        self.assertIn("EventID >= 4720 and EventID <= 4767", dc)
        general = load_profile("qapaq-ws-general").find("agent_config/localfile[location='Security']/query").text
        self.assertNotIn("4662", general)
        self.assertNotIn("6416", general)
        sensitive = load_profile("qapaq-ws-sensitive").find("agent_config/localfile[location='Security']/query").text
        self.assertIn("6416", sensitive)

    def test_fim_never_reports_diffs_of_files_that_can_hold_secrets(self) -> None:
        for group, root in self.profiles.items():
            for node in root.iter("directories"):
                if node.get("report_changes") == "yes":
                    with self.subTest(group=group, path=node.text):
                        self.assertNotRegex(node.text or "", r"(?i)inetpub|web\.config|appsettings|shadow|/etc/passwd")

    def test_group_mapping_template_only_targets_known_groups(self) -> None:
        mapping = json.loads((AGENTS / "group-mapping.example.json").read_text(encoding="utf-8"))
        self.assertIn(mapping["defaultGroup"], EXPECTED_GROUPS)
        for rule in mapping["rules"]:
            with self.subTest(rule=rule["id"]):
                self.assertIn(rule["match"], {"ou", "hostname"})
                self.assertIn(rule["group"], EXPECTED_GROUPS - {"qapaq-linux-server"})
                re.compile(rule["pattern"].replace("(?i)", ""))


class DeploymentPackageTests(unittest.TestCase):
    def test_manifest_pins_agent_4_14_8_and_refuses_unverified_hashes(self) -> None:
        manifest = json.loads((AGENTS / "deploy/package-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["wazuhVersion"], "4.14.8")
        self.assertEqual(manifest["manager"], "app.jappi.net.pe")
        ids = {artifact["id"] for artifact in manifest["artifacts"]}
        self.assertEqual(ids, {"wazuh-agent-windows", "wazuh-agent-deb-amd64", "wazuh-agent-rpm-x86_64", "sysmon"})
        for artifact in manifest["artifacts"]:
            with self.subTest(artifact=artifact["id"]):
                self.assertTrue(artifact["url"].startswith("https://"))
                self.assertRegex(artifact["sha256"], r"^([0-9a-f]{64}|TO_BE_PROVIDED)$")
                if artifact["id"].startswith("wazuh-agent"):
                    self.assertIn("4.14.8", artifact["file"])
        pending = any(len(artifact["sha256"]) != 64 for artifact in manifest["artifacts"])
        self.assertEqual(manifest["status"], "hashes-pending" if pending else "pinned")

    def test_installers_never_put_the_enrollment_password_in_argv_or_msi_properties(self) -> None:
        windows = (AGENTS / "deploy/windows/Install-QapaqWazuhAgent.ps1").read_text(encoding="utf-8")
        linux = (AGENTS / "deploy/linux/install-qapaq-wazuh-agent.sh").read_text(encoding="utf-8")
        for script in (windows, linux):
            code = "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))
            self.assertNotIn("WAZUH_REGISTRATION_PASSWORD", code)
        self.assertIn("Remove-EnrollmentPassword", windows)
        self.assertIn("Get-AuthenticodeSignature", windows)
        self.assertIn("Get-FileHash", windows)
        self.assertIn("sha256sum --check", linux)
        self.assertIn("shred -u", linux)
        self.assertIn("curl -sf -K -", linux)

    def test_sysmon_config_is_valid_xml_and_keeps_high_volume_events_opt_in(self) -> None:
        root = ET.parse(AGENTS / "deploy/windows/sysmon/qapaq-sysmon.xml").getroot()
        self.assertEqual(root.tag, "Sysmon")
        self.assertEqual(root.get("schemaversion"), "4.90")
        for event in ("NetworkConnect", "ImageLoad", "DnsQuery", "FileCreate", "RegistryEvent"):
            with self.subTest(event=event):
                self.assertEqual({node.get("onmatch") for node in root.iter(event)} - {"exclude"}, {"include"})


if __name__ == "__main__":
    unittest.main()
