package risk

import (
	"sort"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// Pattern is a multi-stage sequence on one pivot entity.
type Pattern struct {
	ID              string
	Title           string
	Pivots          []model.EntityType
	Stages          []model.Stage
	Required        []model.Stage // must be part of any match
	MinStages       int
	Ordered         bool
	Window          time.Duration
	Priority        string // complete match
	PartialPriority string // >= MinStages but not every stage
	Signal          string // QAPAQ signal class of the resulting alert
}

// DefaultPatterns are the multi-stage detections the correlator ships with.
func DefaultPatterns() []Pattern {
	return []Pattern{
		{
			ID:              "edge-to-ssh",
			Title:           "Misma IP: bloqueo WAF de Cloudflare, escaneo del borde y fuerza bruta SSH",
			Pivots:          []model.EntityType{model.EntityIP},
			Stages:          []model.Stage{model.StageEdgeWAFBlock, model.StageEdgeScan, model.StageSSHBruteForce},
			Required:        []model.Stage{model.StageSSHBruteForce},
			MinStages:       2,
			Ordered:         true,
			Window:          24 * time.Hour,
			Priority:        "P2",
			PartialPriority: "P3",
			Signal:          "initial_access",
		},
		{
			ID:              "credential-to-privilege",
			Title:           "Fallos de credencial, acceso exitoso y cambio privilegiado del mismo usuario",
			Pivots:          []model.EntityType{model.EntityUser},
			Stages:          []model.Stage{model.StageAuthFailure, model.StageAuthSuccess, model.StagePrivilegedChange},
			MinStages:       3,
			Ordered:         true,
			Window:          24 * time.Hour,
			Priority:        "P1",
			PartialPriority: "P1",
			Signal:          "privilege_escalation",
		},
		{
			ID:              "ssh-bruteforce-then-access",
			Title:           "Fuerza bruta SSH seguida de acceso exitoso desde la misma IP",
			Pivots:          []model.EntityType{model.EntityIP},
			Stages:          []model.Stage{model.StageSSHBruteForce, model.StageSSHSuccess},
			MinStages:       2,
			Ordered:         true,
			Window:          6 * time.Hour,
			Priority:        "P1",
			PartialPriority: "P1",
			Signal:          "initial_access",
		},
		{
			ID:              "endpoint-protection-and-malware",
			Title:           "Protección del endpoint desactivada y malware en el mismo equipo",
			Pivots:          []model.EntityType{model.EntityHost},
			Stages:          []model.Stage{model.StageProtectionOff, model.StageEndpointMalware},
			MinStages:       2,
			Ordered:         false,
			Window:          72 * time.Hour,
			Priority:        "P1",
			PartialPriority: "P1",
			Signal:          "defense_evasion",
		},
		{
			ID:              "access-then-audit-tamper",
			Title:           "Acceso exitoso seguido de manipulación de la auditoría de AWS",
			Pivots:          []model.EntityType{model.EntityUser},
			Stages:          []model.Stage{model.StageAuthSuccess, model.StageCloudTamper},
			MinStages:       2,
			Ordered:         true,
			Window:          24 * time.Hour,
			Priority:        "P1",
			PartialPriority: "P1",
			Signal:          "defense_evasion",
		},
	}
}

func (p Pattern) pivots(t model.EntityType) bool {
	for _, v := range p.Pivots {
		if v == t {
			return true
		}
	}
	return false
}

func (p Pattern) uses(s model.Stage) bool {
	for _, v := range p.Stages {
		if v == s {
			return true
		}
	}
	return false
}

// stageHistory keeps recent hits per stage for one entity.
type stageHistory map[model.Stage][]model.StageHit

const maxHitsPerStage = 32

func (h stageHistory) add(hit model.StageHit, horizon time.Duration) {
	list := append(h[hit.Stage], hit)
	sort.SliceStable(list, func(i, j int) bool { return list[i].At.Before(list[j].At) })
	// Drop hits older than the longest pattern window relative to the newest one.
	newest := list[len(list)-1].At
	cut := 0
	for cut < len(list) && newest.Sub(list[cut].At) > horizon {
		cut++
	}
	list = list[cut:]
	if len(list) > maxHitsPerStage {
		list = list[len(list)-maxHitsPerStage:]
	}
	h[hit.Stage] = list
}

// Match evaluates a pattern at time `now` over the history. It returns the matched hits (one
// per stage, in stage order for ordered patterns) and whether every stage matched.
func (p Pattern) Match(h stageHistory, now time.Time) ([]model.StageHit, bool) {
	from := now.Add(-p.Window)
	windowed := make(map[model.Stage][]model.StageHit, len(p.Stages))
	inWindow := func(s model.Stage) []model.StageHit {
		if hits, ok := windowed[s]; ok {
			return hits
		}
		out := []model.StageHit{}
		for _, hit := range h[s] {
			if !hit.At.Before(from) && !hit.At.After(now) {
				out = append(out, hit)
			}
		}
		// Histories are sorted ascending, but keep this function correct if a caller
		// provides an unsorted slice. Matching below chooses the newest evidence first.
		sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
		windowed[s] = out
		return out
	}
	n := len(p.Stages)
	var best []model.StageHit
	for mask := 1; mask < 1<<n; mask++ {
		count := 0
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				count++
			}
		}
		if count < p.MinStages || count < len(best) {
			continue
		}
		ok := true
		for _, req := range p.Required {
			found := false
			for i, s := range p.Stages {
				if s == req && mask&(1<<i) != 0 {
					found = true
				}
			}
			if !found {
				ok = false
			}
		}
		if !ok {
			continue
		}
		// Select the newest coherent chain. Choosing the oldest hit in each stage
		// made the explanation point at stale evidence even when a tighter chain was
		// present later in the same window. For ordered patterns, walk backward from
		// the final stage and take the newest hit that still preserves stage order.
		picked := make([]model.StageHit, 0, count)
		selected := make([]int, 0, count)
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				selected = append(selected, i)
			}
		}
		if p.Ordered {
			chosen := make([]model.StageHit, len(selected))
			ceiling := now
			for j := len(selected) - 1; j >= 0; j-- {
				stageHits := inWindow(p.Stages[selected[j]])
				found := false
				for k := len(stageHits) - 1; k >= 0; k-- {
					if !stageHits[k].At.After(ceiling) {
						chosen[j] = stageHits[k]
						ceiling = stageHits[k].At
						found = true
						break
					}
				}
				if !found {
					ok = false
					break
				}
			}
			if ok {
				picked = append(picked, chosen...)
			}
		} else {
			for _, i := range selected {
				stageHits := inWindow(p.Stages[i])
				if len(stageHits) == 0 {
					ok = false
					break
				}
				picked = append(picked, stageHits[len(stageHits)-1])
			}
		}
		if ok && (len(picked) > len(best) || (len(picked) == len(best) && newerEvidenceChain(picked, best))) {
			best = picked
		}
	}
	return best, len(best) == n
}

// newerEvidenceChain lexicographically prefers the newest timestamp from the terminal stage
// backward. It is used only for equal-size partial matches, so the pattern's score/completeness
// and longest-match preference are unchanged.
func newerEvidenceChain(candidate, current []model.StageHit) bool {
	for i := len(candidate) - 1; i >= 0; i-- {
		if candidate[i].At.After(current[i].At) {
			return true
		}
		if candidate[i].At.Before(current[i].At) {
			return false
		}
	}
	return false
}
