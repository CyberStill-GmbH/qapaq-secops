package risk

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
)

// CorrelatorRulePrefix prefixes the rule id of every alert the correlator creates in QAPAQ.
const CorrelatorRulePrefix = model.CorrelatorRulePrefix

// Suppressor answers whether a rule+entity pair is under a temporary suppression at t.
type Suppressor interface {
	Suppressed(ruleID, entityKey string, at time.Time) bool
}

type noSuppression struct{}

func (noSuppression) Suppressed(string, string, time.Time) bool { return false }

type episode struct {
	start time.Time
	cand  *model.Candidate
}

type patternMark struct {
	at       time.Time
	complete bool
}

// Engine is the stateful correlator core. All methods are safe for concurrent use.
type Engine struct {
	mu            sync.RWMutex
	P             Policy
	Patterns      []Pattern
	Resolver      *resolve.Resolver
	Criticality   func(model.Entity) string
	supp          Suppressor
	GroupMinLevel int

	states      map[string]*EntityState
	related     map[string]map[string]time.Time
	history     map[string]stageHistory
	episodes    map[string]*episode
	patternMark map[string]patternMark
	open        map[string][]*model.Candidate // entity key -> candidates still accepting members
	candidates  []*model.Candidate
	byID        map[string]*model.Candidate
	grouper     *Grouper
	seen        map[string]time.Time // observation ids (dedup of overlapping reads)

	Clock         time.Time
	Observations  int
	Duplicates    int
	SuppressedObs int
	BySource      map[string]int
	ByStage       map[string]int
	horizon       time.Duration
}

// NewEngine builds an engine. crit may be nil (every entity is "medium").
func NewEngine(p Policy, patterns []Pattern, r *resolve.Resolver, crit func(model.Entity) string, groupMinLevel int) *Engine {
	if crit == nil {
		crit = func(model.Entity) string { return "" }
	}
	h := p.Window
	for _, pt := range patterns {
		if pt.Window > h {
			h = pt.Window
		}
	}
	return &Engine{
		P: p, Patterns: patterns, Resolver: r, Criticality: crit, supp: noSuppression{},
		GroupMinLevel: groupMinLevel,
		states:        map[string]*EntityState{}, related: map[string]map[string]time.Time{},
		history: map[string]stageHistory{}, episodes: map[string]*episode{},
		patternMark: map[string]patternMark{}, open: map[string][]*model.Candidate{},
		byID: map[string]*model.Candidate{}, grouper: NewGrouper(p.GroupGap, p.GroupMaxSpan),
		seen: map[string]time.Time{}, BySource: map[string]int{}, ByStage: map[string]int{},
		horizon: h,
	}
}

// SetSuppressor replaces the suppression source (feedback loop).
func (e *Engine) SetSuppressor(s Suppressor) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if s == nil {
		s = noSuppression{}
	}
	e.supp = s
}

func candidateID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "rc_" + hex.EncodeToString(sum[:12])
}

// Process ingests one observation and returns the candidates it created.
func (e *Engine) Process(o model.Observation) []*model.Candidate {
	e.mu.Lock()
	defer e.mu.Unlock()
	if o.ID != "" {
		if _, dup := e.seen[o.ID]; dup {
			e.Duplicates++
			return nil
		}
		e.seen[o.ID] = o.Time
	}
	e.applyMerges()
	if o.Time.After(e.Clock) {
		e.Clock = o.Time
	}
	e.Observations++
	e.BySource[o.Source]++
	for _, s := range o.Stages {
		e.ByStage[string(s)]++
	}

	keys := make([]string, 0, len(o.Entities))
	for _, ent := range o.Entities {
		keys = append(keys, ent.Key())
	}
	if o.Level >= e.GroupMinLevel {
		e.grouper.Add(PivotOf(keys, o.RuleID), o.RuleID, o.Time)
	}

	created := []*model.Candidate{}
	for _, ent := range o.Entities {
		key := ent.Key()
		st := e.states[key]
		if st == nil {
			st = newState(ent, e.Criticality(ent))
			e.states[key] = st
		}
		suppressed := e.supp.Suppressed(o.RuleID, key, o.Time)
		if suppressed {
			e.SuppressedObs++
		}
		st.apply(o, e.P, suppressed)
		rel := e.related[key]
		if rel == nil {
			rel = map[string]time.Time{}
			e.related[key] = rel
		}
		for _, other := range keys {
			if other != key {
				rel[other] = o.Time
			}
		}
		if len(rel) > 32 {
			trimRelated(rel, 32)
		}
		// Open candidates of this entity absorb the observation (grouping / dedup).
		for _, c := range e.open[key] {
			// Delayed observations must belong to this episode, not merely be older
			// than its upper bounds. Otherwise an unrelated historical event can
			// inflate a current case and contaminate downstream investigation.
			if !o.Time.Before(c.FirstSeen) && o.Time.Sub(c.LastSeen) <= e.P.GroupGap && o.Time.Sub(c.FirstSeen) <= e.P.GroupMaxSpan {
				c.MemberCount++
				if !suppressed {
					c.Sources = unionStrings(c.Sources, []string{o.Source})
					c.Tactics = unionStrings(c.Tactics, o.Tactics)
				}
				if o.ID != "" && len(c.Explanation.EvidenceObservationIDs) < 50 && !contains(c.Explanation.EvidenceObservationIDs, o.ID) {
					c.Explanation.EvidenceObservationIDs = append(c.Explanation.EvidenceObservationIDs, o.ID)
				}
				if o.Time.After(c.LastSeen) {
					c.LastSeen = o.Time
				}
			}
		}
		if !suppressed {
			hist := e.history[key]
			if hist == nil {
				hist = stageHistory{}
				e.history[key] = hist
			}
			for _, s := range o.Stages {
				hist.add(model.StageHit{Stage: s, At: o.Time, RuleID: o.RuleID, ObsID: o.ID, Source: o.Source}, e.horizon)
			}
			if len(o.Stages) > 0 {
				created = append(created, e.evaluatePatterns(st, hist, o)...)
			}
		}
		if c := e.evaluateThreshold(st, o.Time); c != nil {
			created = append(created, c)
		}
	}
	return created
}

func trimRelated(rel map[string]time.Time, keep int) {
	type kv struct {
		k string
		t time.Time
	}
	list := make([]kv, 0, len(rel))
	for k, t := range rel {
		list = append(list, kv{k, t})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].t.After(list[j].t) })
	for _, item := range list[keep:] {
		delete(rel, item.k)
	}
}

// applyMerges folds states of identifiers that the resolver just linked.
func (e *Engine) applyMerges() {
	if e.Resolver == nil {
		return
	}
	for _, m := range e.Resolver.DrainMerges() {
		from := e.states[m.From]
		if from == nil {
			continue
		}
		into := e.states[m.Into]
		if into == nil {
			ent, _ := model.ParseKey(m.Into)
			into = newState(ent, e.Criticality(ent))
			e.states[m.Into] = into
		}
		into.merge(from, e.P)
		delete(e.states, m.From)
		if h := e.history[m.From]; h != nil {
			dst := e.history[m.Into]
			if dst == nil {
				dst = stageHistory{}
				e.history[m.Into] = dst
			}
			for _, hits := range h {
				for _, hit := range hits {
					dst.add(hit, e.horizon)
				}
			}
			delete(e.history, m.From)
		}
		e.open[m.Into] = append(e.open[m.Into], e.open[m.From]...)
		delete(e.open, m.From)
	}
}

func (e *Engine) evaluatePatterns(st *EntityState, hist stageHistory, o model.Observation) []*model.Candidate {
	out := []*model.Candidate{}
	for _, p := range e.Patterns {
		if !p.pivots(st.Entity.Type) {
			continue
		}
		touches := false
		for _, s := range o.Stages {
			if p.uses(s) {
				touches = true
			}
		}
		if !touches {
			continue
		}
		hits, complete := p.Match(hist, o.Time)
		if len(hits) < p.MinStages {
			continue
		}
		markKey := p.ID + "|" + st.Entity.Key()
		if mark, ok := e.patternMark[markKey]; ok && o.Time.Sub(mark.at) <= p.Window && (mark.complete || !complete) {
			continue
		}
		e.patternMark[markKey] = patternMark{at: o.Time, complete: complete}
		priority := p.PartialPriority
		variant := "partial"
		if complete {
			priority, variant = p.Priority, "complete"
		}
		if st.Criticality == "critical" || st.Criticality == "high" {
			priority = bump(priority)
		}
		if e.supp.Suppressed(CorrelatorRulePrefix+p.ID, st.Entity.Key(), o.Time) {
			continue
		}
		idem := fmt.Sprintf("qapaq-correlator|pattern|%s|%s|%s|%d", p.ID, variant, st.Entity.Key(), hits[0].At.Unix())
		c := e.newCandidate(st, o.Time, idem, "pattern", p.ID, priority, p.Signal)
		c.Stages = hits
		c.FirstSeen = hits[0].At
		names := make([]string, len(hits))
		for i, h := range hits {
			// Match returns definition order for unordered patterns. The investigation
			// window must still include every selected stage, including earlier stages
			// listed later in the pattern (for example malware before protection-off).
			if h.At.Before(c.FirstSeen) {
				c.FirstSeen = h.At
			}
			names[i] = fmt.Sprintf("%s (regla %s, %s)", h.Stage, h.RuleID, h.At.UTC().Format("2006-01-02 15:04Z"))
		}
		c.Title = "QAPAQ Riesgo: " + p.Title
		c.Explanation.PatternTitle = p.Title
		c.Explanation.Stages = hits
		stageEvidence := []string{}
		for _, h := range hits {
			if h.ObsID != "" {
				stageEvidence = append(stageEvidence, h.ObsID)
			}
		}
		c.Explanation.EvidenceObservationIDs = mergeIDs(stageEvidence, c.Explanation.EvidenceObservationIDs, 20)
		order, separator := "sin exigir orden temporal", "; "
		if p.Ordered {
			order, separator = "en orden temporal no decreciente", " → "
		}
		// Keep the limitation near the start so bounded notification/MCP projections
		// retain it. Matching timestamps and entities do not establish causality.
		c.Explanation.Narrative = fmt.Sprintf("Correlación temporal; no demuestra causalidad ni compromiso. %s. Se observaron %d de %d etapas %s sobre la misma entidad (%s) dentro de %s: %s. Riesgo %.1f (base %.1f x diversidad %.2f + progresión %.1f).",
			p.Title, len(hits), len(p.Stages), order, st.Entity.Type, p.Window, strings.Join(names, separator), c.RiskScore,
			c.Explanation.ScoreBase, c.Explanation.DiversityMultiplier, c.Explanation.ProgressionBonus)
		c.Summary = fmt.Sprintf("Patrón %s (%s, %d/%d etapas) sobre %s: %s. Riesgo %.1f.",
			p.ID, variant, len(hits), len(p.Stages), st.Entity.Type, strings.Join(names, separator), c.RiskScore)
		out = append(out, e.register(st, c))
	}
	return out
}

func (e *Engine) evaluateThreshold(st *EntityState, at time.Time) *model.Candidate {
	key := st.Entity.Key()
	eff := st.Effective(at, e.P).Effective
	ep := e.episodes[key]
	if ep != nil {
		if eff < e.P.Threshold/2 {
			delete(e.episodes, key)
		}
		return nil
	}
	if eff < e.P.Threshold {
		return nil
	}
	e.episodes[key] = &episode{start: at}
	if e.supp.Suppressed(CorrelatorRulePrefix+"threshold", key, at) {
		return nil
	}
	priority := "P3"
	if eff >= 2*e.P.Threshold {
		priority = "P2"
	}
	if st.Criticality == "critical" || st.Criticality == "high" {
		priority = bump(priority)
	}
	idem := fmt.Sprintf("qapaq-correlator|threshold|%s|%d", key, at.Unix())
	c := e.newCandidate(st, at, idem, "threshold", "threshold", priority, signalFromTactics(st.TacticsAt(at, e.P)))
	c.FirstSeen = st.FirstSeen
	if at.Sub(c.FirstSeen) > e.P.Window {
		c.FirstSeen = at.Add(-e.P.Window)
	}
	top := []string{}
	for i, ctr := range st.Contributors {
		if i == 5 {
			break
		}
		top = append(top, fmt.Sprintf("regla %s (%s, +%.1f)", ctr.RuleID, ctr.Source, ctr.Points))
	}
	b := st.Effective(at, e.P)
	c.Title = fmt.Sprintf("QAPAQ Riesgo: %s supera el umbral de riesgo", entityNoun(st.Entity.Type))
	c.Summary = fmt.Sprintf("Riesgo %.1f ≥ umbral %.0f (base %.1f × diversidad %.2f + progresión %.1f) con %d fuentes y tácticas %s. Aportes recientes: %s.",
		b.Effective, e.P.Threshold, b.Base, b.Diversity, b.Progression, len(st.SourcesAt(at, e.P)),
		strings.Join(st.TacticsAt(at, e.P), ", "), strings.Join(top, "; "))
	c.Explanation.PatternTitle = "Umbral de riesgo por entidad"
	c.Explanation.Narrative = c.Summary
	e.episodes[key].cand = c
	return e.register(st, c)
}

func entityNoun(t model.EntityType) string {
	switch t {
	case model.EntityUser:
		return "Usuario"
	case model.EntityHost:
		return "Equipo"
	case model.EntityIP:
		return "IP"
	}
	return "Recurso cloud"
}

func (e *Engine) newCandidate(st *EntityState, at time.Time, idem, kind, patternID, priority, signal string) *model.Candidate {
	b := st.Effective(at, e.P)
	floor := map[string]float64{"P1": 85, "P2": 65, "P3": 45, "P4": 25}[priority]
	score := int(math.Round(math.Max(floor, math.Min(b.Effective, 100))))
	if score > 100 {
		score = 100
	}
	related := []string{}
	for k := range e.related[st.Entity.Key()] {
		related = append(related, k)
	}
	sort.Strings(related)
	if len(related) > 10 {
		related = related[:10]
	}
	entities := []model.ExplainedEntity{{Key: st.Entity.Key(), Role: "pivot"}}
	for _, k := range related {
		entities = append(entities, model.ExplainedEntity{Key: k, Role: "related"})
	}
	top := []model.Contributor{}
	evidence := []string{}
	for _, ctr := range st.Contributors {
		if ctr.Suppressed || ctr.Points <= 0 {
			continue
		}
		if len(top) < 5 {
			top = append(top, model.Contributor{RuleID: ctr.RuleID, Description: ctr.Description, Source: ctr.Source, Points: ctr.Points, At: ctr.At, ObservationID: ctr.ObsID})
		}
		if len(evidence) < 20 && ctr.ObsID != "" {
			evidence = append(evidence, ctr.ObsID)
		}
	}
	expl := model.Explanation{
		PatternID: patternID, Entities: entities, TopContributors: top, EvidenceObservationIDs: evidence,
		ScoreBase: b.Base, DiversityMultiplier: b.Diversity, ProgressionBonus: b.Progression,
		NextSteps: nextSteps(patternID), Stages: []model.StageHit{},
	}
	return &model.Candidate{
		Explanation: expl,
		ID:          candidateID(idem), IdempotencyKey: idem, Kind: kind, PatternID: patternID,
		Entity: st.Entity, RelatedKeys: related, Score: score, RiskScore: b.Effective,
		Priority: priority, Signal: signal, MemberCount: 1, Sources: st.SourcesAt(at, e.P),
		Tactics: st.TacticsAt(at, e.P), LastSeen: at, CreatedAt: at, Status: model.CandidateProposed,
		QapaqAlertIDs: []string{},
	}
}

func (e *Engine) register(st *EntityState, c *model.Candidate) *model.Candidate {
	if existing, ok := e.byID[c.ID]; ok {
		return existing
	}
	e.candidates = append(e.candidates, c)
	e.byID[c.ID] = c
	key := st.Entity.Key()
	e.open[key] = append(e.open[key], c)
	st.CandidateIDs = append(st.CandidateIDs, c.ID)
	return c
}

func bump(p string) string {
	switch p {
	case "P4":
		return "P3"
	case "P3":
		return "P2"
	case "P2":
		return "P1"
	}
	return p
}

func signalFromTactics(tactics []string) string {
	best, idx := "other", -1
	m := map[string]string{
		"credential-access": "credential_access", "initial-access": "initial_access",
		"persistence": "persistence", "privilege-escalation": "privilege_escalation",
		"defense-evasion": "defense_evasion", "collection": "collection", "exfiltration": "exfiltration",
	}
	for _, t := range tactics {
		if s, ok := m[t]; ok && resolve.TacticIndex(t) > idx {
			best, idx = s, resolve.TacticIndex(t)
		}
	}
	return best
}

// AttachAlerts links QAPAQ alerts to the candidates of their entities (same stage window).
func (e *Engine) AttachAlerts(alerts []model.QapaqAlert) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, a := range alerts {
		if strings.HasPrefix(a.RuleID, CorrelatorRulePrefix) {
			continue
		}
		for _, k := range a.EntityKeys {
			key := k
			if e.Resolver != nil {
				key = e.Resolver.Canonical(k)
			}
			for _, c := range e.open[key] {
				if a.OccurredAt.Before(c.FirstSeen.Add(-e.P.GroupGap)) || a.OccurredAt.After(c.LastSeen.Add(e.P.GroupGap)) {
					continue
				}
				if len(c.QapaqAlertIDs) >= 50 || contains(c.QapaqAlertIDs, a.ID) {
					continue
				}
				c.QapaqAlertIDs = append(c.QapaqAlertIDs, a.ID)
			}
		}
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Copy on update keeps previously returned candidate summaries immutable.
func unionStrings(existing, incoming []string) []string {
	out := append([]string{}, existing...)
	for _, value := range incoming {
		if value != "" && !contains(out, value) {
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

// UpdateCandidate mutates a candidate under the lock (emission results).
func (e *Engine) UpdateCandidate(id string, fn func(*model.Candidate)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if c := e.byID[id]; c != nil {
		fn(c)
	}
}

// Candidate returns a copy of one candidate.
func (e *Engine) Candidate(id string) (model.Candidate, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	c := e.byID[id]
	if c == nil {
		return model.Candidate{}, false
	}
	cp := *c
	cp.Stages = append([]model.StageHit{}, c.Stages...)
	cp.QapaqAlertIDs = append([]string{}, c.QapaqAlertIDs...)
	return cp, true
}

// Candidates returns copies, newest first. status filters when non-empty.
func (e *Engine) Candidates(status string, limit int) []model.Candidate {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := []model.Candidate{}
	for i := len(e.candidates) - 1; i >= 0; i-- {
		c := e.candidates[i]
		if status != "" && c.Status != status {
			continue
		}
		cp := *c
		cp.Stages = append([]model.StageHit{}, c.Stages...)
		cp.QapaqAlertIDs = append([]string{}, c.QapaqAlertIDs...)
		out = append(out, cp)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

// EntitySummary is the list view of an entity.
type EntitySummary struct {
	Key          string    `json:"key"`
	Type         string    `json:"type"`
	Value        string    `json:"value"`
	Score        float64   `json:"score"`
	Breakdown    Breakdown `json:"breakdown"`
	Peak         float64   `json:"peak"`
	PeakAt       time.Time `json:"peakAt"`
	FirstSeen    time.Time `json:"firstSeen"`
	LastSeen     time.Time `json:"lastSeen"`
	Observations int       `json:"observations"`
	Suppressed   int       `json:"suppressedObservations"`
	Sources      []string  `json:"sources"`
	Tactics      []string  `json:"tactics"`
	Criticality  string    `json:"criticality"`
	CandidateIDs []string  `json:"candidateIds"`
}

// EntityDetail adds contributors, timeline, aliases and related entities.
type EntityDetail struct {
	EntitySummary
	Contributors []Contribution  `json:"contributors"`
	Timeline     []TimelinePoint `json:"timeline"`
	Aliases      []string        `json:"aliases"`
	Related      []string        `json:"related"`
}

func (e *Engine) summary(key string, st *EntityState, at time.Time) EntitySummary {
	b := st.Effective(at, e.P)
	crit := st.Criticality
	if crit == "" {
		crit = "medium"
	}
	return EntitySummary{
		Key: key, Type: string(st.Entity.Type), Value: st.Entity.Value, Score: b.Effective,
		Breakdown: b, Peak: round2(st.Peak), PeakAt: st.PeakAt, FirstSeen: st.FirstSeen,
		LastSeen: st.LastSeen, Observations: st.Observations, Suppressed: st.Suppressed,
		Sources: st.SourcesAt(at, e.P), Tactics: st.TacticsAt(at, e.P), Criticality: crit,
		CandidateIDs: append([]string(nil), st.CandidateIDs...),
	}
}

// Top returns the n riskiest entities at time `at` (optionally of one type).
func (e *Engine) Top(n int, typ string, at time.Time) []EntitySummary {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]EntitySummary, 0, len(e.states))
	for key, st := range e.states {
		if typ != "" && string(st.Entity.Type) != typ {
			continue
		}
		s := e.summary(key, st, at)
		if s.Score < 0.01 && n > 0 {
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].Key < out[j].Key
		}
		return out[i].Score > out[j].Score
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

// Keys lists every tracked entity key of a type (used by the API to resolve opaque refs).
func (e *Engine) Keys(typ string) []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := []string{}
	for key, st := range e.states {
		if typ == "" || string(st.Entity.Type) == typ {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

// Detail returns the full view of one entity (aliases resolve to the canonical entity).
func (e *Engine) Detail(key string, at time.Time) (EntityDetail, bool) {
	if e.Resolver != nil {
		key = e.Resolver.Canonical(key)
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	st := e.states[key]
	if st == nil {
		return EntityDetail{}, false
	}
	related := []string{}
	for k := range e.related[key] {
		related = append(related, k)
	}
	sort.Strings(related)
	aliases := []string{}
	if e.Resolver != nil {
		aliases = e.Resolver.Aliases(key)
	}
	timeline := append([]TimelinePoint(nil), st.Timeline...)
	// Close the timeline at `at` with the current decayed score.
	if b := st.Effective(at, e.P); len(timeline) == 0 || timeline[len(timeline)-1].At.Before(at.Truncate(e.P.TimelineBucket)) {
		timeline = append(timeline, TimelinePoint{At: at.Truncate(e.P.TimelineBucket), Score: b.Effective})
	}
	return EntityDetail{
		EntitySummary: e.summary(key, st, at),
		Contributors:  append([]Contribution(nil), st.Contributors...),
		Timeline:      timeline,
		Aliases:       aliases,
		Related:       related,
	}, true
}

// Stats is a consistent copy of the engine counters.
type Stats struct {
	Observations int
	Duplicates   int
	Suppressed   int
	BySource     map[string]int
	ByStage      map[string]int
}

// Stats copies the counters under the lock.
func (e *Engine) Stats() Stats {
	e.mu.RLock()
	defer e.mu.RUnlock()
	st := Stats{Observations: e.Observations, Duplicates: e.Duplicates, Suppressed: e.SuppressedObs, BySource: map[string]int{}, ByStage: map[string]int{}}
	for k, v := range e.BySource {
		st.BySource[k] = v
	}
	for k, v := range e.ByStage {
		st.ByStage[k] = v
	}
	return st
}

// GroupStats reports the grouping of Wazuh alerts at or above GroupMinLevel.
func (e *Engine) GroupStats() (items, groups int, reduction float64) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.grouper.Items, e.grouper.Groups, e.grouper.Reduction()
}

// EntityCounts counts tracked entities by type.
func (e *Engine) EntityCounts() map[string]int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := map[string]int{}
	for _, st := range e.states {
		out[string(st.Entity.Type)]++
	}
	return out
}

// Prune drops cold entities, closed candidate windows and old dedup ids.
func (e *Engine) Prune(at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for key, st := range e.states {
		if at.Sub(st.LastSeen) > e.P.PruneAfter && st.Effective(at, e.P).Effective < 0.5 {
			delete(e.states, key)
			delete(e.history, key)
			delete(e.related, key)
			delete(e.episodes, key)
		}
	}
	for key, list := range e.open {
		kept := list[:0]
		for _, c := range list {
			if at.Sub(c.LastSeen) <= e.P.GroupMaxSpan {
				kept = append(kept, c)
			}
		}
		if len(kept) == 0 {
			delete(e.open, key)
		} else {
			e.open[key] = kept
		}
	}
	for id, t := range e.seen {
		if at.Sub(t) > e.horizon+time.Hour {
			delete(e.seen, id)
		}
	}
	// Candidate history is bounded: keep the most recent 5000.
	if len(e.candidates) > 5000 {
		for _, c := range e.candidates[:len(e.candidates)-5000] {
			delete(e.byID, c.ID)
		}
		e.candidates = append([]*model.Candidate(nil), e.candidates[len(e.candidates)-5000:]...)
	}
}

func mergeIDs(first, second []string, limit int) []string {
	out := []string{}
	for _, list := range [][]string{first, second} {
		for _, id := range list {
			if len(out) < limit && !contains(out, id) {
				out = append(out, id)
			}
		}
	}
	return out
}

// nextSteps is the investigation checklist shown with each candidate.
func nextSteps(patternID string) []string {
	switch patternID {
	case "edge-to-ssh":
		return []string{
			"Confirmar en Cloudflare los bloqueos WAF y las rutas atacadas por la IP.",
			"Revisar en el nodo los intentos SSH y si hubo algun acceso exitoso desde la IP.",
			"Proponer bloqueo de la IP en el borde y en el grupo de seguridad (Ankay, con aprobacion).",
		}
	case "credential-to-privilege":
		return []string{
			"Validar con la persona si reconoce los inicios de sesion y el cambio privilegiado.",
			"Revisar en CloudTrail/Entra que permisos se otorgaron y a quien; revertir si no esta autorizado.",
			"Revocar sesiones y rotar credenciales del usuario si el acceso no es legitimo.",
		}
	case "ssh-bruteforce-then-access":
		return []string{
			"Revisar la sesion SSH aceptada (usuario, hora, comandos) en el host.",
			"Aislar el host o bloquear la IP si el acceso no es legitimo (con aprobacion).",
		}
	case "endpoint-protection-and-malware":
		return []string{
			"Verificar en GravityZone quien desactivo la proteccion y el estado de la deteccion.",
			"Reactivar la proteccion y aislar el equipo si la infeccion sigue activa (con aprobacion).",
		}
	case "access-then-audit-tamper":
		return []string{
			"Restaurar de inmediato la auditoria afectada (CloudTrail/GuardDuty).",
			"Revisar las acciones del usuario durante la ventana sin auditoria y revocar sus sesiones.",
		}
	}
	return []string{
		"Revisar los aportes principales y la linea de tiempo de la entidad.",
		"Agrupar en un incidente si las alertas relacionadas comparten causa; registrar el veredicto para el ciclo de feedback.",
	}
}
