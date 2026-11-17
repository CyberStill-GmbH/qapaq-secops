package risk

import (
	"strings"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

func TestUnorderedPatternInvestigationIncludesEarlierStageAndItsAlert(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		name := "protection_then_malware"
		firstStage, lastStage := model.StageProtectionOff, model.StageEndpointMalware
		if reverse {
			name = "malware_then_protection"
			firstStage, lastStage = lastStage, firstStage
		}
		t.Run(name, func(t *testing.T) {
			e := newEngine()
			entity := "host:investigation-endpoint"
			e.Process(obs("early-evidence", 0, "endpoint-1", 9, "bitdefender", nil, []model.Stage{firstStage}, entity))
			created := e.Process(obs("late-evidence", 2*time.Hour, "endpoint-2", 9, "bitdefender", nil, []model.Stage{lastStage}, entity))
			var candidate *model.Candidate
			for _, c := range created {
				if c.PatternID == "endpoint-protection-and-malware" {
					candidate = c
				}
			}
			if candidate == nil {
				t.Fatal("unordered detection must match either event order")
			}
			if !candidate.FirstSeen.Equal(t0) || !candidate.LastSeen.Equal(t0.Add(2*time.Hour)) || candidate.Priority != "P1" {
				t.Fatalf("investigation must span both stages without changing priority: %+v", candidate)
			}
			for _, stage := range candidate.Stages {
				if stage.At.Before(candidate.FirstSeen) || stage.At.After(candidate.LastSeen) {
					t.Fatalf("selected evidence excluded from investigation window: %+v", stage)
				}
			}
			if !strings.Contains(candidate.Explanation.Narrative, "sin exigir orden temporal") || strings.Contains(candidate.Explanation.Narrative, "etapas en orden") || strings.Contains(candidate.Summary, " → ") {
				t.Fatalf("unordered correlation must not claim sequence: %s", candidate.Explanation.Narrative)
			}
			if !strings.HasPrefix(candidate.Explanation.Narrative, "Correlación temporal; no demuestra causalidad ni compromiso.") {
				t.Fatalf("bounded AI context must retain the causal limitation: %s", candidate.Explanation.Narrative)
			}
			e.AttachAlerts([]model.QapaqAlert{
				{ID: "alert-early", RuleID: "endpoint-1", EntityKeys: []string{entity}, OccurredAt: t0},
				{ID: "alert-late", RuleID: "endpoint-2", EntityKeys: []string{entity}, OccurredAt: t0.Add(2 * time.Hour)},
			})
			got, ok := e.Candidate(candidate.ID)
			if !ok || !contains(got.QapaqAlertIDs, "alert-early") || !contains(got.QapaqAlertIDs, "alert-late") {
				t.Fatalf("both evidence alerts must be linked for downstream investigation: %+v", got.QapaqAlertIDs)
			}
		})
	}
}

func TestOrderedPatternWithEqualTimestampsDoesNotClaimStrictSequence(t *testing.T) {
	e := newEngine()
	entity := "user:reviewer@example.test"
	e.Process(obs("failure", 0, "auth-failure", 9, "m365", nil, []model.Stage{model.StageAuthFailure}, entity))
	e.Process(obs("success", 0, "auth-success", 9, "m365", nil, []model.Stage{model.StageAuthSuccess}, entity))
	created := e.Process(obs("change", 0, "privileged-change", 9, "m365", nil, []model.Stage{model.StagePrivilegedChange}, entity))
	for _, c := range created {
		if c.PatternID != "credential-to-privilege" {
			continue
		}
		if c.Priority != "P1" || len(c.Stages) != 3 || !c.FirstSeen.Equal(t0) || !c.LastSeen.Equal(t0) {
			t.Fatalf("existing equal-timestamp detection and priority must be retained: %+v", c)
		}
		if !strings.Contains(c.Explanation.Narrative, "orden temporal no decreciente") || !strings.Contains(c.Explanation.Narrative, "no demuestra causalidad ni compromiso") {
			t.Fatalf("explanation must accurately describe non-strict temporal matching: %s", c.Explanation.Narrative)
		}
		return
	}
	t.Fatal("existing ordered detection with tied timestamps must remain visible")
}
