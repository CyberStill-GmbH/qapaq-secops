package engine

import (
	"sort"
	"strings"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
)

// Report is the replay / stats summary.
type Report struct {
	GeneratedAt  time.Time            `json:"generatedAt"`
	Readiness    Readiness            `json:"readiness"`
	Window       map[string]time.Time `json:"window"`
	Observations map[string]any       `json:"observations"`
	Entities     map[string]int       `json:"entities"`
	Candidates   map[string]any       `json:"candidates"`
	Reduction    map[string]any       `json:"reduction"`
	TopEntities  []risk.EntitySummary `json:"topEntities"`
	Feedback     map[string]any       `json:"feedback"`
	CDB          string               `json:"cdbAllowlistProposal"`
}

// BuildReport summarizes the runner state over its window.
func (r *Runner) BuildReport(from, to time.Time, top int, redact bool) Report {
	snap := r.Snapshot()
	stats := r.Eng.Stats()
	cands := r.Eng.Candidates("", 0)
	byKind, byPattern, byPriority, byStatus := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	covered := map[string]bool{}
	members := 0
	for _, c := range cands {
		byKind[c.Kind]++
		byPattern[c.PatternID]++
		byPriority[c.Priority]++
		byStatus[c.Status]++
		members += c.MemberCount
		for _, id := range c.QapaqAlertIDs {
			covered[id] = true
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].Priority == cands[j].Priority {
			return cands[i].RiskScore > cands[j].RiskScore
		}
		return cands[i].Priority < cands[j].Priority
	})
	list := []model.Candidate{}
	for i := 0; i < len(cands) && i < 25; i++ {
		c := cands[i]
		if redact {
			c.Entity.Value = Redact(c.Entity)
			c.RelatedKeys = nil
			c.Summary = ""
		}
		list = append(list, c)
	}
	wItems, wGroups, wRed := r.Eng.GroupStats()
	topEntities := r.Eng.Top(top, "", to)
	if redact {
		for i := range topEntities {
			e := model.Entity{Type: model.EntityType(topEntities[i].Type), Value: topEntities[i].Value}
			topEntities[i].Value = Redact(e)
			topEntities[i].Key = topEntities[i].Type + ":" + topEntities[i].Value
		}
	}
	dedup := snap.Dedup
	if redact {
		for i := range dedup.Largest {
			if e, ok := model.ParseKey(dedup.Largest[i].Pivot); ok {
				dedup.Largest[i].Pivot = string(e.Type) + ":" + Redact(e)
			}
		}
	}
	candReduction := 0.0
	if len(cands) > 0 {
		candReduction = float64(len(covered)) / float64(len(cands))
	}
	props := snap.Feedback.Proposals
	kinds := map[string]int{}
	for _, p := range props {
		kinds[p.Kind]++
	}
	shown := []feedback.Proposal{}
	for i := 0; i < len(props) && i < 20; i++ {
		p := props[i]
		if redact {
			if e, ok := model.ParseKey(p.EntityKey); ok {
				p.EntityKey = string(e.Type) + ":" + Redact(e)
			}
		}
		shown = append(shown, p)
	}
	cdb := snap.Feedback.CDB()
	if redact && cdb != "" {
		cdb = "(redacted in report; full list via GET /v1/feedback/allowlist.cdb)"
	}
	return Report{
		GeneratedAt: r.Now().UTC(),
		Readiness:   r.Readiness(r.Now().UTC()),
		Window:      map[string]time.Time{"from": from, "to": to},
		Observations: map[string]any{
			"total": stats.Observations, "duplicates": stats.Duplicates,
			"suppressed": stats.Suppressed, "bySource": stats.BySource, "byStage": stats.ByStage,
			"unparseable": r.C.Unparseable.Load(), "pages": r.C.Pages.Load(),
		},
		Entities: r.Eng.EntityCounts(),
		Candidates: map[string]any{
			"total": len(cands), "byKind": byKind, "byPattern": byPattern, "byPriority": byPriority,
			"byStatus": byStatus, "memberObservations": members, "qapaqAlertsCovered": len(covered),
			"top": list,
		},
		Reduction: map[string]any{
			"wazuhAlerts": map[string]any{
				"minLevel": r.Eng.GroupMinLevel, "alerts": wItems, "groups": wGroups, "reductionFactor": wRed,
				"note": "Wazuh alerts at or above minLevel grouped by pivot entity (user > host > ip > cloud) and stage window (gap " + r.Eng.P.GroupGap.String() + ", max span " + r.Eng.P.GroupMaxSpan.String() + ")",
			},
			"qapaqAlerts":          dedup,
			"qapaqAlertsTruncated": snap.AlertsTrunc,
			"candidatesVsCoveredQapaqAlerts": map[string]any{
				"candidates": len(cands), "coveredQapaqAlerts": len(covered), "alertsPerCandidate": round(candReduction),
			},
		},
		TopEntities: topEntities,
		Feedback: map[string]any{
			"windowSeconds": snap.Feedback.WindowSeconds,
			"verdicts":      snap.Feedback.Verdicts, "falsePositiveVerdicts": snap.Feedback.FalsePos,
			"truePositiveVerdicts": snap.Feedback.TruePos, "proposalsByKind": kinds,
			"correlatorAlerts":                snap.Feedback.CorrelatorAlerts,
			"correlatorAdjudicated":           snap.Feedback.CorrelatorAdjudicated,
			"correlatorUnreviewed":            snap.Feedback.CorrelatorUnreviewed,
			"correlatorFalsePositiveVerdicts": snap.Feedback.CorrelatorFalsePos,
			"correlatorTruePositiveVerdicts":  snap.Feedback.CorrelatorTruePos,
			"reviewCoverage":                  snap.Feedback.ReviewCoverage,
			"reviewCoverageStatus":            snap.Feedback.ReviewCoverageStatus,
			"alertFeedTruncated":              snap.AlertsTrunc,
			"activeSuppressions":              snap.Feedback.ActiveCount(to), "proposals": shown,
		},
		CDB: cdb,
	}
}

func round(v float64) float64 { return float64(int(v*100+0.5)) / 100 }

// Redact masks an entity value for reports that leave the SOC (keeps type and shape).
func Redact(e model.Entity) string {
	v := e.Value
	switch e.Type {
	case model.EntityUser:
		if at := strings.IndexByte(v, '@'); at > 0 {
			return v[:1] + "***" + v[at:]
		}
		if len(v) > 4 {
			return v[:4] + "***"
		}
		return "***"
	case model.EntityIP:
		if i := strings.LastIndexByte(v, '.'); i > 0 {
			return v[:i] + ".x"
		}
		if i := strings.LastIndexByte(v, ':'); i > 0 {
			return v[:i] + ":x"
		}
	}
	return v
}
