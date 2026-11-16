// Package evaluation computes offline, temporal holdout metrics for analyst-adjudicated
// correlator candidates. It deliberately has no dependencies on the runtime matcher.
package evaluation

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

const SchemaVersion = "qapaq-correlator-eval/v1"
const MaxInputBytes int64 = 32 << 20

const (
	MaxFamilies         = 256
	MaxExamples         = 250_000
	MinLabeled          = 200
	MinPositiveExamples = 20
	MinNegativeExamples = 20
)

const SignificanceAlpha = 0.05

var stableID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// Corpus is an already de-identified, versioned export produced from a complete
// adjudication frame. Candidate rows must include both emitted and non-emitted windows.
type Corpus struct {
	SchemaVersion        string   `json:"schemaVersion"`
	CorpusID             string   `json:"corpusId"`
	SourceSnapshotSHA256 string   `json:"sourceSnapshotSha256"`
	AnnotationProtocol   string   `json:"annotationProtocol"`
	BaselineVersion      string   `json:"baselineVersion"`
	CandidateVersion     string   `json:"candidateVersion"`
	EvaluationStart      string   `json:"evaluationStart"`
	EvaluationEnd        string   `json:"evaluationEnd"`
	Families             []Family `json:"families"`
}

type Family struct {
	ID                   string    `json:"id"`
	EligibleSourceEvents int64     `json:"eligibleSourceEvents"`
	Examples             []Example `json:"examples"`
}

type Example struct {
	// ID is the stable pseudonymous identity of one adjudicated candidate/window across families.
	// Reuse it when that exact candidate appears in multiple families; the overall report deduplicates it.
	ID                string `json:"id"`
	OccurredAt        string `json:"occurredAt"`
	Label             string `json:"label"` // positive, negative, ambiguous
	BaselineDetected  bool   `json:"baselineDetected"`
	CandidateDetected bool   `json:"candidateDetected"`
	BaselinePriority  string `json:"baselinePriority"` // P1-P4; required for P1 preservation audit
}

type ConfusionMatrix struct {
	TruePositive  int `json:"truePositive"`
	FalsePositive int `json:"falsePositive"`
	TrueNegative  int `json:"trueNegative"`
	FalseNegative int `json:"falseNegative"`
}

type Metrics struct {
	ConfusionMatrix     ConfusionMatrix `json:"confusionMatrix"`
	Precision           *float64        `json:"precision"`
	Recall              *float64        `json:"recall"`
	FalsePositiveRate   *float64        `json:"falsePositiveRate"`
	FalsePositivesPer1k *float64        `json:"falsePositivesPer1000EligibleSourceEvents"`
}

// PairedFalsePositiveComparison tests discordant predictions over the same adjudicated
// negative candidate/windows. Evidence-ineligible rows retain counts but no p-value or decision.
type PairedFalsePositiveComparison struct {
	FalsePositivesRemoved int      `json:"falsePositivesRemoved"`
	FalsePositivesAdded   int      `json:"falsePositivesAdded"`
	EvidenceSufficient    bool     `json:"evidenceSufficient"`
	McNemarExactPValue    *float64 `json:"mcnemarExactTwoSidedPValue"`
	AdjustedPValue        *float64 `json:"adjustedPValue"`
	Alpha                 float64  `json:"alpha"`
	SignificantAt05       *bool    `json:"significantAt05"`
	Correction            string   `json:"multipleComparisonCorrection"`
}

type FamilyReport struct {
	ID                     string                        `json:"id"`
	EligibleSourceEvents   int64                         `json:"eligibleSourceEvents"`
	CalibrationExamples    int                           `json:"calibrationExamplesExcluded"`
	AdjudicatedExamples    int                           `json:"adjudicatedExamples"`
	PositiveExamples       int                           `json:"positiveExamples"`
	NegativeExamples       int                           `json:"negativeExamples"`
	AmbiguousExamples      int                           `json:"ambiguousExamplesExcluded"`
	Baseline               Metrics                       `json:"baseline"`
	Candidate              Metrics                       `json:"candidate"`
	FalsePositivesDelta    int                           `json:"falsePositivesReduced"` // baseline FP - candidate FP; can be negative
	FalsePositiveReduction *float64                      `json:"falsePositiveReductionPercent"`
	PairedFalsePositives   PairedFalsePositiveComparison `json:"pairedFalsePositives"`
	SufficientEvidence     bool                          `json:"sufficientEvidence"`
	PreservedTruePositives bool                          `json:"preservedKnownTruePositives"`
	PreservedP1            bool                          `json:"preservedP1"`
	Violations             []string                      `json:"guardrailViolations"`
}

type Report struct {
	SchemaVersion               string                        `json:"schemaVersion"`
	CorpusID                    string                        `json:"corpusId"`
	SourceSnapshotSHA256        string                        `json:"sourceSnapshotSha256"`
	AnnotationProtocol          string                        `json:"annotationProtocol"`
	BaselineVersion             string                        `json:"baselineVersion"`
	CandidateVersion            string                        `json:"candidateVersion"`
	EvaluationStart             string                        `json:"evaluationStart"`
	EvaluationEnd               string                        `json:"evaluationEnd"`
	Families                    []FamilyReport                `json:"families"`
	Overall                     Metrics                       `json:"overallCandidate"`
	OverallPairedFalsePositives PairedFalsePositiveComparison `json:"overallPairedFalsePositives"`
	SufficientEvidence          bool                          `json:"sufficientEvidence"`
	GuardrailsPassed            bool                          `json:"guardrailsPassed"`
}

type counts struct {
	ConfusionMatrix
}

// Decode reads one strict JSON corpus and rejects unknown fields, oversized input, and trailing
// JSON values. The caller should use MaxInputBytes as the reader limit.
func Decode(reader io.Reader) (Corpus, error) {
	var corpus Corpus
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&corpus); err != nil {
		return Corpus{}, fmt.Errorf("decode corpus: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Corpus{}, errors.New("corpus must contain exactly one JSON value")
		}
		return Corpus{}, fmt.Errorf("read trailing data: %w", err)
	}
	return corpus, nil
}

// Evaluate computes baseline and candidate metrics only in [evaluationStart, evaluationEnd).
// Earlier examples are reported as excluded calibration rows; later examples are rejected to
// prevent accidental use of future labels. A guardrail violation is included in the report and
// makes GuardrailsPassed false; it does not conceal the measured regression.
func Evaluate(corpus Corpus) (Report, error) {
	start, end, err := validateCorpus(corpus)
	if err != nil {
		return Report{}, err
	}
	report := Report{
		SchemaVersion: SchemaVersion, CorpusID: corpus.CorpusID,
		SourceSnapshotSHA256: strings.ToLower(corpus.SourceSnapshotSHA256),
		AnnotationProtocol:   corpus.AnnotationProtocol,
		BaselineVersion:      corpus.BaselineVersion, CandidateVersion: corpus.CandidateVersion,
		EvaluationStart: start.Format(time.RFC3339), EvaluationEnd: end.Format(time.RFC3339),
		SufficientEvidence: len(corpus.Families) > 0, GuardrailsPassed: true,
	}
	allCandidate := counts{}
	seenOverallCandidates := make(map[string]struct{})
	overallFPRemoved, overallFPAdded := 0, 0

	families := append([]Family(nil), corpus.Families...)
	sort.Slice(families, func(i, j int) bool { return families[i].ID < families[j].ID })
	for _, family := range families {
		familyReport := FamilyReport{
			ID: family.ID, EligibleSourceEvents: family.EligibleSourceEvents,
			PreservedTruePositives: true, PreservedP1: true,
			Violations: []string{},
		}
		baseline, candidate := counts{}, counts{}
		familyFPRemoved, familyFPAdded := 0, 0
		for _, example := range family.Examples {
			at, _ := time.Parse(time.RFC3339Nano, example.OccurredAt) // validated above
			if at.Before(start) {
				familyReport.CalibrationExamples++
				continue
			}
			if example.BaselinePriority == "P1" && example.BaselineDetected && !example.CandidateDetected {
				familyReport.PreservedP1 = false
				familyReport.Violations = append(familyReport.Violations, "candidate_suppressed_baseline_p1:"+example.ID)
			}
			if example.Label == "ambiguous" {
				familyReport.AmbiguousExamples++
				continue
			}
			familyReport.AdjudicatedExamples++
			if example.Label == "positive" {
				familyReport.PositiveExamples++
			} else {
				familyReport.NegativeExamples++
			}
			countPrediction(&baseline, example.Label == "positive", example.BaselineDetected)
			countPrediction(&candidate, example.Label == "positive", example.CandidateDetected)
			if example.Label == "negative" {
				if example.BaselineDetected && !example.CandidateDetected {
					familyFPRemoved++
				} else if !example.BaselineDetected && example.CandidateDetected {
					familyFPAdded++
				}
			}
			if _, seen := seenOverallCandidates[example.ID]; !seen {
				countPrediction(&allCandidate, example.Label == "positive", example.CandidateDetected)
				if example.Label == "negative" {
					if example.BaselineDetected && !example.CandidateDetected {
						overallFPRemoved++
					} else if !example.BaselineDetected && example.CandidateDetected {
						overallFPAdded++
					}
				}
				seenOverallCandidates[example.ID] = struct{}{}
			}
			if example.Label == "positive" && example.BaselineDetected && !example.CandidateDetected {
				familyReport.PreservedTruePositives = false
				familyReport.Violations = append(familyReport.Violations, "candidate_regressed_known_true_positive:"+example.ID)
			}
		}
		familyReport.Baseline = metrics(baseline, family.EligibleSourceEvents)
		familyReport.Candidate = metrics(candidate, family.EligibleSourceEvents)
		familyReport.FalsePositivesDelta = baseline.FalsePositive - candidate.FalsePositive
		familyReport.FalsePositiveReduction = reductionPercent(baseline.FalsePositive, candidate.FalsePositive)
		familyReport.SufficientEvidence = family.EligibleSourceEvents > 0 &&
			familyReport.AdjudicatedExamples >= MinLabeled &&
			familyReport.PositiveExamples >= MinPositiveExamples &&
			familyReport.NegativeExamples >= MinNegativeExamples
		if !familyReport.SufficientEvidence {
			report.SufficientEvidence = false
		}
		familyReport.PairedFalsePositives = PairedFalsePositiveComparison{
			FalsePositivesRemoved: familyFPRemoved,
			FalsePositivesAdded:   familyFPAdded,
			EvidenceSufficient:    familyReport.SufficientEvidence,
			Alpha:                 SignificanceAlpha,
			Correction:            "Holm-Bonferroni across evidence-sufficient families",
		}
		if familyReport.SufficientEvidence {
			pValue := exactMcNemarTwoSided(familyFPRemoved, familyFPAdded)
			familyReport.PairedFalsePositives.McNemarExactPValue = &pValue
		}
		if len(familyReport.Violations) > 0 {
			report.GuardrailsPassed = false
		}
		report.Families = append(report.Families, familyReport)
	}
	applyHolmCorrection(report.Families)
	// Family eligible-event sets can overlap, so the overall FP/1k denominator is undefined.
	report.Overall = metrics(allCandidate, 0)
	report.OverallPairedFalsePositives = PairedFalsePositiveComparison{
		FalsePositivesRemoved: overallFPRemoved,
		FalsePositivesAdded:   overallFPAdded,
		EvidenceSufficient:    report.SufficientEvidence,
		Alpha:                 SignificanceAlpha,
		Correction:            "none; one overall comparison",
	}
	if report.SufficientEvidence {
		pValue := exactMcNemarTwoSided(overallFPRemoved, overallFPAdded)
		significant := pValue < SignificanceAlpha
		report.OverallPairedFalsePositives.McNemarExactPValue = &pValue
		report.OverallPairedFalsePositives.AdjustedPValue = &pValue
		report.OverallPairedFalsePositives.SignificantAt05 = &significant
	}
	return report, nil
}

// exactMcNemarTwoSided returns 2*P(Binomial(n, 0.5) <= min(removed, added)), capped at 1.
// Lgamma keeps the calculation stable for the largest accepted corpus sizes.
func exactMcNemarTwoSided(removed, added int) float64 {
	n := removed + added
	if n == 0 {
		return 1
	}
	k := removed
	if added < k {
		k = added
	}
	logNFactorial, _ := math.Lgamma(float64(n + 1))
	logTwoToN := float64(n) * math.Ln2
	tail := 0.0
	for i := 0; i <= k; i++ {
		logIFactorial, _ := math.Lgamma(float64(i + 1))
		logRestFactorial, _ := math.Lgamma(float64(n - i + 1))
		tail += math.Exp(logNFactorial - logIFactorial - logRestFactorial - logTwoToN)
	}
	pValue := 2 * tail
	if pValue > 1 {
		return 1
	}
	return pValue
}

// applyHolmCorrection controls the family-wise error rate for the per-family comparisons.
// Families without sufficient evidence do not enter the correction family.
func applyHolmCorrection(families []FamilyReport) {
	type hypothesis struct {
		index int
		p     float64
	}
	hypotheses := make([]hypothesis, 0, len(families))
	for index := range families {
		comparison := &families[index].PairedFalsePositives
		if !comparison.EvidenceSufficient || comparison.McNemarExactPValue == nil {
			continue
		}
		hypotheses = append(hypotheses, hypothesis{index: index, p: *comparison.McNemarExactPValue})
	}
	sort.SliceStable(hypotheses, func(i, j int) bool {
		if hypotheses[i].p == hypotheses[j].p {
			return families[hypotheses[i].index].ID < families[hypotheses[j].index].ID
		}
		return hypotheses[i].p < hypotheses[j].p
	})
	previousAdjusted := 0.0
	for rank, item := range hypotheses {
		adjusted := item.p * float64(len(hypotheses)-rank)
		if adjusted > 1 {
			adjusted = 1
		}
		if adjusted < previousAdjusted {
			adjusted = previousAdjusted
		}
		previousAdjusted = adjusted
		comparison := &families[item.index].PairedFalsePositives
		comparison.AdjustedPValue = &adjusted
		significant := adjusted < SignificanceAlpha
		comparison.SignificantAt05 = &significant
	}
}

func validateCorpus(corpus Corpus) (time.Time, time.Time, error) {
	if corpus.SchemaVersion != SchemaVersion {
		return time.Time{}, time.Time{}, fmt.Errorf("schemaVersion must be %q", SchemaVersion)
	}
	if !stableID.MatchString(corpus.CorpusID) || !stableID.MatchString(corpus.BaselineVersion) ||
		!stableID.MatchString(corpus.CandidateVersion) || corpus.BaselineVersion == corpus.CandidateVersion {
		return time.Time{}, time.Time{}, errors.New("corpusId and distinct baseline/candidate versions are required stable identifiers")
	}
	snapshot, err := hex.DecodeString(corpus.SourceSnapshotSHA256)
	if err != nil || len(snapshot) != 32 {
		return time.Time{}, time.Time{}, errors.New("sourceSnapshotSha256 must be a 64-character SHA-256 hex digest")
	}
	if strings.TrimSpace(corpus.AnnotationProtocol) == "" || len(corpus.AnnotationProtocol) > 128 {
		return time.Time{}, time.Time{}, errors.New("annotationProtocol is required and must be at most 128 characters")
	}
	start, err := time.Parse(time.RFC3339Nano, corpus.EvaluationStart)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("evaluationStart must be RFC3339: %w", err)
	}
	end, err := time.Parse(time.RFC3339Nano, corpus.EvaluationEnd)
	if err != nil || !end.After(start) {
		return time.Time{}, time.Time{}, errors.New("evaluationEnd must be RFC3339 and later than evaluationStart")
	}
	if len(corpus.Families) == 0 || len(corpus.Families) > MaxFamilies {
		return time.Time{}, time.Time{}, fmt.Errorf("families count must be between 1 and %d", MaxFamilies)
	}
	totalExamples := 0
	familyIDs := make(map[string]struct{}, len(corpus.Families))
	type candidateIdentity struct {
		occurredAt        int64
		label             string
		baselineDetected  bool
		candidateDetected bool
		baselinePriority  string
	}
	candidateIDs := make(map[string]candidateIdentity)
	for _, family := range corpus.Families {
		if !stableID.MatchString(family.ID) {
			return time.Time{}, time.Time{}, fmt.Errorf("family id %q is not a stable identifier", family.ID)
		}
		if _, exists := familyIDs[family.ID]; exists {
			return time.Time{}, time.Time{}, fmt.Errorf("duplicate family id %q", family.ID)
		}
		familyIDs[family.ID] = struct{}{}
		if family.EligibleSourceEvents < 0 {
			return time.Time{}, time.Time{}, fmt.Errorf("family %q eligibleSourceEvents cannot be negative", family.ID)
		}
		totalExamples += len(family.Examples)
		if totalExamples > MaxExamples {
			return time.Time{}, time.Time{}, fmt.Errorf("examples exceed limit %d", MaxExamples)
		}
		familyExampleIDs := make(map[string]struct{}, len(family.Examples))
		for _, example := range family.Examples {
			if !stableID.MatchString(example.ID) {
				return time.Time{}, time.Time{}, fmt.Errorf("example id %q is not a stable identifier", example.ID)
			}
			if _, exists := familyExampleIDs[example.ID]; exists {
				return time.Time{}, time.Time{}, fmt.Errorf("duplicate example id %q in family %q", example.ID, family.ID)
			}
			familyExampleIDs[example.ID] = struct{}{}
			at, parseErr := time.Parse(time.RFC3339Nano, example.OccurredAt)
			if parseErr != nil {
				return time.Time{}, time.Time{}, fmt.Errorf("example %q occurredAt must be RFC3339: %w", example.ID, parseErr)
			}
			if !at.Before(end) {
				return time.Time{}, time.Time{}, fmt.Errorf("example %q occurs at or after exclusive evaluationEnd; remove out-of-window data", example.ID)
			}
			if example.Label != "positive" && example.Label != "negative" && example.Label != "ambiguous" {
				return time.Time{}, time.Time{}, fmt.Errorf("example %q label must be positive, negative, or ambiguous", example.ID)
			}
			if example.BaselinePriority != "P1" && example.BaselinePriority != "P2" &&
				example.BaselinePriority != "P3" && example.BaselinePriority != "P4" {
				return time.Time{}, time.Time{}, fmt.Errorf("example %q baselinePriority must be P1-P4", example.ID)
			}
			identity := candidateIdentity{
				occurredAt: at.UTC().UnixNano(), label: example.Label,
				baselineDetected: example.BaselineDetected, candidateDetected: example.CandidateDetected,
				baselinePriority: example.BaselinePriority,
			}
			if previous, exists := candidateIDs[example.ID]; exists && previous != identity {
				return time.Time{}, time.Time{}, fmt.Errorf("candidate id %q has conflicting adjudication or predictions across families", example.ID)
			}
			candidateIDs[example.ID] = identity
		}
	}
	return start, end, nil
}

func countPrediction(target *counts, positive, detected bool) {
	switch {
	case positive && detected:
		target.TruePositive++
	case positive && !detected:
		target.FalseNegative++
	case !positive && detected:
		target.FalsePositive++
	default:
		target.TrueNegative++
	}
}

func (c *counts) add(other counts) {
	c.TruePositive += other.TruePositive
	c.FalsePositive += other.FalsePositive
	c.TrueNegative += other.TrueNegative
	c.FalseNegative += other.FalseNegative
}

func metrics(c counts, eligible int64) Metrics {
	result := Metrics{ConfusionMatrix: c.ConfusionMatrix}
	result.Precision = ratio(c.TruePositive, c.TruePositive+c.FalsePositive)
	result.Recall = ratio(c.TruePositive, c.TruePositive+c.FalseNegative)
	result.FalsePositiveRate = ratio(c.FalsePositive, c.FalsePositive+c.TrueNegative)
	if eligible > 0 {
		v := float64(c.FalsePositive) * 1000 / float64(eligible)
		result.FalsePositivesPer1k = &v
	}
	return result
}

func ratio(numerator, denominator int) *float64 {
	if denominator == 0 {
		return nil
	}
	v := float64(numerator) / float64(denominator)
	return &v
}

func reductionPercent(baselineFP, candidateFP int) *float64 {
	if baselineFP == 0 {
		return nil
	}
	v := float64(baselineFP-candidateFP) * 100 / float64(baselineFP)
	return &v
}
