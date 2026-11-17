package engine_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/engine"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

// replayBacklogged runs the fixture as if the correlator only saw it `delay` after the events
// (an ingestion backlog) and returns what reached the API plus the runner.
func replayBacklogged(t *testing.T, delay, maxAge, lateMax time.Duration, perHour int) (*fakeAPI, *engine.Runner, int) {
	t.Helper()
	docs, alerts := loadFixtures(t)
	gw := fakeGateway(t, docs)
	t.Cleanup(gw.Close)
	api := &fakeAPI{alerts: alerts, audits: map[string]sources.AuditRequest{}}
	apiSrv := api.server()
	t.Cleanup(apiSrv.Close)

	now := time.Date(2026, 11, 4, 20, 0, 0, 0, time.UTC).Add(delay)
	res := resolve.New(nil, "")
	eng := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), res, nil, 7)
	runner := engine.New(engine.Options{
		Backfill: 14 * 24 * time.Hour, PollInterval: time.Minute, FeedbackInterval: time.Minute,
		Lag: 30 * time.Second, Overlap: 2 * time.Minute, Emit: true, EmitMaxAge: maxAge, EmitLateMaxAge: lateMax,
		EmitMaxPerHour: perHour, Audit: true, FeedbackLookback: 30 * 24 * time.Hour, Feedback: feedback.DefaultPolicy(),
	}, eng, res,
		&sources.WazuhGateway{BaseURL: gw.URL, Token: func() string { return gwToken }, Client: gw.Client(), MinLevel: 3, PageSize: 7},
		&sources.QAPAQAPI{BaseURL: apiSrv.URL + "/api", Token: func() string { return svcToken }, Client: apiSrv.Client()},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	runner.Now = func() time.Time { return now }
	created, err := runner.Backfill(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	runner.Emit(context.Background(), created)
	return api, runner, len(created)
}

func TestBackloggedCandidatesAreDroppedWhenLateEmissionIsDisabled(t *testing.T) {
	api, runner, total := replayBacklogged(t, 30*time.Hour, 6*time.Hour, 0, 100)
	if total == 0 || len(api.candidates) != 0 || runner.C.EmitSkipped.Load() != int64(total) {
		t.Fatalf("total=%d emitted=%d skipped=%d", total, len(api.candidates), runner.C.EmitSkipped.Load())
	}
}

func TestBackloggedHighPriorityCandidatesEmitLateAndFlagged(t *testing.T) {
	api, runner, total := replayBacklogged(t, 30*time.Hour, 6*time.Hour, 72*time.Hour, 100)
	if len(api.candidates) == 0 {
		t.Fatal("expected late P1/P2 candidates to be emitted")
	}
	for _, c := range api.candidates {
		if c.Priority != "P1" && c.Priority != "P2" {
			t.Errorf("late emission must be limited to P1/P2, got %s (%s)", c.Priority, c.PatternID)
		}
		if !strings.HasPrefix(c.Summary, "[Detección tardía") {
			t.Errorf("late candidate summary not flagged: %q", c.Summary)
		}
	}
	if runner.C.EmittedLate.Load() != int64(len(api.candidates)) {
		t.Errorf("late counter %d != emitted %d", runner.C.EmittedLate.Load(), len(api.candidates))
	}
	if len(api.candidates)+int(runner.C.EmitSkipped.Load()) != total {
		t.Errorf("emitted %d + skipped %d != total %d", len(api.candidates), runner.C.EmitSkipped.Load(), total)
	}
}

func TestBackloggedEmissionBeyondLateWindowIsDropped(t *testing.T) {
	api, _, _ := replayBacklogged(t, 200*time.Hour, 6*time.Hour, 72*time.Hour, 100)
	if len(api.candidates) != 0 {
		t.Fatalf("candidates older than the late window must not be emitted: %d", len(api.candidates))
	}
}

func TestLateEmissionSharesRateLimitAndPrefersHighestPriority(t *testing.T) {
	api, _, _ := replayBacklogged(t, 30*time.Hour, 6*time.Hour, 72*time.Hour, 1)
	if len(api.candidates) != 1 {
		t.Fatalf("hourly limit must cap late emission to 1, got %d", len(api.candidates))
	}
	if api.candidates[0].Priority != "P1" {
		t.Errorf("the single slot must go to a P1 candidate, got %s (%s)", api.candidates[0].Priority, api.candidates[0].PatternID)
	}
}
