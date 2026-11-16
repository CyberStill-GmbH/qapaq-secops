// Package model holds the value types shared by the correlator: resolved entities, the
// observations derived from Wazuh alerts, QAPAQ alerts with analyst verdicts and the
// correlated candidates the engine proposes.
package model

import (
	"strings"
	"time"
)

// EntityType is the closed set of entity kinds the correlator scores.
type EntityType string

const (
	EntityUser  EntityType = "user"
	EntityHost  EntityType = "host"
	EntityIP    EntityType = "ip"
	EntityCloud EntityType = "cloud"
)

// ValidEntityType reports whether t is one of the four supported kinds.
func ValidEntityType(t string) bool {
	switch EntityType(t) {
	case EntityUser, EntityHost, EntityIP, EntityCloud:
		return true
	}
	return false
}

// Entity is a canonical (already resolved) entity. Its key ("type:value") is the same
// format QAPAQ uses in soc_alerts.entity_keys for users and IPs.
type Entity struct {
	Type  EntityType `json:"type"`
	Value string     `json:"value"`
}

// Key returns "type:value".
func (e Entity) Key() string { return string(e.Type) + ":" + e.Value }

// ParseKey splits "type:value". ok is false for unknown types or empty values.
func ParseKey(key string) (Entity, bool) {
	i := strings.IndexByte(key, ':')
	if i <= 0 || i == len(key)-1 {
		return Entity{}, false
	}
	t := key[:i]
	if !ValidEntityType(t) {
		return Entity{}, false
	}
	return Entity{Type: EntityType(t), Value: key[i+1:]}, true
}

// Stage is a step of a multi-stage pattern (edge WAF block, SSH brute force, ...).
type Stage string

const (
	StageEdgeWAFBlock     Stage = "edge.waf_block"
	StageEdgeScan         Stage = "edge.scan"
	StageSSHBruteForce    Stage = "ssh.bruteforce"
	StageSSHSuccess       Stage = "ssh.success"
	StageAuthFailure      Stage = "auth.failure"
	StageAuthSuccess      Stage = "auth.success"
	StagePrivilegedChange Stage = "priv.change"
	StageProtectionOff    Stage = "endpoint.protection_off"
	StageEndpointMalware  Stage = "endpoint.malware"
	StageCloudTamper      Stage = "cloud.audit_tamper"
)

// Observation is one Wazuh alert after entity resolution and stage classification.
type Observation struct {
	ID          string
	Time        time.Time
	RuleID      string
	Level       int
	Description string
	Groups      []string
	Tactics     []string
	Source      string
	Entities    []Entity
	Stages      []Stage
}

// QapaqAlert is the compact projection of a QAPAQ alert the API's internal feed returns.
type QapaqAlert struct {
	ID         string    `json:"id"`
	RuleID     string    `json:"ruleId"`
	Title      string    `json:"title"`
	Priority   string    `json:"priority"`
	Status     string    `json:"status"`
	Verdict    string    `json:"verdict"`
	Signal     string    `json:"signal"`
	EntityKeys []string  `json:"entityKeys"`
	IncidentID string    `json:"incidentId"`
	OccurredAt time.Time `json:"occurredAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// CorrelatorRulePrefix identifies alerts emitted by the risk correlator. Keep this on the
// shared model so feedback can measure adjudication without importing the risk package.
const CorrelatorRulePrefix = "qapaq-correlator:"

// IsFalsePositive reports a benign/false-positive analyst verdict.
func (a QapaqAlert) IsFalsePositive() bool {
	return a.Verdict == "false_positive" || a.Verdict == "benign"
}

// IsTruePositive reports a confirmed verdict.
func (a QapaqAlert) IsTruePositive() bool { return a.Verdict == "true_positive" }

// StageHit records when a pattern stage was observed and by which rule.
type StageHit struct {
	Stage  Stage     `json:"stage"`
	At     time.Time `json:"at"`
	RuleID string    `json:"ruleId"`
	ObsID  string    `json:"observationId"`
	Source string    `json:"source"`
}

// Candidate statuses.
const (
	CandidateProposed   = "proposed"
	CandidateEmitted    = "emitted"
	CandidateSuppressed = "suppressed"
	CandidateFailed     = "emit_failed"
)

// ExplainedEntity is an entity of a candidate with its role in the explanation.
type ExplainedEntity struct {
	Key  string `json:"key"`
	Role string `json:"role"` // "pivot" or "related"
}

// Contributor is one rule that added risk to the pivot entity.
type Contributor struct {
	RuleID        string    `json:"ruleId"`
	Description   string    `json:"description"`
	Source        string    `json:"source"`
	Points        float64   `json:"points"`
	At            time.Time `json:"at"`
	ObservationID string    `json:"observationId"`
}

// Explanation is what the investigation view and notifications show: why this candidate
// exists (pattern and stages or threshold), which entities, which evidence and what to do.
type Explanation struct {
	PatternID              string            `json:"patternId"`
	PatternTitle           string            `json:"patternTitle"`
	Narrative              string            `json:"narrative"`
	Stages                 []StageHit        `json:"stages"`
	Entities               []ExplainedEntity `json:"entities"`
	EvidenceObservationIDs []string          `json:"evidenceObservationIds"`
	TopContributors        []Contributor     `json:"topContributors"`
	ScoreBase              float64           `json:"scoreBase"`
	DiversityMultiplier    float64           `json:"diversityMultiplier"`
	ProgressionBonus       float64           `json:"progressionBonus"`
	NextSteps              []string          `json:"nextSteps"`
}

// Candidate is a correlated "risk incident" proposal: one entity, one stage window.
type Candidate struct {
	ID             string      `json:"id"`
	IdempotencyKey string      `json:"idempotencyKey"`
	Kind           string      `json:"kind"` // "pattern" or "threshold"
	PatternID      string      `json:"patternId"`
	Title          string      `json:"title"`
	Summary        string      `json:"summary"`
	Entity         Entity      `json:"entity"`
	RelatedKeys    []string    `json:"relatedEntityKeys"`
	Score          int         `json:"score"`
	RiskScore      float64     `json:"riskScore"`
	Priority       string      `json:"priority"`
	Signal         string      `json:"signal"`
	Stages         []StageHit  `json:"stages"`
	MemberCount    int         `json:"memberCount"`
	QapaqAlertIDs    []string    `json:"qapaqAlertIds"`
	Sources        []string    `json:"sources"`
	Tactics        []string    `json:"tactics"`
	FirstSeen      time.Time   `json:"firstSeen"`
	LastSeen       time.Time   `json:"lastSeen"`
	CreatedAt      time.Time   `json:"createdAt"`
	Status         string      `json:"status"`
	AlertID        string      `json:"alertId,omitempty"`
	StatusDetail   string      `json:"statusDetail,omitempty"`
	Explanation    Explanation `json:"explanation"`
}
