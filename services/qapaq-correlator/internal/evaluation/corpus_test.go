package evaluation

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

const snapshotDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func baseCorpus() Corpus {
	return Corpus{
		SchemaVersion: SchemaVersion, CorpusID: "corpus-v1", SourceSnapshotSHA256: snapshotDigest,
		AnnotationProtocol: "soc-adjudication-v1", BaselineVersion: "corr-v1", CandidateVersion: "corr-v2",
		EvaluationStart: "2026-01-10T00:00:00Z", EvaluationEnd: "2026-01-20T00:00:00Z",
		Families: []Family{{ID: "identity-auth", EligibleSourceEvents: 1000, Examples: []Example{
			{ID: "calibration-old-tp", OccurredAt: "2026-01-09T23:59:59Z", Label: "positive", BaselineDetected: true, CandidateDetected: false, BaselinePriority: "P2"},
			{ID: "tp-kept", OccurredAt: "2026-01-10T00:00:00Z", Label: "positive", BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P2"},
			{ID: "fp-removed", OccurredAt: "2026-01-11T10:00:00Z", Label: "negative", BaselineDetected: true, CandidateDetected: false, BaselinePriority: "P3"},
			{ID: "tn-kept", OccurredAt: "2026-01-12T10:00:00Z", Label: "negative", BaselineDetected: false, CandidateDetected: false, BaselinePriority: "P4"},
			{ID: "unknown-alert", OccurredAt: "2026-01-13T10:00:00Z", Label: "ambiguous", BaselineDetected: false, CandidateDetected: true, BaselinePriority: "P2"},
		}}},
	}
}

func TestEvaluateUsesTemporalHoldoutAndSeparatesAmbiguousLabels(t *testing.T) {
	report, err := Evaluate(baseCorpus())
	if err != nil {
		t.Fatal(err)
	}
	got := report.Families[0]
	if got.CalibrationExamples != 1 || got.AdjudicatedExamples != 3 || got.AmbiguousExamples != 1 {
		t.Fatalf("holdout counts = %+v", got)
	}
	if got.Baseline.ConfusionMatrix != (ConfusionMatrix{TruePositive: 1, FalsePositive: 1, TrueNegative: 1}) {
		t.Fatalf("baseline matrix = %+v", got.Baseline.ConfusionMatrix)
	}
	if got.Candidate.ConfusionMatrix != (ConfusionMatrix{TruePositive: 1, TrueNegative: 2}) {
		t.Fatalf("candidate matrix = %+v", got.Candidate.ConfusionMatrix)
	}
	if got.Candidate.Precision == nil || *got.Candidate.Precision != 1 || got.Candidate.Recall == nil || *got.Candidate.Recall != 1 {
		t.Fatalf("candidate metrics = %+v", got.Candidate)
	}
	if got.FalsePositivesDelta != 1 || got.FalsePositiveReduction == nil || *got.FalsePositiveReduction != 100 {
		t.Fatalf("false-positive delta = %d, reduction = %v", got.FalsePositivesDelta, got.FalsePositiveReduction)
	}
	if got.Candidate.FalsePositivesPer1k == nil || *got.Candidate.FalsePositivesPer1k != 0 {
		t.Fatalf("candidate FP/1k = %v", got.Candidate.FalsePositivesPer1k)
	}
	if got.Baseline.FalsePositivesPer1k == nil || *got.Baseline.FalsePositivesPer1k != 1 ||
		got.Baseline.FalsePositiveRate == nil || *got.Baseline.FalsePositiveRate != 0.5 {
		t.Fatalf("baseline FP metrics = %+v", got.Baseline)
	}
	if report.Overall.FalsePositivesPer1k != nil {
		t.Fatalf("overall FP/1k must be undefined when family event sets may overlap: %v", report.Overall.FalsePositivesPer1k)
	}
	if report.Overall.ConfusionMatrix != (ConfusionMatrix{TruePositive: 1, TrueNegative: 2}) {
		t.Fatalf("overall candidate counts = %+v", report.Overall.ConfusionMatrix)
	}
	if got.SufficientEvidence {
		t.Fatal("small corpus must not be sufficient for a quality claim")
	}
	if got.PairedFalsePositives.EvidenceSufficient || got.PairedFalsePositives.McNemarExactPValue != nil ||
		got.PairedFalsePositives.SignificantAt05 != nil {
		t.Fatalf("insufficient family evidence must not report significance: %+v", got.PairedFalsePositives)
	}
	if report.OverallPairedFalsePositives.EvidenceSufficient || report.OverallPairedFalsePositives.McNemarExactPValue != nil ||
		report.OverallPairedFalsePositives.SignificantAt05 != nil {
		t.Fatalf("insufficient global evidence must not report significance: %+v", report.OverallPairedFalsePositives)
	}
	if !report.GuardrailsPassed {
		t.Fatalf("unexpected guardrail violation: %v", got.Violations)
	}
}

func TestEvaluateReportsKnownTPAndP1RegressionsWithoutHidingMetrics(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families[0].Examples = append(corpus.Families[0].Examples,
		Example{ID: "tp-regressed", OccurredAt: "2026-01-14T10:00:00Z", Label: "positive", BaselineDetected: true, CandidateDetected: false, BaselinePriority: "P2"},
		Example{ID: "p1-dropped-ambiguous", OccurredAt: "2026-01-15T10:00:00Z", Label: "ambiguous", BaselineDetected: true, CandidateDetected: false, BaselinePriority: "P1"},
	)
	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	got := report.Families[0]
	if report.GuardrailsPassed || got.PreservedTruePositives || got.PreservedP1 {
		t.Fatalf("guardrails should fail: %+v", got)
	}
	if got.Candidate.ConfusionMatrix.FalseNegative != 1 {
		t.Fatalf("metrics must preserve TP regression as FN: %+v", got.Candidate.ConfusionMatrix)
	}
	if len(got.Violations) != 2 || !strings.Contains(got.Violations[0], "candidate_regressed_known_true_positive") || !strings.Contains(got.Violations[1], "candidate_suppressed_baseline_p1") {
		t.Fatalf("violations = %v", got.Violations)
	}
}

func TestEvaluateSufficiencyRequiresPerFamilyMinimums(t *testing.T) {
	corpus := baseCorpus()
	examples := make([]Example, 0, MinLabeled)
	for index := 0; index < MinPositiveExamples; index++ {
		examples = append(examples, Example{ID: "tp-" + id(index), OccurredAt: "2026-01-11T10:00:00Z", Label: "positive", BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P2"})
	}
	for index := 0; index < MinNegativeExamples; index++ {
		examples = append(examples, Example{ID: "fp-" + id(index), OccurredAt: "2026-01-12T10:00:00Z", Label: "negative", BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P3"})
	}
	for index := 0; index < MinLabeled-MinPositiveExamples-MinNegativeExamples; index++ {
		examples = append(examples, Example{ID: "tn-" + id(index), OccurredAt: "2026-01-13T10:00:00Z", Label: "negative", BaselineDetected: false, CandidateDetected: false, BaselinePriority: "P4"})
	}
	corpus.Families[0].Examples = examples
	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	if !report.SufficientEvidence || !report.Families[0].SufficientEvidence {
		t.Fatalf("exact per-family minima should pass: %+v", report.Families[0])
	}
}

func TestEvaluateLeavesUndefinedMetricsNull(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families[0].EligibleSourceEvents = 0
	corpus.Families[0].Examples = []Example{{ID: "unknown", OccurredAt: "2026-01-10T00:00:01Z", Label: "ambiguous", BaselineDetected: false, CandidateDetected: false, BaselinePriority: "P4"}}
	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	got := report.Families[0].Candidate
	if got.Precision != nil || got.Recall != nil || got.FalsePositiveRate != nil || got.FalsePositivesPer1k != nil {
		t.Fatalf("undefined metrics must stay null, got %+v", got)
	}
	if report.SufficientEvidence {
		t.Fatal("zero denominator must not pass evidence gate")
	}
}

func TestDecodeRejectsUnknownFieldsAndTrailingValues(t *testing.T) {
	valid := `{"schemaVersion":"qapaq-correlator-eval/v1","unknown":true}`
	if _, err := Decode(strings.NewReader(valid)); err == nil {
		t.Fatal("unknown fields must be rejected")
	}
	if _, err := Decode(strings.NewReader(`{} {}`)); err == nil {
		t.Fatal("trailing JSON values must be rejected")
	}
}

func TestValidateRejectsDuplicateIDsAndTemporalLeakage(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families[0].Examples = append(corpus.Families[0].Examples,
		Example{ID: "tp-kept", OccurredAt: "2026-01-11T00:00:00Z", Label: "positive", BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P2"},
	)
	if _, err := Evaluate(corpus); err == nil || !strings.Contains(err.Error(), "duplicate example id") {
		t.Fatalf("duplicate id error = %v", err)
	}
	corpus = baseCorpus()
	corpus.Families[0].Examples = append(corpus.Families[0].Examples,
		Example{ID: "outside", OccurredAt: "2026-01-20T00:00:00Z", Label: "negative", BaselineDetected: false, CandidateDetected: false, BaselinePriority: "P4"},
	)
	if _, err := Evaluate(corpus); err == nil || !strings.Contains(err.Error(), "exclusive evaluationEnd") {
		t.Fatalf("window boundary error = %v", err)
	}
}

func TestEvaluateDeduplicatesStableCandidateIdentityAcrossFamilies(t *testing.T) {
	corpus := baseCorpus()
	shared := Example{
		ID: "tp-kept", OccurredAt: "2026-01-10T00:00:00Z", Label: "positive",
		BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P2",
	}
	corpus.Families = append(corpus.Families, Family{
		ID: "credential-abuse", EligibleSourceEvents: 250, Examples: []Example{shared},
	})

	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Overall.ConfusionMatrix; got != (ConfusionMatrix{TruePositive: 1, TrueNegative: 2}) {
		t.Fatalf("shared candidate must count once overall, got %+v", got)
	}
	if got := report.Families[0].Candidate.ConfusionMatrix.TruePositive; got != 1 {
		t.Fatalf("first family must retain its candidate, got TP=%d", got)
	}
	if got := report.Families[1].Candidate.ConfusionMatrix.TruePositive; got != 1 {
		t.Fatalf("second family must retain its candidate, got TP=%d", got)
	}
}

func TestExactMcNemarTwoSidedPValues(t *testing.T) {
	tests := []struct {
		name    string
		removed int
		added   int
		want    float64
	}{
		{name: "ten removals and no additions", removed: 10, want: 2.0 / 1024.0},
		{name: "symmetric additions", added: 10, want: 2.0 / 1024.0},
		{name: "balanced discordances", removed: 5, added: 5, want: 1},
		{name: "no discordances", want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := exactMcNemarTwoSided(tt.removed, tt.added); math.Abs(got-tt.want) > 1e-12 {
				t.Fatalf("exact McNemar p = %.12g, want %.12g", got, tt.want)
			}
		})
	}
}

func TestEvaluateReportsPairedMcNemarOnlyWithSufficientEvidence(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families = []Family{familyWithNegativeDiscordances("identity-auth", 10)}
	corpus.Families[0].EligibleSourceEvents = 1_000

	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	if !report.SufficientEvidence {
		t.Fatal("exact per-family minimums should enable the evidence gate")
	}
	family := report.Families[0].PairedFalsePositives
	if family.FalsePositivesRemoved != 10 || family.FalsePositivesAdded != 0 || !family.EvidenceSufficient {
		t.Fatalf("family paired counts = %+v", family)
	}
	if family.McNemarExactPValue == nil || math.Abs(*family.McNemarExactPValue-2.0/1024.0) > 1e-12 ||
		family.AdjustedPValue == nil || math.Abs(*family.AdjustedPValue-2.0/1024.0) > 1e-12 ||
		family.SignificantAt05 == nil || !*family.SignificantAt05 {
		t.Fatalf("family significance = %+v", family)
	}
	overall := report.OverallPairedFalsePositives
	if overall.FalsePositivesRemoved != 10 || overall.FalsePositivesAdded != 0 || !overall.EvidenceSufficient ||
		overall.McNemarExactPValue == nil || *overall.McNemarExactPValue != 2.0/1024.0 ||
		overall.SignificantAt05 == nil || !*overall.SignificantAt05 {
		t.Fatalf("overall significance = %+v", overall)
	}
}

func TestEvaluateUsesHolmCorrectionAcrossFamilyComparisons(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families = []Family{
		familyWithNegativeDiscordances("auth", 6),
		familyWithNegativeDiscordances("exfiltration", 6),
	}
	corpus.Families[0].EligibleSourceEvents = 1_000
	corpus.Families[1].EligibleSourceEvents = 2_000

	report, err := Evaluate(corpus)
	if err != nil {
		t.Fatal(err)
	}
	if !report.SufficientEvidence {
		t.Fatal("both families meet the evidence threshold")
	}
	for _, family := range report.Families {
		comparison := family.PairedFalsePositives
		if comparison.McNemarExactPValue == nil || math.Abs(*comparison.McNemarExactPValue-0.03125) > 1e-12 {
			t.Fatalf("raw p-value for %s = %+v", family.ID, comparison)
		}
		if comparison.AdjustedPValue == nil || math.Abs(*comparison.AdjustedPValue-0.0625) > 1e-12 {
			t.Fatalf("Holm p-value for %s = %+v", family.ID, comparison)
		}
		if comparison.SignificantAt05 == nil || *comparison.SignificantAt05 {
			t.Fatalf("uncorrected family result must not be called significant after Holm: %+v", comparison)
		}
	}
	if report.OverallPairedFalsePositives.McNemarExactPValue == nil ||
		math.Abs(*report.OverallPairedFalsePositives.McNemarExactPValue-2.0/4096.0) > 1e-12 ||
		report.OverallPairedFalsePositives.SignificantAt05 == nil || !*report.OverallPairedFalsePositives.SignificantAt05 {
		t.Fatalf("single overall comparison should use its unadjusted exact p-value: %+v", report.OverallPairedFalsePositives)
	}
}

func familyWithNegativeDiscordances(familyID string, removed int) Family {
	family := Family{ID: familyID, EligibleSourceEvents: 1_000}
	for index := 0; index < MinPositiveExamples; index++ {
		family.Examples = append(family.Examples, Example{
			ID: familyID + "-tp-" + id(index), OccurredAt: "2026-01-11T10:00:00Z", Label: "positive",
			BaselineDetected: true, CandidateDetected: true, BaselinePriority: "P2",
		})
	}
	for index := 0; index < MinLabeled-MinPositiveExamples; index++ {
		family.Examples = append(family.Examples, Example{
			ID: familyID + "-negative-" + id(index), OccurredAt: "2026-01-12T10:00:00Z", Label: "negative",
			BaselineDetected: index < removed, CandidateDetected: false, BaselinePriority: "P3",
		})
	}
	return family
}

func TestValidateRejectsConflictingCandidateIdentityAcrossFamilies(t *testing.T) {
	corpus := baseCorpus()
	corpus.Families = append(corpus.Families, Family{
		ID: "credential-abuse", EligibleSourceEvents: 250, Examples: []Example{{
			ID: "tp-kept", OccurredAt: "2026-01-10T00:00:00Z", Label: "positive",
			BaselineDetected: true, CandidateDetected: false, BaselinePriority: "P2",
		}},
	})
	if _, err := Evaluate(corpus); err == nil || !strings.Contains(err.Error(), "conflicting adjudication or predictions") {
		t.Fatalf("conflicting cross-family candidate should be rejected, got %v", err)
	}
}

func id(value int) string {
	return fmt.Sprintf("%03d", value)
}
