package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

type paginationPage struct {
	docs []map[string]any
	next *sources.Cursor
	err  error
}

type paginationGateway struct {
	pages []paginationPage
	calls []pollWindow
}

func (g *paginationGateway) Page(_ context.Context, from, to time.Time, after *sources.Cursor) ([]map[string]any, *sources.Cursor, error) {
	g.calls = append(g.calls, pollWindow{from: from, to: to, after: after})
	if len(g.pages) == 0 {
		return nil, nil, errors.New("unexpected gateway request")
	}
	p := g.pages[0]
	g.pages = g.pages[1:]
	return p.docs, p.next, p.err
}

func (*paginationGateway) Health(context.Context) error { return nil }

func pageCursor(at time.Time, id string) *sources.Cursor {
	ms, _ := json.Marshal(at.UnixMilli())
	key, _ := json.Marshal(id)
	return &sources.Cursor{Sort: []json.RawMessage{ms, key}}
}

func pageDocs(at time.Time, ids ...string) []map[string]any {
	docs := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		docs = append(docs, map[string]any{
			"timestamp": at.Format(time.RFC3339Nano), "id": id,
			"rule": map[string]any{"id": "5710", "level": float64(5)},
		})
	}
	return docs
}

func paginationRunner(gw Gateway, now *time.Time, maxPages int) *Runner {
	res := resolve.New(nil, "")
	eng := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), res, nil, 7)
	r := New(Options{
		Backfill: time.Hour, PollInterval: 30 * time.Second, FeedbackInterval: time.Minute,
		Overlap: time.Minute, MaxPagesPerPoll: maxPages, Feedback: feedback.DefaultPolicy(),
	}, eng, res, gw, &feedbackTestAPI{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Now = func() time.Time { return *now }
	r.ready, r.backfilled, r.lastPoll, r.lastFeedback = true, true, *now, *now
	r.lastTo = now.Add(-time.Minute)
	return r
}

func TestPollResumesBoundedPagesWithoutAdvancingCoverageOrChangingWindow(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	windowTo := now
	eventAt := now.Add(-30 * time.Second)
	gw := &paginationGateway{pages: []paginationPage{
		{docs: pageDocs(eventAt, "a", "b"), next: pageCursor(eventAt, "b")},
		{docs: pageDocs(eventAt, "c", "d"), next: pageCursor(eventAt, "d")},
		{docs: pageDocs(eventAt, "e")},
		{},
	}}
	r := paginationRunner(gw, &now, 1)
	originalCoverage := r.lastTo
	for batch := 0; batch < 3; batch++ {
		if _, err := r.Poll(context.Background()); err != nil {
			t.Fatal(err)
		}
		if batch < 2 {
			state := r.Readiness(now)
			if state.Ready || state.Status != "catching_up" || state.Reason != "upstream_poll_catching_up" || !state.PollWindowPending {
				t.Fatalf("bounded work must report incomplete coverage, not success/failure: %+v", state)
			}
			if !r.Snapshot().LastTo.Equal(originalCoverage) || state.CoverageThrough == nil || !state.CoverageThrough.Equal(originalCoverage) || state.CoverageLagSecs == nil || *state.CoverageLagSecs <= 0 {
				t.Fatalf("coverage advanced while evidence was unread: %+v", state)
			}
			if state.PollWindowTo == nil || !state.PollWindowTo.Equal(windowTo) {
				t.Fatalf("fixed pending window not exposed: %+v", state)
			}
		}
		now = now.Add(10 * time.Second)
	}
	if got := r.Eng.Stats(); got.Observations != 5 || got.Duplicates != 0 {
		t.Fatalf("every same-timestamp event must be ingested once: %+v", got)
	}
	if got := r.Readiness(now); !got.Ready || got.PollWindowPending || !r.Snapshot().LastTo.Equal(windowTo) {
		t.Fatalf("completed window must clear continuation and advance coverage: %+v", got)
	}
	for _, call := range gw.calls[:3] {
		if !call.from.Equal(originalCoverage.Add(-r.Opt.Overlap)) || !call.to.Equal(windowTo) {
			t.Fatalf("window changed while paging: %+v", call)
		}
	}
	if gw.calls[0].after != nil || !reflect.DeepEqual(gw.calls[1].after, pageCursor(eventAt, "b")) || !reflect.DeepEqual(gw.calls[2].after, pageCursor(eventAt, "d")) {
		t.Fatalf("poll restarted or lost continuation: %+v", gw.calls)
	}
	if r.C.PollYields.Load() != 2 || r.C.GatewayErrors.Load() != 0 {
		t.Fatalf("normal bounded processing must not increment upstream errors: yields=%d errors=%d", r.C.PollYields.Load(), r.C.GatewayErrors.Load())
	}
	if _, err := r.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	rotated := gw.calls[3]
	if rotated.after != nil || !rotated.from.Equal(windowTo.Add(-r.Opt.Overlap)) || !rotated.to.Equal(now) {
		t.Fatalf("next window must start with overlap and no old cursor: %+v", rotated)
	}
}

func TestPollPartialResponseRetriesFailedPageWithoutLosingSuccessfulProgress(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	windowTo := now
	eventAt := now.Add(-30 * time.Second)
	gw := &paginationGateway{pages: []paginationPage{
		{docs: pageDocs(eventAt, "a"), next: pageCursor(eventAt, "a")},
		{err: sources.ErrIncompleteSearch{Reason: "failed_shards"}},
		{docs: pageDocs(eventAt, "b")},
		{docs: pageDocs(eventAt, "a", "b")}, // overlap reconciliation uses engine id dedupe
	}}
	r := paginationRunner(gw, &now, 3)
	originalCoverage := r.lastTo
	if _, err := r.Poll(context.Background()); err == nil {
		t.Fatal("partial search must fail the batch")
	}
	if got := r.Readiness(now); got.Ready || got.Reason != "upstream_poll_failed" || !got.PollWindowPending || !r.Snapshot().LastTo.Equal(originalCoverage) {
		t.Fatalf("partial page must leave incomplete/degraded coverage: %+v", got)
	}
	now = now.Add(10 * time.Second)
	if _, err := r.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gw.calls[1].after, gw.calls[2].after) || !reflect.DeepEqual(gw.calls[2].after, pageCursor(eventAt, "a")) || !gw.calls[2].to.Equal(windowTo) {
		t.Fatalf("failure retry must preserve the last good cursor and original time bound: %+v", gw.calls)
	}
	if got := r.Readiness(now); !got.Ready || got.PollWindowPending || !r.Snapshot().LastTo.Equal(windowTo) {
		t.Fatalf("successful retry must restore readiness: %+v", got)
	}
	if _, err := r.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := r.Eng.Stats(); got.Observations != 2 || got.Duplicates != 2 {
		t.Fatalf("overlap must not inflate detection evidence: %+v", got)
	}
	if r.C.GatewayErrors.Load() != 1 || r.C.PollYields.Load() != 0 {
		t.Fatalf("only the partial response is a gateway failure: errors=%d yields=%d", r.C.GatewayErrors.Load(), r.C.PollYields.Load())
	}
}

func TestBackfillClearsPendingPollWindow(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	eventAt := now.Add(-30 * time.Second)
	gw := &paginationGateway{pages: []paginationPage{
		{docs: pageDocs(eventAt, "a"), next: pageCursor(eventAt, "a")},
		{}, // backfill succeeds from its own starting boundary
		{}, // next poll starts after the completed backfill
	}}
	r := paginationRunner(gw, &now, 1)
	if _, err := r.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(10 * time.Second)
	if _, err := r.Backfill(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.pendingPoll != nil || !r.Readiness(now).Ready || !r.Snapshot().LastTo.Equal(now) || gw.calls[1].after != nil {
		t.Fatal("completed backfill must replace the prior pending poll checkpoint")
	}
	backfilledThrough := now
	now = now.Add(10 * time.Second)
	if _, err := r.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if call := gw.calls[2]; call.after != nil || !call.from.Equal(backfilledThrough.Add(-r.Opt.Overlap)) || !call.to.Equal(now) {
		t.Fatalf("poll after backfill reused an obsolete checkpoint: %+v", call)
	}
}
