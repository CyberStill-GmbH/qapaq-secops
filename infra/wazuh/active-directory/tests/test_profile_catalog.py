from __future__ import annotations

import json
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = ROOT / "infra/wazuh/active-directory/profile-catalog.json"


class ActiveDirectoryProfileCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

    def test_all_profile_artifacts_are_explicitly_disabled_and_parse_as_xml(self) -> None:
        self.assertEqual(self.catalog["status"], "candidate-disabled")
        self.assertEqual(self.catalog["wazuhVersion"], "4.14.8")
        self.assertEqual(
            self.catalog["bundleBehavior"],
            "artifact-only-not-installed-or-shared-with-agents",
        )
        self.assertEqual(self.catalog["activation"], "owner-approval-and-domain-controller-pilot-required")
        self.assertFalse(self.catalog["safety"]["activeResponse"])
        self.assertFalse(self.catalog["safety"]["rollout"])
        self.assertFalse(self.catalog["safety"]["installerAppliesAgentProfiles"])
        self.assertTrue(self.catalog["safety"]["requiresDomainOwnerApproval"])
        self.assertTrue(self.catalog["safety"]["requiresPilotVolumeAndFalsePositiveReview"])

        profiles = self.catalog["profiles"]
        self.assertEqual({profile["status"] for profile in profiles}, {"candidate-disabled"})
        self.assertEqual(len({profile["id"] for profile in profiles}), len(profiles))
        self.assertEqual(len({profile["artifactPath"] for profile in profiles}), len(profiles))
        for profile in profiles:
            with self.subTest(profile=profile["id"]):
                path = ROOT / profile["path"]
                self.assertTrue(path.is_file(), profile["path"])
                parsed = ET.parse(path).getroot()
                self.assertEqual(parsed.tag, "agent_config")
                self.assertIsNone(parsed.find(".//active-response"))

    def test_windows_base_and_dc_profiles_do_not_duplicate_or_collect_unapproved_sources(self) -> None:
        profile_by_id = {profile["id"]: profile for profile in self.catalog["profiles"]}
        base = ET.parse(ROOT / profile_by_id["windows-pilot-base"]["path"]).getroot()
        dc = ET.parse(ROOT / profile_by_id["windows-domain-controller"]["path"]).getroot()
        sysmon = ET.parse(ROOT / profile_by_id["windows-sysmon-pilot"]["path"]).getroot()

        def channels(root: ET.Element) -> list[str]:
            return [node.text or "" for node in root.findall(".//localfile/location")]

        self.assertEqual(channels(base).count("Security"), 1)
        self.assertEqual(channels(base).count("System"), 1)
        self.assertEqual(base.findtext(".//wodle[@name='syscollector']/disabled"), "no")
        self.assertIsNone(base.find(".//syscollector"))
        self.assertNotIn("Microsoft-Windows-PowerShell/Operational", channels(base))
        self.assertEqual(channels(dc), [])
        self.assertEqual(dc.findtext(".//label[@key='qapaq_profile']"), "active-directory-pilot")
        self.assertEqual(channels(sysmon), ["Microsoft-Windows-Sysmon/Operational"])
        self.assertEqual(
            sysmon.findtext(".//localfile/query"),
            "Event/System[EventID=1]",
        )

        all_profiles = [base, dc, sysmon]
        all_channels = [channel for profile in all_profiles for channel in channels(profile)]
        self.assertNotIn("Directory Service", all_channels)
        self.assertNotIn("DNS Server", all_channels)
        self.assertNotIn("Microsoft-Windows-GroupPolicy/Operational", all_channels)
        self.assertNotIn("Microsoft-Windows-PowerShell/Operational", all_channels)

    def test_event_mapping_matches_existing_local_rule_ids(self) -> None:
        rule_ids: set[str] = set()
        for path in (ROOT / "infra/wazuh").rglob("*.xml"):
            try:
                rule_ids.update(
                    rule.attrib["id"]
                    for rule in ET.parse(path).getroot().findall(".//rule")
                    if "id" in rule.attrib
                )
            except ET.ParseError as error:
                self.fail(f"invalid Wazuh XML at {path.relative_to(ROOT)}: {error}")

        ad_rules = ET.parse(ROOT / "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml").getroot()
        ad_rule_ids = {rule.attrib["id"] for rule in ad_rules.findall(".//rule")}
        self.assertEqual(ad_rule_ids, {str(value) for value in range(101300, 101308)})

        mappings = self.catalog["eventRuleMappings"]
        actual = {
            (mapping["channel"], tuple(mapping["eventIds"])): tuple(mapping["qapaqRuleRefs"])
            for mapping in mappings
        }
        expected = {
            ("Security", ("4728", "4732", "4756")): ("101300",),
            ("Security", ("4719",)): ("101301",),
            ("Security", ("1102",)): ("101302",),
            ("Security", ("5136", "5137", "5141")): ("101303",),
            ("Security", ("4769",)): ("101304",),
            ("Security", ("4768",)): ("101305",),
            ("Security", ("4662",)): ("101306",),
            ("Security", ("4771",)): ("101307",),
            ("System", ("7045",)): (),
            ("Microsoft-Windows-Sysmon/Operational", ("1",)): ("101100",),
        }
        self.assertEqual(actual, expected)
        expected_parents = {
            "101300": "60113",
            "101301": "60112",
            "101302": "60103",
            "101303": "60103",
            "101304": "60106",
            "101305": "60103",
            "101306": "60103",
            "101307": "60104",
        }
        for mapping in mappings:
            for rule_id in mapping["qapaqRuleRefs"]:
                self.assertIn(rule_id, rule_ids)
                if mapping["channel"] == "Security":
                    rule = next(rule for rule in ad_rules.findall(".//rule") if rule.attrib["id"] == rule_id)
                    self.assertEqual(rule.findtext("if_sid"), expected_parents[rule_id])
        self.assertEqual(
            next(mapping for mapping in mappings if mapping["channel"] == "System")["upstreamRuleRefs"],
            ["61138"],
        )
        self.assertEqual(
            self.catalog["ruleSources"]["wazuhUpstream"],
            "https://github.com/wazuh/wazuh/blob/v4.14.8/ruleset/rules/0590-win-system_rules.xml",
        )

        for mapping in mappings:
            if mapping["channel"] != "Security":
                continue
            rule_id = mapping["qapaqRuleRefs"][0]
            rule = next(rule for rule in ad_rules.findall(".//rule") if rule.attrib["id"] == rule_id)
            configured_event_ids = {
                value
                for expression in rule.findall("field")
                if expression.attrib.get("name") == "win.system.eventID"
                for value in re.findall(r"\^([0-9]+)\$", expression.text or "")
            }
            self.assertEqual(configured_event_ids, set(mapping["eventIds"]), rule_id)

        sysmon_rule = next(
            rule
            for path in (ROOT / "infra/wazuh").rglob("*.xml")
            for rule in ET.parse(path).getroot().findall(".//rule")
            if rule.attrib.get("id") == "101100"
        )
        self.assertEqual(sysmon_rule.findtext("if_group"), "sysmon_event1")
        powershell = next(
            source
            for source in self.catalog["sourceMappings"]
            if source["channel"] == "Microsoft-Windows-PowerShell/Operational"
        )
        self.assertEqual(powershell["eventIds"], [])
        self.assertEqual(powershell["excludedEventIds"], ["400", "403", "4103", "4104"])


if __name__ == "__main__":
    unittest.main()
