package resolve

import (
	"testing"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

func keys(o model.Observation) map[string]bool {
	out := map[string]bool{}
	for _, e := range o.Entities {
		out[e.Key()] = true
	}
	return out
}

func hasStage(o model.Observation, s model.Stage) bool {
	for _, x := range o.Stages {
		if x == s {
			return true
		}
	}
	return false
}

func doc(rule string, level float64, groups []any, agent map[string]any, data map[string]any) Doc {
	d := Doc{
		"timestamp": "2026-11-04T10:00:00.000+0000",
		"id":        "1.1",
		"rule":      map[string]any{"id": rule, "level": level, "groups": groups},
		"agent":     agent,
	}
	if data != nil {
		d["data"] = data
	}
	return d
}

var manager = map[string]any{"id": "000", "name": "qapaq-manager"}

func TestNormalizeUser(t *testing.T) {
	r := New(map[string]string{"iam:061098277310/ci-deploy": "svc-ci@qapaq.pe", "jdoe": "john.doe@qapaq.pe"}, "qapaq.pe")
	cases := map[string]string{
		"Victima@QAPAQ.Pe": "victima@qapaq.pe",
		"arn:aws:sts::061098277310:assumed-role/AWSReservedSSO_SOC-PowerUser_abc/Cesar@QAPAQ.pe": "cesar@qapaq.pe",
		"arn:aws:sts::061098277310:assumed-role/deploy-role/i-0abc":                                 "iam:061098277310/deploy-role/i-0abc",
		"arn:aws:iam::061098277310:user/ci-deploy":                                                  "svc-ci@qapaq.pe",
		"arn:aws:iam::061098277310:user/other":                                                      "iam:061098277310/other",
		"arn:aws:iam::061098277310:root":                                                            "aws-root:061098277310",
		`CORP\jdoe`:                                                                                 "john.doe@qapaq.pe",
		`CORP\mary`:                                                                                 "mary@qapaq.pe",
		"PC-EP-A$":                                                                                  "",
		"SYSTEM":                                                                                    "",
		"-":                                                                                         "",
	}
	for raw, want := range cases {
		if got := r.NormalizeUser(raw); got != want {
			t.Errorf("NormalizeUser(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestNormalizeIPAndHost(t *testing.T) {
	if NormalizeIP("::ffff:10.0.0.1") != "10.0.0.1" || NormalizeIP("127.0.0.1") != "" || NormalizeIP("nope") != "" {
		t.Fatal("ip normalization")
	}
	if !IsInternalIP("10.1.2.3") || !IsInternalIP("100.64.1.1") || IsInternalIP("203.0.113.5") {
		t.Fatal("internal ip classification")
	}
	if NormalizeHost("PC-EP-A.corp.example") != "pc-ep-a" || NormalizeHost("10.0.0.1") != "" || NormalizeHost("i-0123456789abcdef0") != "i-0123456789abcdef0" {
		t.Fatal("host normalization")
	}
}

func TestSSOSessionResolvesToUPNAndRole(t *testing.T) {
	r := New(nil, "")
	o, ok := r.Observe(doc("101711", 3, []any{"aws", "authentication_success"}, manager, map[string]any{
		"qapaq": map[string]any{"vendor": "aws"},
		"aws": map[string]any{"console_login": "Success", "source_ip": "198.51.100.7",
			"principal_arn": "arn:aws:sts::061098277310:assumed-role/AWSReservedSSO_SOC-PowerUser_abc/victima@qapaq.pe"},
	}))
	if !ok {
		t.Fatal("not observed")
	}
	k := keys(o)
	for _, want := range []string{"user:victima@qapaq.pe", "ip:198.51.100.7", "cloud:arn:aws:iam::061098277310:role/awsreservedsso_soc-poweruser_abc"} {
		if !k[want] {
			t.Errorf("missing %s in %v", want, k)
		}
	}
	if k["host:qapaq-manager"] {
		t.Error("the manager collector must not be attached to provider events")
	}
	if o.Source != "aws" || !hasStage(o, model.StageAuthSuccess) {
		t.Errorf("source/stage: %s %v", o.Source, o.Stages)
	}
}

func TestHostAliasesMergeAgentBitdefenderAndEC2Name(t *testing.T) {
	r := New(nil, "")
	agent := map[string]any{"id": "003", "name": "pc-ep-a", "ip": "10.89.0.30"}
	o1, _ := r.Observe(doc("60106", 3, []any{"windows"}, agent, nil))
	if !keys(o1)["host:pc-ep-a"] {
		t.Fatalf("agent host: %v", keys(o1))
	}
	o2, _ := r.Observe(doc("101720", 10, []any{"bitdefender"}, manager, map[string]any{
		"qapaq":         map[string]any{"vendor": "bitdefender"},
		"bitdefender": map[string]any{"endpoint": map[string]any{"name": "PC-EP-A-LAPTOP", "ip": "10.89.0.30", "antimalware_disabled": true}},
	}))
	// The Bitdefender name differs but the private IP is shared: one host.
	if got := r.Canonical("host:pc-ep-a-laptop"); got != r.Canonical("host:pc-ep-a") {
		t.Fatalf("bitdefender endpoint not merged: %s vs %s", got, r.Canonical("host:pc-ep-a"))
	}
	if !hasStage(o2, model.StageProtectionOff) {
		t.Errorf("stages %v", o2.Stages)
	}
	if len(r.DrainMerges()) == 0 {
		t.Error("expected merges to be reported")
	}
	// EC2 private DNS name links to its IP; a private srcip then resolves to the host.
	r.Observe(doc("5402", 3, []any{"sudo"}, map[string]any{"id": "004", "name": "ip-10-0-1-5"}, nil))
	o3, _ := r.Observe(doc("5710", 5, []any{"sshd", "invalid_login"}, map[string]any{"id": "001", "name": "bastion"}, map[string]any{"srcip": "10.0.1.5", "srcuser": "admin"}))
	if !keys(o3)["host:ip-10-0-1-5"] || keys(o3)["ip:10.0.1.5"] {
		t.Errorf("private source IP should resolve to the EC2 host: %v", keys(o3))
	}
}

func TestPublicAgentIPIsNotAHostAlias(t *testing.T) {
	r := New(nil, "")
	r.Observe(doc("1", 3, []any{"syslog"}, map[string]any{"id": "001", "name": "web-1", "ip": "203.0.113.9"}, nil))
	if r.Canonical("ip:203.0.113.9") != "ip:203.0.113.9" {
		t.Fatal("a public (possibly NAT) IP must not alias a host")
	}
}

func TestFailedSSHIgnoresAttackerUsernamesAndScopesLocalUsers(t *testing.T) {
	r := New(nil, "")
	node := map[string]any{"id": "001", "name": "qapaq-soc-dev-node", "ip": "10.89.0.10"}
	o, _ := r.Observe(doc("5710", 5, []any{"syslog", "sshd", "invalid_login", "authentication_failed"}, node, map[string]any{"srcip": "203.0.113.77", "srcuser": "admin"}))
	k := keys(o)
	if !k["ip:203.0.113.77"] || !k["host:qapaq-soc-dev-node"] || len(k) != 2 {
		t.Errorf("entities: %v", k)
	}
	if !hasStage(o, model.StageSSHBruteForce) || !hasStage(o, model.StageAuthFailure) {
		t.Errorf("stages: %v", o.Stages)
	}
	o2, _ := r.Observe(doc("5402", 3, []any{"syslog", "sudo"}, node, map[string]any{"srcuser": "ubuntu"}))
	if !keys(o2)["user:local:qapaq-soc-dev-node/ubuntu"] {
		t.Errorf("local user not scoped to host: %v", keys(o2))
	}
}

func TestCloudflareBlockAndScanStages(t *testing.T) {
	r := New(nil, "")
	o, _ := r.Observe(doc("101501", 6, []any{"cloudflare"}, manager, map[string]any{
		"qapaq":        map[string]any{"vendor": "cloudflare"},
		"cloudflare": map[string]any{"zone_name": "Example.test", "firewall": map[string]any{"action": "block", "client_ip": "203.0.113.77"}},
	}))
	k := keys(o)
	if !k["ip:203.0.113.77"] || !k["cloud:cloudflare:zone/example.test"] || !hasStage(o, model.StageEdgeWAFBlock) {
		t.Errorf("cloudflare: %v %v", k, o.Stages)
	}
	scan, _ := r.Observe(doc("31151", 10, []any{"web", "accesslog", "attack"}, map[string]any{"id": "002", "name": "web"}, map[string]any{"srcip": "203.0.113.77"}))
	if !hasStage(scan, model.StageEdgeScan) {
		t.Errorf("scan stage: %v", scan.Stages)
	}
}

func TestPrivilegedAWSChangeAndTamper(t *testing.T) {
	r := New(nil, "")
	o, _ := r.Observe(doc("101640", 12, []any{"aws"}, manager, map[string]any{
		"qapaq": map[string]any{"vendor": "aws"},
		"aws": map[string]any{"event_name": "AttachUserPolicy", "principal_arn": "arn:aws:iam::061098277310:user/admin@qapaq.pe",
			"request_parameters": `{"bucketName":"qapaq-logs"}`},
	}))
	if !hasStage(o, model.StagePrivilegedChange) || !keys(o)["user:admin@qapaq.pe"] || !keys(o)["cloud:qapaq-logs"] {
		t.Errorf("priv change: %v %v", o.Stages, keys(o))
	}
	o2, _ := r.Observe(doc("101712", 12, []any{"aws"}, manager, map[string]any{"qapaq": map[string]any{"vendor": "aws"}, "aws": map[string]any{"event_name": "StopLogging"}}))
	if !hasStage(o2, model.StageCloudTamper) {
		t.Errorf("tamper: %v", o2.Stages)
	}
}

func TestObserveRejectsDocumentsWithoutRuleOrTime(t *testing.T) {
	r := New(nil, "")
	if _, ok := r.Observe(Doc{"timestamp": "2026-11-04T10:00:00Z"}); ok {
		t.Error("document without rule accepted")
	}
	if _, ok := r.Observe(Doc{"rule": map[string]any{"id": "1"}}); ok {
		t.Error("document without timestamp accepted")
	}
}
