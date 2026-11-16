package risk

import (
	"sort"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// Group is a set of related alerts on one pivot entity inside one stage window: what an
// analyst would handle as a single case.
type Group struct {
	Pivot   string    `json:"pivot"`
	Start   time.Time `json:"start"`
	Last    time.Time `json:"last"`
	Members int       `json:"members"`
	Rules   int       `json:"distinctRules"`
	rules   map[string]bool
}

// Grouper groups items incrementally. Items must arrive roughly in time order; late items
// are attached to the open group of their pivot when they fall inside it.
type Grouper struct {
	Gap     time.Duration
	MaxSpan time.Duration
	open    map[string]*Group
	Closed  int
	Items   int
	Groups  int
}

// NewGrouper builds a grouper with the given gap and maximum span.
func NewGrouper(gap, maxSpan time.Duration) *Grouper {
	return &Grouper{Gap: gap, MaxSpan: maxSpan, open: map[string]*Group{}}
}

// Add assigns an item to a group and reports whether a new group was opened.
func (g *Grouper) Add(pivot, ruleID string, at time.Time) (*Group, bool) {
	g.Items++
	cur := g.open[pivot]
	if cur != nil && at.Sub(cur.Last) <= g.Gap && at.Sub(cur.Start) <= g.MaxSpan && !at.Before(cur.Start.Add(-g.Gap)) {
		cur.Members++
		if at.After(cur.Last) {
			cur.Last = at
		}
		if !cur.rules[ruleID] {
			cur.rules[ruleID] = true
			cur.Rules++
		}
		return cur, false
	}
	if cur != nil {
		g.Closed++
	}
	ng := &Group{Pivot: pivot, Start: at, Last: at, Members: 1, Rules: 1, rules: map[string]bool{ruleID: true}}
	g.open[pivot] = ng
	g.Groups++
	return ng, true
}

// Reduction is items / groups (1 when nothing was grouped).
func (g *Grouper) Reduction() float64 {
	if g.Groups == 0 {
		return 1
	}
	return round2(float64(g.Items) / float64(g.Groups))
}

// PivotOf chooses the grouping entity: user, then host, then IP, then cloud resource. Items
// without entities group by rule (the same rule repeating is the same case).
func PivotOf(keys []string, ruleID string) string {
	best, bestRank := "", 0
	for _, k := range keys {
		e, ok := model.ParseKey(k)
		if !ok {
			continue
		}
		rank := map[model.EntityType]int{model.EntityUser: 4, model.EntityHost: 3, model.EntityIP: 2, model.EntityCloud: 1}[e.Type]
		if rank > bestRank || (rank == bestRank && k < best) {
			best, bestRank = k, rank
		}
	}
	if best == "" {
		return "rule:" + ruleID
	}
	return best
}

// DedupResult summarizes grouping of a batch of QAPAQ alerts.
type DedupResult struct {
	Alerts    int            `json:"alerts"`
	Groups    int            `json:"groups"`
	Reduction float64        `json:"reductionFactor"`
	Largest   []GroupSummary `json:"largestGroups"`
	ByPivot   map[string]int `json:"groupsByPivotType"`
}

// GroupSummary describes one group (pivot is redacted by callers when needed).
type GroupSummary struct {
	Pivot   string    `json:"pivot"`
	Members int       `json:"members"`
	Rules   int       `json:"distinctRules"`
	Start   time.Time `json:"start"`
	Last    time.Time `json:"last"`
}

// DedupAlerts groups QAPAQ alerts by resolved pivot entity and stage window.
func DedupAlerts(alerts []model.QapaqAlert, canonical func(string) string, gap, maxSpan time.Duration) DedupResult {
	sorted := append([]model.QapaqAlert(nil), alerts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].OccurredAt.Before(sorted[j].OccurredAt) })
	g := NewGrouper(gap, maxSpan)
	all := []*Group{}
	byPivot := map[string]int{}
	for _, a := range sorted {
		keys := make([]string, 0, len(a.EntityKeys))
		for _, k := range a.EntityKeys {
			keys = append(keys, canonical(k))
		}
		grp, opened := g.Add(PivotOf(keys, a.RuleID), a.RuleID, a.OccurredAt)
		if opened {
			all = append(all, grp)
			kind := grp.Pivot
			if i := indexByte(kind, ':'); i > 0 {
				kind = kind[:i]
			}
			byPivot[kind]++
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Members > all[j].Members })
	largest := []GroupSummary{}
	for i := 0; i < len(all) && i < 10; i++ {
		largest = append(largest, GroupSummary{Pivot: all[i].Pivot, Members: all[i].Members, Rules: all[i].Rules, Start: all[i].Start, Last: all[i].Last})
	}
	return DedupResult{Alerts: len(sorted), Groups: g.Groups, Reduction: g.Reduction(), Largest: largest, ByPivot: byPivot}
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
