"""Invariantes de las reglas de prioridad QAPAQ (infra/wazuh/priority).

`wazuh-logtest` prueba qué regla gana; estas pruebas protegen el contrato que no ve el motor:
rango de IDs, padres existentes, coherencia entre etiquetas de contexto y listas CDB
consultadas, sentido de cada ajuste respecto al nivel del padre y cobertura de los casos.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PRIORITY = ROOT / "infra/wazuh/priority"
RULES = PRIORITY / "rules/qapaq_priority_rules.xml"
DEPENDENCIES = (
    ROOT / "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
    ROOT / "infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
    ROOT / "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
    ROOT / "wazuh/office365/rules/qapaq_office365_rules.xml",
)
# Padres del ruleset oficial 4.14.8 (0580-win-security_rules.xml), con su nivel.
OFFICIAL_PARENTS = {"60106": 3, "60115": 9}
LISTS = {
    "qapaq-critical-assets",
    "qapaq-privileged-identities",
    "qapaq-sensitive-workstations",
    "qapaq-internet-facing",
}
CONTEXT_GROUP_LIST = {
    "qapaq_ctx_critical_asset": "qapaq-critical-assets",
    "qapaq_ctx_privileged_identity": "qapaq-privileged-identities",
    "qapaq_ctx_sensitive_workstation": "qapaq-sensitive-workstations",
    "qapaq_ctx_internet_facing": "qapaq-internet-facing",
}
# 101625 depende de 101213 (frecuencia con ignore=300): una sola ráfaga por sesión de
# logtest, que ya consume 101626. Se cubre en el piloto.
NOT_IN_LOGTEST = {"101625"}
# Ruta completa: en Windows, CreateProcess encontraría antes el bash de WSL en System32.
BASH = shutil.which("bash")


def rules_of(path: Path) -> dict[str, ET.Element]:
    return {rule.get("id"): rule for rule in ET.parse(path).getroot().iter("rule")}


def groups_of(rule: ET.Element) -> set[str]:
    return {group for node in rule.findall("group") for group in (node.text or "").split(",") if group}


class PriorityRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rules = rules_of(RULES)
        cls.parents: dict[str, int] = dict(OFFICIAL_PARENTS)
        for path in DEPENDENCIES:
            cls.parents.update({rid: int(rule.get("level")) for rid, rule in rules_of(path).items()})

    def test_ids_are_unique_inside_the_reserved_range_and_do_not_collide(self) -> None:
        self.assertGreaterEqual(len(self.rules), 30)
        for rule_id in self.rules:
            self.assertTrue(101600 <= int(rule_id) <= 101699, rule_id)
        others: set[str] = set()
        for path in list((ROOT / "infra/wazuh").rglob("*.xml")) + list((ROOT / "wazuh").rglob("*rules*.xml")):
            if path.resolve() != RULES.resolve():
                try:
                    others.update(rules_of(path))
                except ET.ParseError:
                    continue
        self.assertEqual(set(self.rules) & others, set())

    def test_every_parent_exists_and_the_level_moves_in_the_declared_direction(self) -> None:
        for rule_id, rule in self.rules.items():
            groups = groups_of(rule)
            level = int(rule.get("level"))
            parents = [p.strip() for p in (rule.findtext("if_sid") or "").split(",") if p.strip()]
            with self.subTest(rule=rule_id):
                self.assertTrue(rule.findtext("description", "").startswith("QAPAQ"))
                self.assertIsNotNone(rule.find("options"))
                if not parents:
                    # Señales nuevas (webshell, inhibición de recuperación) parten de sysmon_event1.
                    self.assertEqual(rule.findtext("if_group"), "sysmon_event1")
                    continue
                for parent in parents:
                    self.assertIn(parent, {**self.parents, **{k: int(v.get("level")) for k, v in self.rules.items()}})
                parent_level = {**self.parents, **{k: int(v.get("level")) for k, v in self.rules.items()}}[parents[0]]
                if "qapaq_priority_lowered" in groups:
                    self.assertLess(level, parent_level)
                    self.assertTrue(groups.isdisjoint(CONTEXT_GROUP_LIST))
                elif "qapaq_priority_elevated" in groups:
                    self.assertGreater(level, parent_level)
                else:
                    self.assertGreaterEqual(level, parent_level)

    def test_context_tags_are_backed_by_a_positive_lookup_of_the_matching_list(self) -> None:
        for rule_id, rule in self.rules.items():
            lookups = {
                Path(node.text or "").name: node.get("lookup")
                for node in rule.findall("list")
            }
            with self.subTest(rule=rule_id):
                self.assertTrue(set(lookups) <= LISTS, lookups)
                for group, list_name in CONTEXT_GROUP_LIST.items():
                    if group in groups_of(rule):
                        self.assertIn(lookups.get(list_name), {"match_key", "match_key_value"})

    def test_synthetic_list_templates_exist_and_contain_only_example_data(self) -> None:
        for name in LISTS:
            with self.subTest(list=name):
                lines = (PRIORITY / "lists" / f"{name}.example").read_text(encoding="utf-8").splitlines()
                self.assertTrue(lines)
                for line in lines:
                    key, _, value = line.rpartition(":")
                    self.assertTrue(value)
                    if "." in key or "@" in key:
                        self.assertTrue(key.lower().endswith(".example"), key)

    def test_logtest_cases_and_expectations_line_up_and_cover_every_rule(self) -> None:
        cases = (PRIORITY / "tests/logtest-cases.jsonl").read_text(encoding="utf-8").splitlines()
        expected = [
            re.split(r"[\t#]", line, maxsplit=1)[0].strip()
            for line in (PRIORITY / "tests/expected-rules.txt").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(cases), len(expected))
        for line in cases:
            json.loads(line)
            self.assertNotRegex(line, r"(?i)qapaq\.pe|jappi")
        covered = {rule for item in expected for rule in item.split("|")}
        self.assertEqual(set(self.rules) - covered - NOT_IN_LOGTEST, set())
        labels = (PRIORITY / "tests/expected-rules.txt").read_text(encoding="utf-8")
        for kind in ("sube:", "mantiene:", "baja:"):
            self.assertIn(kind, labels)

    @unittest.skipUnless(BASH, "requiere bash")
    def test_apply_script_renders_case_variants_and_rejects_example_keys_in_real_lists(self) -> None:
        with tempfile.TemporaryDirectory() as lists, tempfile.TemporaryDirectory() as rendered:
            for name in LISTS:
                shutil.copy(PRIORITY / "lists" / f"{name}.example", Path(lists) / name)
            env = {
                **os.environ,
                "QAPAQ_APPLY_MODE": "render",
                "QAPAQ_PRIORITY_LISTS_DIR": Path(lists).as_posix(),
                "QAPAQ_PRIORITY_RENDER_DIR": Path(rendered).as_posix(),
            }
            script = (PRIORITY / "apply-priority.sh").as_posix()
            refused = subprocess.run([BASH, script], env=env, capture_output=True, text=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn(".example", refused.stderr)
            accepted = subprocess.run(
                [BASH, script], env={**env, "QAPAQ_PRIORITY_ALLOW_EXAMPLE": "true"}, capture_output=True, text=True
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            critical = (Path(rendered) / "qapaq-critical-assets").read_text(encoding="utf-8")
            self.assertIn("dc01.qapaq-lab.example:dc", critical)
            self.assertIn("DC01.QAPAQ-LAB.EXAMPLE:dc", critical)
            self.assertIn("DC01.qapaq-lab.example:dc", critical)


if __name__ == "__main__":
    unittest.main()
