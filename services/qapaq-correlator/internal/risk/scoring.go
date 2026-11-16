// Package risk implements per-entity risk scoring with exponential time decay, multi-stage
// pattern detection, alert grouping (dedup) and candidate generation. It is pure: time comes
// from the observations, never from a wall clock, so a replay is deterministic.
package risk

import (
	"math"
	"sort"
	"strings"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
)

// Policy holds every tunable of the scoring model.
type Policy struct {
	HalfLife         time.Duration // exponential decay half-life of the risk score
	Window           time.Duration // window for source diversity and tactic progression
	RepeatWindow     time.Duration // same rule+entity within this window is dampened
	RepeatDamping    float64       // multiplier applied per prior repeat (0.5 => 1, .5, .25 ...)
	RulePointCap     float64       // max points one rule may add to one entity per Window
	DiversityStep    float64       // +x per extra distinct source
	DiversityCap     float64       // multiplier cap
	TacticStepBonus  float64       // per extra distinct tactic in Window
	ProgressionBonus float64       // per forward kill-chain transition in Window
	ProgressionCap   float64
	Threshold        float64 // effective score that makes a threshold candidate
	GroupGap         time.Duration
	GroupMaxSpan     time.Duration
	ContributorsKept int
	TimelineBucket   time.Duration
	TimelineKept     int
	PruneAfter       time.Duration
	MinLevel         int // observations below this level do not contribute
}

// DefaultPolicy is the documented default (see README of the service).
func DefaultPolicy() Policy {
	return Policy{
		HalfLife:         12 * time.Hour,
		Window:           24 * time.Hour,
		RepeatWindow:     time.Hour,
		RepeatDamping:    0.5,
		RulePointCap:     40,
		DiversityStep:    0.25,
		DiversityCap:     2.0,
		TacticStepBonus:  8,
		ProgressionBonus: 12,
		ProgressionCap:   60,
		Threshold:        80,
		GroupGap:         4 * time.Hour,
		GroupMaxSpan:     24 * time.Hour,
		ContributorsKept: 50,
		TimelineBucket:   time.Hour,
		TimelineKept:     24 * 7,
		PruneAfter:       7 * 24 * time.Hour,
		MinLevel:         3,
	}
}

// LevelPoints is the base contribution of a Wazuh rule level (0–15).
func LevelPoints(level int) float64 {
	switch {
	case level >= 13:
		return 35
	case level >= 11:
		return 20
	case level >= 9:
		return 10
	case level >= 7:
		return 5
	case level >= 5:
		return 2
	case level >= 3:
		return 0.5
	}
	return 0
}

var tacticWeights = map[string]float64{
	"reconnaissance": 0.6, "resource-development": 0.6, "initial-access": 1.2, "execution": 1.3,
	"persistence": 1.4, "privilege-escalation": 1.6, "defense-evasion": 1.4,
	"credential-access": 1.3, "discovery": 0.8, "lateral-movement": 1.6, "collection": 1.3,
	"command-and-control": 1.5, "exfiltration": 1.8, "impact": 1.8,
}

// TacticWeight is the max weight over the alert's tactics (1.0 without MITRE mapping).
func TacticWeight(tactics []string) float64 {
	w := 0.0
	for _, t := range tactics {
		if v, ok := tacticWeights[t]; ok && v > w {
			w = v
		}
	}
	if w == 0 {
		return 1
	}
	return w
}

// CriticalityMultiplier maps an asset criticality label to a multiplier.
func CriticalityMultiplier(label string) float64 {
	switch label {
	case "critical":
		return 2.0
	case "high":
		return 1.5
	case "low":
		return 0.7
	case "trusted":
		// Known administrative activity: demoted, not ignored (patterns still apply).
		return 0.25
	}
	return 1.0
}

// Decay applies exponential decay from `from` to `to`.
func Decay(score float64, from, to time.Time, halfLife time.Duration) float64 {
	if score == 0 || !to.After(from) || halfLife <= 0 {
		return score
	}
	return score * math.Exp2(-float64(to.Sub(from))/float64(halfLife))
}

// Contribution is one observation's effect on one entity.
type Contribution struct {
	At          time.Time `json:"at"`
	ObsID       string    `json:"observationId"`
	RuleID      string    `json:"ruleId"`
	Level       int       `json:"level"`
	Description string    `json:"description"`
	Source      string    `json:"source"`
	Tactics     []string  `json:"tactics"`
	Points      float64   `json:"points"`
	Suppressed  bool      `json:"suppressed,omitempty"`
}

type ruleAgg struct {
	windowStart time.Time
	points      float64
	lastAt      time.Time
	repeats     int
	count       int
}

// TimelinePoint is the highest effective score reached inside a bucket.
type TimelinePoint struct {
	At    time.Time `json:"at"`
	Score float64   `json:"score"`
}

// EntityState is the risk state of one canonical entity.
type EntityState struct {
	Entity       model.Entity
	Criticality  string
	score        float64 // decayed sum at lastUpdate
	lastUpdate   time.Time
	FirstSeen    time.Time
	LastSeen     time.Time
	Peak         float64
	PeakAt       time.Time
	Observations int
	Suppressed   int
	Contributors []Contribution // most recent first, capped
	rules        map[string]*ruleAgg
	sources      map[string]time.Time
	tactics      map[string]time.Time // first seen inside the current window
	Timeline     []TimelinePoint
	CandidateIDs []string
}

func newState(e model.Entity, crit string) *EntityState {
	return &EntityState{
		Entity: e, Criticality: crit,
		rules: map[string]*ruleAgg{}, sources: map[string]time.Time{}, tactics: map[string]time.Time{},
	}
}

// Base returns the decayed contribution sum at t.
func (s *EntityState) Base(t time.Time, p Policy) float64 {
	return Decay(s.score, s.lastUpdate, t, p.HalfLife)
}

// Sources returns the distinct sources seen within the window before t.
func (s *EntityState) SourcesAt(t time.Time, p Policy) []string {
	out := []string{}
	for src, at := range s.sources {
		if t.Sub(at) <= p.Window {
			out = append(out, src)
		}
	}
	sort.Strings(out)
	return out
}

// TacticsAt returns tactics first seen within the window, in first-seen order.
func (s *EntityState) TacticsAt(t time.Time, p Policy) []string {
	type kv struct {
		t  string
		at time.Time
	}
	list := []kv{}
	for tac, at := range s.tactics {
		if t.Sub(at) <= p.Window {
			list = append(list, kv{tac, at})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].at.Equal(list[j].at) {
			return resolve.TacticIndex(list[i].t) < resolve.TacticIndex(list[j].t)
		}
		return list[i].at.Before(list[j].at)
	})
	out := make([]string, len(list))
	for i, v := range list {
		out[i] = v.t
	}
	return out
}

// Breakdown explains an effective score.
type Breakdown struct {
	Base        float64 `json:"base"`
	Diversity   float64 `json:"diversityMultiplier"`
	Progression float64 `json:"progressionBonus"`
	Effective   float64 `json:"effective"`
}

// Effective computes base × diversity + progression at t.
func (s *EntityState) Effective(t time.Time, p Policy) Breakdown {
	base := s.Base(t, p)
	srcs := len(s.SourcesAt(t, p))
	div := 1.0
	if srcs > 1 {
		div = math.Min(p.DiversityCap, 1+p.DiversityStep*float64(srcs-1))
	}
	tac := s.TacticsAt(t, p)
	prog := 0.0
	if len(tac) > 1 {
		prog = p.TacticStepBonus * float64(len(tac)-1)
		for i := 1; i < len(tac); i++ {
			if resolve.TacticIndex(tac[i]) > resolve.TacticIndex(tac[i-1]) {
				prog += p.ProgressionBonus
			}
		}
		prog = math.Min(prog, p.ProgressionCap)
	}
	// Progression only matters while there is live risk: it decays with the base.
	if base < 1 {
		prog *= base
	}
	// Demoted (low/trusted) entities get proportionally less progression bonus too; their
	// multi-stage patterns are still evaluated independently of this score.
	if m := CriticalityMultiplier(s.Criticality); m < 1 {
		prog *= m
	}
	eff := base*div + prog
	return Breakdown{Base: round2(base), Diversity: round2(div), Progression: round2(prog), Effective: round2(eff)}
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// apply adds an observation's contribution. It returns the points actually added.
func (s *EntityState) apply(o model.Observation, p Policy, suppressed bool) float64 {
	s.Observations++
	if s.FirstSeen.IsZero() || o.Time.Before(s.FirstSeen) {
		s.FirstSeen = o.Time
	}
	if o.Time.After(s.LastSeen) {
		s.LastSeen = o.Time
	}
	at := o.Time
	if at.Before(s.lastUpdate) {
		// Late arrival: score it at the current reference time (no negative decay).
		at = s.lastUpdate
	}
	s.score = Decay(s.score, s.lastUpdate, at, p.HalfLife)
	s.lastUpdate = at

	points := 0.0
	if !suppressed && o.Level >= p.MinLevel {
		agg := s.rules[o.RuleID]
		if agg == nil {
			agg = &ruleAgg{windowStart: o.Time}
			s.rules[o.RuleID] = agg
		}
		if o.Time.Sub(agg.windowStart) > p.Window {
			agg.windowStart, agg.points = o.Time, 0
		}
		if !agg.lastAt.IsZero() && o.Time.Sub(agg.lastAt) <= p.RepeatWindow {
			agg.repeats++
		} else {
			agg.repeats = 0
		}
		agg.lastAt = o.Time
		agg.count++
		raw := LevelPoints(o.Level) * TacticWeight(o.Tactics) * CriticalityMultiplier(s.Criticality)
		raw *= math.Pow(p.RepeatDamping, float64(agg.repeats))
		if agg.points+raw > p.RulePointCap {
			raw = math.Max(0, p.RulePointCap-agg.points)
		}
		agg.points += raw
		points = raw
		s.score += points
		if points > 0 {
			s.sources[o.Source] = o.Time
			for _, t := range o.Tactics {
				if first, ok := s.tactics[t]; !ok || o.Time.Sub(first) > p.Window {
					s.tactics[t] = o.Time
				}
			}
		}
	}
	if suppressed {
		s.Suppressed++
	}
	if points > 0 || suppressed {
		c := Contribution{
			At: o.Time, ObsID: o.ID, RuleID: o.RuleID, Level: o.Level, Description: o.Description,
			Source: o.Source, Tactics: o.Tactics, Points: round2(points), Suppressed: suppressed,
		}
		s.Contributors = append([]Contribution{c}, s.Contributors...)
		if len(s.Contributors) > p.ContributorsKept {
			s.Contributors = s.Contributors[:p.ContributorsKept]
		}
	}
	eff := s.Effective(at, p).Effective
	if eff > s.Peak {
		s.Peak, s.PeakAt = eff, at
	}
	s.recordTimeline(at, eff, p)
	return points
}

func (s *EntityState) recordTimeline(at time.Time, score float64, p Policy) {
	bucket := at.Truncate(p.TimelineBucket)
	if n := len(s.Timeline); n > 0 && !s.Timeline[n-1].At.Before(bucket) {
		if score > s.Timeline[n-1].Score {
			s.Timeline[n-1].Score = score
		}
		return
	}
	s.Timeline = append(s.Timeline, TimelinePoint{At: bucket, Score: score})
	if len(s.Timeline) > p.TimelineKept {
		s.Timeline = s.Timeline[len(s.Timeline)-p.TimelineKept:]
	}
}

// merge folds another state (an alias that just resolved to this entity) into s.
func (s *EntityState) merge(o *EntityState, p Policy) {
	ref := s.lastUpdate
	if o.lastUpdate.After(ref) {
		ref = o.lastUpdate
	}
	s.score = Decay(s.score, s.lastUpdate, ref, p.HalfLife) + Decay(o.score, o.lastUpdate, ref, p.HalfLife)
	s.lastUpdate = ref
	s.Observations += o.Observations
	s.Suppressed += o.Suppressed
	if s.FirstSeen.IsZero() || (!o.FirstSeen.IsZero() && o.FirstSeen.Before(s.FirstSeen)) {
		s.FirstSeen = o.FirstSeen
	}
	if o.LastSeen.After(s.LastSeen) {
		s.LastSeen = o.LastSeen
	}
	if o.Peak > s.Peak {
		s.Peak, s.PeakAt = o.Peak, o.PeakAt
	}
	for k, v := range o.sources {
		if v.After(s.sources[k]) {
			s.sources[k] = v
		}
	}
	for k, v := range o.tactics {
		if cur, ok := s.tactics[k]; !ok || v.Before(cur) {
			s.tactics[k] = v
		}
	}
	for k, v := range o.rules {
		if _, ok := s.rules[k]; !ok {
			s.rules[k] = v
		}
	}
	s.Contributors = append(s.Contributors, o.Contributors...)
	sort.SliceStable(s.Contributors, func(i, j int) bool { return s.Contributors[i].At.After(s.Contributors[j].At) })
	if len(s.Contributors) > p.ContributorsKept {
		s.Contributors = s.Contributors[:p.ContributorsKept]
	}
	s.CandidateIDs = append(s.CandidateIDs, o.CandidateIDs...)
}

// CriticalityLookup resolves an entity's criticality label from a CDB-style map: first the
// full key ("type:value"), then the bare value, then (IPs only) the longest prefix key ending
// in '.' or ':' (Wazuh CDB prefix convention, e.g. "38.250.148."). adminIPs entries (same
// matching) are "trusted" unless the map says otherwise.
func CriticalityLookup(labels map[string]string, adminIPs map[string]string) func(model.Entity) string {
	prefixOf := func(m map[string]string, ip string) (string, bool) {
		best, label := "", ""
		for k, v := range m {
			key := strings.TrimPrefix(k, "ip:")
			if (strings.HasSuffix(key, ".") || strings.HasSuffix(key, ":")) && strings.HasPrefix(ip, key) && len(key) > len(best) {
				best, label = key, v
			}
		}
		return label, best != ""
	}
	return func(e model.Entity) string {
		key := strings.ToLower(e.Key())
		value := strings.ToLower(e.Value)
		if v, ok := labels[key]; ok {
			return v
		}
		if v, ok := labels[value]; ok {
			return v
		}
		if e.Type != model.EntityIP {
			return ""
		}
		if v, ok := prefixOf(labels, value); ok {
			return v
		}
		if _, ok := adminIPs[value]; ok {
			return "trusted"
		}
		if _, ok := adminIPs[key]; ok {
			return "trusted"
		}
		if _, ok := prefixOf(adminIPs, value); ok {
			return "trusted"
		}
		return ""
	}
}
