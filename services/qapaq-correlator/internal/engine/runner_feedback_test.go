package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

type feedbackTestAPI struct {
	alerts    []model.QapaqAlert
	truncated bool
	since     time.Time
	err       error
	afterCall func()
}

func (a *feedbackTestAPI) Alerts(_ context.Context, since time.Time) ([]model.QapaqAlert, bool, error) {
	a.since = since
	if a.afterCall != nil {
		a.afterCall()
	}
	return a.alerts, a.truncated, a.err
}

func (*feedbackTestAPI) CreateCandidate(context.Context, sources.CandidateRequest) (sources.CandidateResponse, error) {
	return sources.CandidateResponse{}, nil
}

func (*feedbackTestAPI) Audit(context.Context, sources.AuditRequest) (bool, error) {
	return false, nil
}

func TestRefreshFeedbackKeepsMetricsButDisablesSuppressionsForTruncatedFeed(t *testing.T) {
	now := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	alerts := make([]model.QapaqAlert, 0, 3)
	for index := 0; index < 3; index++ {
		at := now.Add(-time.Duration(index+1) * time.Hour)
		alerts = append(alerts, model.QapaqAlert{
			ID:         []string{"fp-a", "fp-b", "fp-c"}[index],
			RuleID:     "101501",
			Priority:   "P3",
			Verdict:    "false_positive",
			EntityKeys: []string{"ip:192.0.2.200"},
			OccurredAt: at,
			UpdatedAt:  at.Add(10 * time.Minute),
		})
	}
	policy := feedback.DefaultPolicy()
	policy.AutoSuppress = true
	resolver := resolve.New(nil, "")
	engine := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), resolver, nil, 7)
	api := &feedbackTestAPI{alerts: alerts}
	runner := New(Options{Feedback: policy}, engine, resolver, nil, api, nil)
	runner.Now = func() time.Time { return now }

	if err := runner.RefreshFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := runner.Snapshot().Feedback.ActiveCount(now); got != 1 {
		t.Fatalf("complete feed should apply the configured suppression, got %d", got)
	}
	api.truncated = true
	if err := runner.RefreshFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot := runner.Snapshot()
	proposal := findProposal(snapshot.Feedback.Proposals, "101501")
	if proposal == nil || proposal.Suppression != feedback.SuppressionProposed {
		t.Fatalf("expected the incomplete evidence to remain a reviewable proposal: %+v", snapshot.Feedback.Proposals)
	}
	if snapshot.Feedback.FalsePos != 3 || snapshot.Feedback.Verdicts != 3 {
		t.Fatalf("observed feedback metrics were lost: %+v", snapshot.Feedback)
	}
	if !snapshot.AlertsTrunc {
		t.Fatal("snapshot must retain the incomplete-feed indicator")
	}
	if snapshot.Feedback.ReviewCoverage != nil || snapshot.Feedback.ReviewCoverageStatus != feedback.ReviewCoverageIncomplete {
		t.Fatalf("truncated denominator must not publish review coverage: %+v", snapshot.Feedback)
	}
	if snapshot.Feedback.Suppressed("101501", "ip:192.0.2.200", now) || snapshot.Feedback.ActiveCount(now) != 0 {
		t.Fatal("truncated feedback must not apply or renew automatic suppressions")
	}
}

func TestRefreshFeedbackReportsTheEffectiveFeedWindow(t *testing.T) {
	now := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	lookback := 29 * 24 * time.Hour
	policy := feedback.DefaultPolicy()
	api := &feedbackTestAPI{alerts: []model.QapaqAlert{{
		ID: "correlator-alert", RuleID: model.CorrelatorRulePrefix + "edge-to-ssh",
		Verdict: "true_positive", OccurredAt: now.Add(-28 * 24 * time.Hour),
	}}}
	resolver := resolve.New(nil, "")
	engine := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), resolver, nil, 7)
	runner := New(Options{Feedback: policy, FeedbackLookback: lookback}, engine, resolver, nil, api, nil)
	runner.Now = func() time.Time { return now }

	if err := runner.RefreshFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := runner.Snapshot().Feedback
	if !api.since.Equal(now.Add(-lookback)) || got.WindowSeconds != int64(lookback.Seconds()) {
		t.Fatalf("reported feedback window must match fetched feed: since=%s feedback=%+v", api.since, got)
	}
}

func TestFeedbackRefreshFailureAndSuccessUpdateIndependentReadiness(t *testing.T) {
	now := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	api := &feedbackTestAPI{err: errors.New("temporary API failure")}
	resolver := resolve.New(nil, "")
	eng := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), resolver, nil, 7)
	runner := New(Options{
		PollInterval:     time.Minute,
		FeedbackInterval: 10 * time.Second,
		Feedback:         feedback.DefaultPolicy(),
	}, eng, resolver, nil, api, nil)
	runner.Now = func() time.Time { return now }
	runner.mu.Lock()
	runner.ready, runner.backfilled, runner.lastPoll = true, true, now
	runner.mu.Unlock()

	if err := runner.RefreshFeedback(context.Background()); err == nil {
		t.Fatal("expected the feedback refresh failure")
	}
	failed := runner.Readiness(now)
	if failed.Ready || failed.Status != "degraded" || failed.Reason != "feedback_refresh_failed" {
		t.Fatalf("feedback API failure must degrade readiness independently of polling: %+v", failed)
	}
	if failed.FeedbackStatus != "failed" || failed.FeedbackReady || !failed.LastPoll.Equal(now) || failed.LastFeedbackSuccess != nil {
		t.Fatalf("failure should expose feedback state without changing poll success: %+v", failed)
	}
	if got := runner.C.FeedbackErrors.Load(); got != 1 {
		t.Fatalf("feedback refresh error counter = %d, want 1", got)
	}

	api.err = nil
	if err := runner.RefreshFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
	healthy := runner.Readiness(now)
	if !healthy.Ready || healthy.Status != "ready" || !healthy.FeedbackReady || healthy.FeedbackStatus != "ready" {
		t.Fatalf("successful feedback refresh should restore readiness: %+v", healthy)
	}
	if healthy.LastFeedbackSuccess == nil || !healthy.LastFeedbackSuccess.Equal(now) || healthy.FeedbackAgeSecs == nil || *healthy.FeedbackAgeSecs != 0 {
		t.Fatalf("successful feedback timestamp/age missing: %+v", healthy)
	}

	stale := runner.Readiness(now.Add(30*time.Second + time.Nanosecond))
	if stale.Ready || stale.Status != "degraded" || stale.Reason != "feedback_stale" || stale.FeedbackStatus != "stale" {
		t.Fatalf("feedback older than three intervals must degrade readiness while poll remains fresh: %+v", stale)
	}
	if stale.LastPoll == (time.Time{}) || stale.FeedbackAgeSecs == nil || *stale.FeedbackAgeSecs <= 30 {
		t.Fatalf("stale feedback age/independent poll evidence missing: %+v", stale)
	}
}

func TestRefreshFeedbackRecordsAPICompletionTime(t *testing.T) {
	startedAt := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	completedAt := startedAt.Add(17 * time.Second)
	now := startedAt
	api := &feedbackTestAPI{afterCall: func() { now = completedAt }}
	resolver := resolve.New(nil, "")
	eng := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), resolver, nil, 7)
	runner := New(Options{
		PollInterval: time.Minute,
		Feedback:     feedback.DefaultPolicy(),
	}, eng, resolver, nil, api, nil)
	runner.Now = func() time.Time { return now }
	runner.mu.Lock()
	runner.ready, runner.backfilled, runner.lastPoll = true, true, completedAt
	runner.mu.Unlock()

	if err := runner.RefreshFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := runner.Snapshot().LastFeedback
	if !got.Equal(completedAt) {
		t.Fatalf("last feedback success = %s, want API completion time %s", got, completedAt)
	}
	readiness := runner.Readiness(completedAt)
	if !readiness.Ready || readiness.LastFeedbackSuccess == nil || !readiness.LastFeedbackSuccess.Equal(completedAt) {
		t.Fatalf("readiness must expose completion timestamp as latest success: %+v", readiness)
	}
}

func findProposal(proposals []feedback.Proposal, ruleID string) *feedback.Proposal {
	for index := range proposals {
		if proposals[index].RuleID == ruleID && proposals[index].Kind == feedback.KindAllowlist {
			return &proposals[index]
		}
	}
	return nil
}
