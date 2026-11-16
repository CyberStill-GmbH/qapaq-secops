package risk

import (
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

func TestCandidateMembersRespectEpisodeAndRefreshSignals(t *testing.T) {
	e := newEngine()
	key := "host:episode-test"
	e.Process(obs("first", 0, "r1", 9, "endpoint", nil, []model.Stage{model.StageProtectionOff}, key))
	created := e.Process(obs("second", time.Minute, "r2", 9, "endpoint", nil, []model.Stage{model.StageEndpointMalware}, key))
	var id string
	for _, c := range created {
		if c.PatternID == "endpoint-protection-and-malware" {
			id = c.ID
		}
	}
	if id == "" {
		t.Fatal("expected correlated candidate")
	}
	before, _ := e.Candidate(id)
	e.Process(obs("historical", -24*time.Hour, "old-rule", 9, "old-source", []string{"old-tactic"}, nil, key))
	afterOld, _ := e.Candidate(id)
	if afterOld.MemberCount != before.MemberCount || contains(afterOld.Explanation.EvidenceObservationIDs, "historical") {
		t.Fatal("historical event must not become evidence of the current episode")
	}
	e.Process(obs("new-signal", 2*time.Minute, "r3", 9, "cloud", []string{"exfiltration"}, nil, key))
	current, _ := e.Candidate(id)
	if current.MemberCount != before.MemberCount+1 || !contains(current.Sources, "cloud") || !contains(current.Tactics, "exfiltration") {
		t.Fatalf("new corroboration must be visible to investigation: %+v", current)
	}
	if contains(before.Sources, "cloud") || contains(before.Tactics, "exfiltration") {
		t.Fatal("previous snapshots must not change")
	}
	e.Process(obs("new-signal", 2*time.Minute, "r3", 9, "cloud", []string{"exfiltration"}, nil, key))
	duplicate, _ := e.Candidate(id)
	if duplicate.MemberCount != current.MemberCount {
		t.Fatal("duplicate changed member count")
	}
	e.Process(obs("within-window-late", 30*time.Second, "r4", 9, "endpoint", nil, nil, key))
	late, _ := e.Candidate(id)
	if late.MemberCount != current.MemberCount+1 || !late.LastSeen.Equal(current.LastSeen) {
		t.Fatal("late evidence inside the episode must join without moving the watermark backward")
	}
}
