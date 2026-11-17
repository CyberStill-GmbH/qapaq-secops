package engine

import (
	"testing"
	"time"
)

func TestReadinessRequiresBackfillFreshPollAndFeedback(t *testing.T) {
	now := time.Date(2026, time.November, 8, 12, 0, 0, 0, time.UTC)
	runner := New(Options{PollInterval: 10 * time.Second}, nil, nil, nil, nil, nil)

	if got := runner.Readiness(now); got.Ready || got.Status != "backfilling" {
		t.Fatalf("before backfill: got %+v, want backfilling", got)
	} else if got.FeedbackStatus != "pending" || got.FeedbackReason != "feedback_not_refreshed" || got.FeedbackReady {
		t.Fatalf("before first feedback refresh: got %+v, want pending feedback", got)
	}

	runner.mu.Lock()
	runner.ready, runner.backfilled, runner.lastPoll, runner.lastFeedback = true, true, now, now
	runner.mu.Unlock()
	if got := runner.Readiness(now.Add(30 * time.Second)); !got.Ready || got.Status != "ready" {
		t.Fatalf("at stale threshold: got %+v, want ready", got)
	}
	if got := runner.Readiness(now.Add(30*time.Second + time.Nanosecond)); got.Ready || got.Reason != "upstream_poll_stale" {
		t.Fatalf("after stale threshold: got %+v, want stale", got)
	}

	runner.mu.Lock()
	runner.lastPollErr = "upstream_poll_failed"
	runner.mu.Unlock()
	if got := runner.Readiness(now.Add(time.Second)); got.Ready || got.Reason != "upstream_poll_failed" {
		t.Fatalf("after failed poll: got %+v, want degraded", got)
	}
}

func TestReadinessReportsFailedBackfill(t *testing.T) {
	now := time.Now().UTC()
	runner := New(Options{PollInterval: time.Minute}, nil, nil, nil, nil, nil)
	runner.mu.Lock()
	runner.lastPollErr = "upstream_backfill_failed"
	runner.mu.Unlock()

	got := runner.Readiness(now)
	if got.Ready || got.Status != "degraded" || got.Reason != "upstream_backfill_failed" {
		t.Fatalf("got %+v, want degraded upstream backfill failure", got)
	}
}

func TestEmissionRateLimitFailsClosedWhenUnset(t *testing.T) {
	runner := New(Options{}, nil, nil, nil, nil, nil)
	if runner.takeEmitSlot(time.Now()) {
		t.Fatal("zero emission limit must not allow an unbounded emit")
	}
}
