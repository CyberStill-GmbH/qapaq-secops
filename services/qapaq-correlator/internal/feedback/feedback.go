// Package feedback learns from analyst verdicts already recorded in QAPAQ (triage
// false_positive/benign vs true_positive). When a rule+entity pair is repeatedly marked as a
// false positive it proposes a CDB allowlist entry (PR-ready file for detections/lists/) and,
// when enabled, a temporary expiring suppression inside the correlator. Rules that ever
// produced a P1 alert are never suppressed: they only get a "review" proposal.
//
// Everything is a pure function of the verdict history, the policy and `now`: the threshold
// time is the moment of the N-th false positive, so a restart recomputes identical
// suppressions with identical expiries (and identical audit resource ids).
package feedback

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// Policy tunes the loop.
type Policy struct {
	MinFalsePositives int           // FP verdicts needed on one rule+entity pair
	MinRatio          float64       // FP / (FP + TP)
	Window            time.Duration // verdict look-back
	SuppressionTTL    time.Duration
	AutoSuppress      bool
	DemoteMinEntities int // rule-level demotion when FP pairs span this many entities
	ProtectedRules    map[string]bool
}

// DefaultPolicy: 3 FP, ≥ 80 % FP, 30 days, 72 h suppressions (off by default).
func DefaultPolicy() Policy {
	return Policy{MinFalsePositives: 3, MinRatio: 0.8, Window: 30 * 24 * time.Hour, SuppressionTTL: 72 * time.Hour, DemoteMinEntities: 3, ProtectedRules: map[string]bool{}}
}

// Proposal kinds.
const (
	KindAllowlist = "allowlist" // CDB allowlist entry for rule+entity
	KindDemote    = "demote"    // rule-level tuning (level/threshold) across entities
	KindReview    = "review"    // protected (P1) rule: human review only, never suppressed
)

// Suppression states.
const (
	SuppressionNone     = "none"
	SuppressionProposed = "proposed" // auto-suppress disabled: only proposed
	SuppressionActive   = "active"
	SuppressionExpired  = "expired"
)

// Review coverage status describes whether the complete feedback window can be measured.
const (
	ReviewCoverageAvailable  = "AVAILABLE"
	ReviewCoverageNoData     = "NO_DATA"
	ReviewCoverageIncomplete = "INCOMPLETE"
)

// Proposal is one learned suggestion with its evidence.
type Proposal struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	RuleID      string    `json:"ruleId"`
	EntityKey   string    `json:"entityKey"`
	FalsePos    int       `json:"falsePositives"`
	TruePos     int       `json:"truePositives"`
	Ratio       float64   `json:"ratio"`
	Entities    int       `json:"entities,omitempty"`
	ThresholdAt time.Time `json:"thresholdAt"`
	ExpiresAt   time.Time `json:"expiresAt,omitempty"`
	Suppression string    `json:"suppression"`
	Protected   bool      `json:"protected"`
	Reason      string    `json:"reason"`
	EvidenceIDs []string  `json:"evidenceAlertIds"`
	HighestPrio string    `json:"highestPriority"`
}

// Result is the evaluated feedback state.
type Result struct {
	EvaluatedAt           time.Time  `json:"evaluatedAt"`
	WindowSeconds         int64      `json:"windowSeconds"`
	Verdicts              int        `json:"verdicts"`
	FalsePos              int        `json:"falsePositiveVerdicts"`
	TruePos               int        `json:"truePositiveVerdicts"`
	CorrelatorAlerts      int        `json:"correlatorAlerts"`
	CorrelatorAdjudicated int        `json:"correlatorAdjudicated"`
	CorrelatorUnreviewed  int        `json:"correlatorUnreviewed"`
	CorrelatorFalsePos    int        `json:"correlatorFalsePositiveVerdicts"`
	CorrelatorTruePos     int        `json:"correlatorTruePositiveVerdicts"`
	ReviewCoverage        *float64   `json:"reviewCoverage"`
	ReviewCoverageStatus  string     `json:"reviewCoverageStatus"`
	Proposals             []Proposal `json:"proposals"`
	active                map[string]Proposal
}

type pair struct {
	rule, entity string
	fpTimes      []time.Time
	fpIDs        []string
	tp           int
}

func pairKey(rule, entity string) string { return rule + "\x00" + entity }

func suppressionID(kind, rule, entity string, at time.Time) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%d", kind, rule, entity, at.Unix())))
	return "rsup_" + hex.EncodeToString(sum[:10])
}

func priorityRank(p string) int {
	switch p {
	case "P1":
		return 1
	case "P2":
		return 2
	case "P3":
		return 3
	case "P4":
		return 4
	}
	return 9
}

// Evaluate computes proposals and suppressions from the alert feed.
func Evaluate(alerts []model.QapaqAlert, canonical func(string) string, p Policy, now time.Time) Result {
	if canonical == nil {
		canonical = func(k string) string { return k }
	}
	res := Result{EvaluatedAt: now, WindowSeconds: int64(p.Window.Seconds()), active: map[string]Proposal{}}
	withinWindow := func(at time.Time) bool {
		age := now.Sub(at)
		return age >= 0 && age <= p.Window
	}
	pairs := map[string]*pair{}
	highest := map[string]string{} // rule -> highest priority ever seen
	sorted := append([]model.QapaqAlert(nil), alerts...)
	sort.SliceStable(sorted, func(i, j int) bool { return verdictTime(sorted[i]).Before(verdictTime(sorted[j])) })
	for _, a := range sorted {
		if a.RuleID == "" {
			continue
		}
		// The alert cohort uses occurrence time; verdict time is tracked separately for
		// feedback-driven suppression below.
		if strings.HasPrefix(a.RuleID, model.CorrelatorRulePrefix) && withinWindow(a.OccurredAt) {
			res.CorrelatorAlerts++
			if a.IsFalsePositive() {
				res.CorrelatorAdjudicated++
				res.CorrelatorFalsePos++
			} else if a.IsTruePositive() {
				res.CorrelatorAdjudicated++
				res.CorrelatorTruePos++
			} else if a.Verdict == "duplicate" {
				// Duplicate is a human triage decision. It counts as reviewed coverage,
				// but remains outside TP/FP quality counts and suppression proposals.
				res.CorrelatorAdjudicated++
			} else {
				res.CorrelatorUnreviewed++
			}
		}
		if cur, ok := highest[a.RuleID]; !ok || priorityRank(a.Priority) < priorityRank(cur) {
			highest[a.RuleID] = a.Priority
		}
		if a.Verdict == "" || !withinWindow(verdictTime(a)) {
			continue
		}
		fp, tp := a.IsFalsePositive(), a.IsTruePositive()
		if !fp && !tp {
			continue
		}
		res.Verdicts++
		if fp {
			res.FalsePos++
		} else {
			res.TruePos++
		}
		keys := a.EntityKeys
		if len(keys) == 0 {
			keys = []string{"*"}
		}
		seen := map[string]bool{}
		for _, raw := range keys {
			k := raw
			if k != "*" {
				k = canonical(raw)
			}
			if seen[k] {
				continue
			}
			seen[k] = true
			pk := pairKey(a.RuleID, k)
			pr := pairs[pk]
			if pr == nil {
				pr = &pair{rule: a.RuleID, entity: k}
				pairs[pk] = pr
			}
			if fp {
				pr.fpTimes = append(pr.fpTimes, verdictTime(a))
				pr.fpIDs = append(pr.fpIDs, a.ID)
			} else {
				pr.tp++
			}
		}
	}

	if res.CorrelatorAlerts == 0 {
		res.ReviewCoverageStatus = ReviewCoverageNoData
	} else {
		coverage := float64(res.CorrelatorAdjudicated) / float64(res.CorrelatorAlerts)
		res.ReviewCoverage = &coverage
		res.ReviewCoverageStatus = ReviewCoverageAvailable
	}

	byRule := map[string][]*pair{}
	for _, pr := range pairs {
		fp := len(pr.fpTimes)
		if fp < p.MinFalsePositives {
			continue
		}
		ratio := float64(fp) / float64(fp+pr.tp)
		if ratio < p.MinRatio {
			continue
		}
		byRule[pr.rule] = append(byRule[pr.rule], pr)
		thresholdAt := pr.fpTimes[p.MinFalsePositives-1]
		protected := highest[pr.rule] == "P1" || p.ProtectedRules[pr.rule]
		prop := Proposal{
			RuleID: pr.rule, EntityKey: pr.entity, FalsePos: fp, TruePos: pr.tp,
			Ratio: float64(int(ratio*1000)) / 1000, ThresholdAt: thresholdAt,
			Protected: protected, HighestPrio: highest[pr.rule], EvidenceIDs: lastN(pr.fpIDs, 10),
		}
		if protected {
			prop.Kind, prop.Suppression = KindReview, SuppressionNone
			prop.Reason = "La regla generó alertas P1: nunca se suprime automáticamente; requiere revisión humana."
		} else {
			prop.Kind = KindAllowlist
			prop.ExpiresAt = thresholdAt.Add(p.SuppressionTTL)
			prop.Reason = fmt.Sprintf("%d veredictos falso positivo/benigno y %d verdaderos positivos para esta regla y entidad.", fp, pr.tp)
			switch {
			case !p.AutoSuppress:
				prop.Suppression = SuppressionProposed
			case now.Before(prop.ExpiresAt):
				prop.Suppression = SuppressionActive
			default:
				prop.Suppression = SuppressionExpired
			}
		}
		prop.ID = suppressionID(prop.Kind, prop.RuleID, prop.EntityKey, thresholdAt)
		res.Proposals = append(res.Proposals, prop)
		if prop.Kind == KindAllowlist && p.AutoSuppress {
			res.active[pairKey(prop.RuleID, prop.EntityKey)] = prop
		}
	}
	for rule, list := range byRule {
		if len(list) < p.DemoteMinEntities {
			continue
		}
		fp, tp := 0, 0
		var last time.Time
		ids := []string{}
		for _, pr := range list {
			fp += len(pr.fpTimes)
			tp += pr.tp
			if t := pr.fpTimes[len(pr.fpTimes)-1]; t.After(last) {
				last = t
			}
			ids = append(ids, lastN(pr.fpIDs, 3)...)
		}
		protected := highest[rule] == "P1" || p.ProtectedRules[rule]
		kind := KindDemote
		reason := fmt.Sprintf("Falsos positivos repetidos en %d entidades distintas: proponer ajuste de nivel o condición de la regla.", len(list))
		if protected {
			kind = KindReview
			reason = "Regla P1 con falsos positivos en varias entidades: revisión humana, sin degradar automáticamente."
		}
		res.Proposals = append(res.Proposals, Proposal{
			ID: suppressionID(kind, rule, "*", last), Kind: kind, RuleID: rule, EntityKey: "*",
			FalsePos: fp, TruePos: tp, Ratio: float64(int(float64(fp)/float64(fp+tp)*1000)) / 1000,
			Entities: len(list), ThresholdAt: last, Suppression: SuppressionNone, Protected: protected,
			Reason: reason, EvidenceIDs: lastN(ids, 10), HighestPrio: highest[rule],
		})
	}
	sort.SliceStable(res.Proposals, func(i, j int) bool {
		if res.Proposals[i].FalsePos == res.Proposals[j].FalsePos {
			return res.Proposals[i].ID < res.Proposals[j].ID
		}
		return res.Proposals[i].FalsePos > res.Proposals[j].FalsePos
	})
	return res
}

func verdictTime(a model.QapaqAlert) time.Time {
	if !a.UpdatedAt.IsZero() {
		return a.UpdatedAt
	}
	return a.OccurredAt
}

func lastN(list []string, n int) []string {
	if len(list) <= n {
		return append([]string(nil), list...)
	}
	return append([]string(nil), list[len(list)-n:]...)
}

// Suppressed implements risk.Suppressor: active allowlist pairs between threshold and expiry.
func (r Result) Suppressed(ruleID, entityKey string, at time.Time) bool {
	prop, ok := r.active[pairKey(ruleID, entityKey)]
	if !ok {
		return false
	}
	return !at.Before(prop.ThresholdAt) && at.Before(prop.ExpiresAt)
}

// ActiveCount counts suppressions active at t.
func (r Result) ActiveCount(at time.Time) int {
	n := 0
	for _, p := range r.active {
		if !at.Before(p.ThresholdAt) && at.Before(p.ExpiresAt) {
			n++
		}
	}
	return n
}

// CDBListName is the proposed list file under detections/lists/.
const CDBListName = "qapaq-correlator-fp-allowlist"

// CDB renders the allowlist proposals as a Wazuh CDB list (key:value). The key is the entity
// value (quoted when it contains ':'), the value the rule ids it is allowlisted for.
func (r Result) CDB() string {
	byEntity := map[string][]string{}
	for _, p := range r.Proposals {
		if p.Kind != KindAllowlist || p.Protected {
			continue
		}
		e, ok := model.ParseKey(p.EntityKey)
		if !ok {
			continue
		}
		byEntity[e.Value] = append(byEntity[e.Value], p.RuleID)
	}
	keys := make([]string, 0, len(byEntity))
	for k := range byEntity {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		rules := byEntity[k]
		sort.Strings(rules)
		key := k
		if strings.ContainsAny(key, ": ") {
			key = `"` + strings.ReplaceAll(key, `"`, "") + `"`
		}
		fmt.Fprintf(&b, "%s:%s\n", key, strings.Join(dedupe(rules), ","))
	}
	return b.String()
}

func dedupe(list []string) []string {
	out := []string{}
	for _, v := range list {
		if len(out) == 0 || out[len(out)-1] != v {
			out = append(out, v)
		}
	}
	return out
}
