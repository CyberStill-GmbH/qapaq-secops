package feedback

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

var now = time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

func verdicts(rule, prio, key, verdict string, n int, start time.Time) []model.QapaqAlert {
	out := []model.QapaqAlert{}
	for i := 0; i < n; i++ {
		at := start.Add(time.Duration(i) * time.Hour)
		out = append(out, model.QapaqAlert{ID: fmt.Sprintf("%s-%s-%d-%s", rule, verdict, i, key), RuleID: rule, Priority: prio,
			Verdict: verdict, Status: "closed", EntityKeys: []string{key}, OccurredAt: at, UpdatedAt: at.Add(10 * time.Minute)})
	}
	return out
}

func find(res Result, kind, rule string) *Proposal {
	for i := range res.Proposals {
		if res.Proposals[i].Kind == kind && res.Proposals[i].RuleID == rule {
			return &res.Proposals[i]
		}
	}
	return nil
}

func TestBelowThresholdNoProposal(t *testing.T) {
	res := Evaluate(verdicts("101501", "P3", "ip:192.0.2.200", "false_positive", 2, now.Add(-48*time.Hour)), nil, DefaultPolicy(), now)
	if len(res.Proposals) != 0 || res.FalsePos != 2 {
		t.Fatalf("%+v", res)
	}
}

func TestCorrelatorAdjudicationCountsOnlyItsOwnLabeledAlerts(t *testing.T) {
	alerts := []model.QapaqAlert{
		{ID: "c-fp", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh", Verdict: "false_positive", OccurredAt: now.Add(-time.Hour)},
		{ID: "c-tp", RuleID: model.CorrelatorRulePrefix + "ssh-bruteforce-then-access", Verdict: "true_positive", OccurredAt: now.Add(-time.Hour)},
		{ID: "c-open", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh", OccurredAt: now.Add(-time.Hour)},
		{ID: "c-future", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh", Verdict: "false_positive", OccurredAt: now.Add(time.Hour)},
		{ID: "other-fp", RuleID: "100530", Verdict: "false_positive", OccurredAt: now.Add(-time.Hour)},
		{ID: "old-fp", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh", Verdict: "false_positive", OccurredAt: now.Add(-31 * 24 * time.Hour)},
		{ID: "old-reviewed", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh", Verdict: "false_positive", OccurredAt: now.Add(-31 * 24 * time.Hour), UpdatedAt: now.Add(-time.Hour)},
	}
	res := Evaluate(alerts, nil, DefaultPolicy(), now)
	if res.WindowSeconds != int64((30*24*time.Hour).Seconds()) ||
		res.CorrelatorAlerts != 3 ||
		res.CorrelatorAdjudicated != 2 ||
		res.CorrelatorUnreviewed != 1 ||
		res.CorrelatorFalsePos != 1 ||
		res.CorrelatorTruePos != 1 {
		t.Fatalf("correlator adjudication counts: %+v", res)
	}
}

func TestReviewCoverageCountsAnyHumanTriageWithoutCallingDuplicateTPOrFP(t *testing.T) {
	alerts := []model.QapaqAlert{
		{ID: "tp", RuleID: model.CorrelatorRulePrefix + "chain", Verdict: "true_positive", OccurredAt: now.Add(-time.Hour)},
		{ID: "fp", RuleID: model.CorrelatorRulePrefix + "chain", Verdict: "false_positive", OccurredAt: now.Add(-time.Hour)},
		{ID: "benign", RuleID: model.CorrelatorRulePrefix + "chain", Verdict: "benign", OccurredAt: now.Add(-time.Hour)},
		{ID: "duplicate", RuleID: model.CorrelatorRulePrefix + "chain", Verdict: "duplicate", OccurredAt: now.Add(-time.Hour)},
		{ID: "open", RuleID: model.CorrelatorRulePrefix + "chain", OccurredAt: now.Add(-time.Hour)},
		{ID: "other", RuleID: "100530", Verdict: "true_positive", OccurredAt: now.Add(-time.Hour)},
	}
	res := Evaluate(alerts, nil, DefaultPolicy(), now)
	if res.CorrelatorAlerts != 5 || res.CorrelatorAdjudicated != 4 || res.CorrelatorFalsePos != 2 || res.CorrelatorTruePos != 1 || res.ReviewCoverage == nil || *res.ReviewCoverage != 0.8 || res.ReviewCoverageStatus != ReviewCoverageAvailable {
		t.Fatalf("review coverage: %+v", res)
	}
}

func TestReviewCoverageWithoutCorrelatorCandidatesIsNoData(t *testing.T) {
	res := Evaluate([]model.QapaqAlert{{ID: "other", RuleID: "100530", Verdict: "true_positive", OccurredAt: now.Add(-time.Hour)}}, nil, DefaultPolicy(), now)
	if res.ReviewCoverage != nil || res.ReviewCoverageStatus != ReviewCoverageNoData {
		t.Fatalf("zero denominator must be null/NO_DATA: %+v", res)
	}
}

func TestRepeatedFalsePositivesProposeAllowlist(t *testing.T) {
	start := now.Add(-48 * time.Hour)
	res := Evaluate(verdicts("101501", "P3", "ip:192.0.2.200", "false_positive", 4, start), nil, DefaultPolicy(), now)
	p := find(res, KindAllowlist, "101501")
	if p == nil || p.FalsePos != 4 || p.Suppression != SuppressionProposed || p.Protected {
		t.Fatalf("proposal: %+v", res.Proposals)
	}
	// Threshold time = third FP verdict; auto-suppress disabled => nothing suppressed.
	if !p.ThresholdAt.Equal(start.Add(2*time.Hour + 10*time.Minute)) {
		t.Fatalf("threshold at %v", p.ThresholdAt)
	}
	if res.Suppressed("101501", "ip:192.0.2.200", now) {
		t.Fatal("suppression must be off unless auto-suppress is enabled")
	}
	if got := res.CDB(); got != "192.0.2.200:101501\n" {
		t.Fatalf("cdb = %q", got)
	}
}

func TestTruePositivesBlockProposal(t *testing.T) {
	alerts := verdicts("5712", "P2", "ip:198.51.100.50", "false_positive", 3, now.Add(-72*time.Hour))
	alerts = append(alerts, verdicts("5712", "P2", "ip:198.51.100.50", "true_positive", 2, now.Add(-24*time.Hour))...)
	res := Evaluate(alerts, nil, DefaultPolicy(), now)
	if len(res.Proposals) != 0 || res.TruePos != 2 {
		t.Fatalf("ratio 0.6 must not propose: %+v", res.Proposals)
	}
}

func TestP1RulesAreNeverSuppressed(t *testing.T) {
	pol := DefaultPolicy()
	pol.AutoSuppress = true
	res := Evaluate(verdicts("100502", "P1", "user:breakglass@qapaq.pe", "benign", 5, now.Add(-10*time.Hour)), nil, pol, now)
	p := find(res, KindReview, "100502")
	if p == nil || !p.Protected || p.Suppression != SuppressionNone {
		t.Fatalf("review proposal: %+v", res.Proposals)
	}
	if res.Suppressed("100502", "user:breakglass@qapaq.pe", now) || res.ActiveCount(now) != 0 {
		t.Fatal("a P1 rule was suppressed")
	}
	if res.CDB() != "" {
		t.Fatal("protected rules never reach the allowlist")
	}
	// Protection by configuration as well.
	pol.ProtectedRules = map[string]bool{"101501": true}
	res = Evaluate(verdicts("101501", "P3", "ip:192.0.2.200", "false_positive", 4, now.Add(-10*time.Hour)), nil, pol, now)
	if find(res, KindReview, "101501") == nil {
		t.Fatal("configured protected rule")
	}
}

func TestAutoSuppressionActiveThenExpires(t *testing.T) {
	pol := DefaultPolicy()
	pol.AutoSuppress = true
	pol.SuppressionTTL = 24 * time.Hour
	start := now.Add(-10 * time.Hour)
	res := Evaluate(verdicts("101501", "P3", "ip:192.0.2.200", "false_positive", 3, start), nil, pol, now)
	p := find(res, KindAllowlist, "101501")
	if p == nil || p.Suppression != SuppressionActive {
		t.Fatalf("active: %+v", res.Proposals)
	}
	if res.Suppressed("101501", "ip:192.0.2.200", p.ThresholdAt.Add(-time.Minute)) {
		t.Fatal("not suppressed before the threshold")
	}
	if !res.Suppressed("101501", "ip:192.0.2.200", now) || res.ActiveCount(now) != 1 {
		t.Fatal("suppressed while active")
	}
	if res.Suppressed("101501", "ip:192.0.2.200", p.ExpiresAt) {
		t.Fatal("expired suppression still applies")
	}
	later := Evaluate(verdicts("101501", "P3", "ip:192.0.2.200", "false_positive", 3, start), nil, pol, now.Add(48*time.Hour))
	if find(later, KindAllowlist, "101501").Suppression != SuppressionExpired {
		t.Fatal("expected expired")
	}
	// Determinism: same inputs, same id (audit idempotency).
	if find(later, KindAllowlist, "101501").ID != p.ID {
		t.Fatal("proposal id must be stable")
	}
}

func TestRuleLevelDemotionAndCanonicalKeys(t *testing.T) {
	alerts := []model.QapaqAlert{}
	for _, ip := range []string{"192.0.2.1", "192.0.2.2", "192.0.2.3"} {
		alerts = append(alerts, verdicts("31151", "P3", "ip:"+ip, "false_positive", 3, now.Add(-20*time.Hour))...)
	}
	// Two raw keys that resolve to the same canonical entity add up.
	alerts = append(alerts, verdicts("60106", "P4", "ip:10.0.0.5", "false_positive", 2, now.Add(-5*time.Hour))...)
	alerts = append(alerts, verdicts("60106", "P4", "host:pc-1", "false_positive", 1, now.Add(-2*time.Hour))...)
	canonical := func(k string) string {
		if k == "ip:10.0.0.5" {
			return "host:pc-1"
		}
		return k
	}
	res := Evaluate(alerts, canonical, DefaultPolicy(), now)
	d := find(res, KindDemote, "31151")
	if d == nil || d.Entities != 3 || d.FalsePos != 9 || d.EntityKey != "*" {
		t.Fatalf("demotion: %+v", res.Proposals)
	}
	if find(res, KindAllowlist, "60106") == nil {
		t.Fatal("canonical aggregation")
	}
	if !strings.Contains(res.CDB(), "pc-1:60106") {
		t.Fatalf("cdb: %q", res.CDB())
	}
}

func TestOldVerdictsOutsideWindowIgnored(t *testing.T) {
	res := Evaluate(verdicts("1", "P3", "ip:192.0.2.9", "false_positive", 5, now.Add(-60*24*time.Hour)), nil, DefaultPolicy(), now)
	if len(res.Proposals) != 0 || res.Verdicts != 0 {
		t.Fatalf("%+v", res)
	}
}

func TestCDBQuotesKeysWithColons(t *testing.T) {
	res := Result{Proposals: []Proposal{{Kind: KindAllowlist, RuleID: "9", EntityKey: "ip:2001:db8::1"}, {Kind: KindAllowlist, RuleID: "8", EntityKey: "ip:2001:db8::1"}}}
	if got := res.CDB(); got != "\"2001:db8::1\":8,9\n" {
		t.Fatalf("cdb = %q", got)
	}
}
