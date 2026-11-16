// Package engine wires the correlator: it reads Wazuh alerts through the QAPAQ wazuh-gateway,
// the QAPAQ alert/verdict feed through the API's internal endpoints, runs the risk engine and
// the feedback loop, and emits candidates and audit records back through the API.
package engine

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

// Gateway is the read path to wazuh-alerts-*.
type Gateway interface {
	Page(ctx context.Context, from, to time.Time, after *sources.Cursor) ([]map[string]any, *sources.Cursor, error)
	Health(ctx context.Context) error
}

// API is the QAPAQ API internal surface.
type API interface {
	Alerts(ctx context.Context, since time.Time) ([]model.QapaqAlert, bool, error)
	CreateCandidate(ctx context.Context, req sources.CandidateRequest) (sources.CandidateResponse, error)
	Audit(ctx context.Context, req sources.AuditRequest) (bool, error)
}

// Options are the runner tunables (a subset of config.Config, decoupled for tests).
type Options struct {
	Backfill         time.Duration
	PollInterval     time.Duration
	FeedbackInterval time.Duration
	Lag              time.Duration
	Overlap          time.Duration
	Emit             bool
	EmitMaxAge       time.Duration
	// EmitLateMaxAge extends EmitMaxAge for high-priority (P1/P2) candidates whose evidence is
	// older than EmitMaxAge only because ingestion was backlogged. 0 disables the late path.
	EmitLateMaxAge time.Duration
	EmitMaxPerHour   int
	Audit            bool // record feedback decisions in the QAPAQ audit chain
	FeedbackLookback time.Duration
	Feedback         feedback.Policy
	MaxPagesPerPoll  int
}

// Counters are monotonic metrics.
type Counters struct {
	GatewayErrors  atomic.Int64
	APIErrors      atomic.Int64
	FeedbackErrors atomic.Int64
	Emitted        atomic.Int64
	EmitErrors     atomic.Int64
	EmitSkipped    atomic.Int64
	EmittedLate    atomic.Int64
	AuditRecorded  atomic.Int64
	Polls          atomic.Int64
	PollYields     atomic.Int64
	Pages          atomic.Int64
	Unparseable    atomic.Int64
}

// Runner owns the loops and the derived views.
type Runner struct {
	Opt     Options
	Eng     *risk.Engine
	Res     *resolve.Resolver
	Gateway Gateway
	API     API
	Log     *slog.Logger
	Now     func() time.Time
	C       Counters

	mu              sync.RWMutex
	pollMu          sync.Mutex // one owner of the ordered ingest cursor at a time
	pendingPoll     *pollWindow
	fb              feedback.Result
	alerts          []model.QapaqAlert
	truncated       bool
	dedup           risk.DedupResult
	lastTo          time.Time
	cursorAt        time.Time
	ready           bool
	backfilled      bool
	lastPoll        time.Time
	lastFeedback    time.Time
	lastPollErr     string
	lastFeedbackErr string
	audited         map[string]bool
	emitTimes       []time.Time
}

// pollWindow fixes the time bounds while a bounded poll drains its search_after
// pages. The checkpoint is in memory; process restart rebuilds through Backfill.
type pollWindow struct {
	from, to time.Time
	after    *sources.Cursor
}

// New builds a runner.
func New(opt Options, eng *risk.Engine, res *resolve.Resolver, gw Gateway, api API, log *slog.Logger) *Runner {
	if opt.MaxPagesPerPoll <= 0 {
		opt.MaxPagesPerPoll = 200
	}
	return &Runner{
		Opt: opt, Eng: eng, Res: res, Gateway: gw, API: api, Log: log, Now: time.Now,
		fb: feedback.Result{ReviewCoverageStatus: feedback.ReviewCoverageNoData}, audited: map[string]bool{},
	}
}

// Readiness describes whether the initial backfill completed, Wazuh polling is fresh, and
// feedback from the QAPAQ alert API was refreshed successfully and remains fresh. A failed poll
// or feedback refresh degrades readiness immediately. Otherwise, either input older than
// three configured intervals (at least 30 seconds) is considered stale.
type Readiness struct {
	Ready               bool       `json:"ready"`
	Status              string     `json:"status"`
	Reason              string     `json:"reason,omitempty"`
	LastPoll            time.Time  `json:"lastPoll,omitempty"`
	PollAgeSecs         float64    `json:"pollAgeSeconds,omitempty"`
	FeedbackReady       bool       `json:"feedbackReady"`
	FeedbackStatus      string     `json:"feedbackStatus"`
	FeedbackReason      string     `json:"feedbackReason,omitempty"`
	LastFeedbackSuccess *time.Time `json:"lastFeedbackSuccess,omitempty"`
	FeedbackAgeSecs     *float64   `json:"feedbackAgeSeconds,omitempty"`
	PollWindowPending   bool       `json:"pollWindowPending"`
	PollWindowFrom      *time.Time `json:"pollWindowFrom,omitempty"`
	PollWindowTo        *time.Time `json:"pollWindowTo,omitempty"`
	CoverageThrough     *time.Time `json:"coverageThrough,omitempty"`
	CoverageLagSecs     *float64   `json:"coverageLagSeconds,omitempty"`
}

func (r *Runner) Readiness(at time.Time) Readiness {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.readinessLocked(at)
}

func (r *Runner) readinessLocked(at time.Time) Readiness {
	state := Readiness{Status: "backfilling", Reason: "initial_backfill_incomplete"}
	if !r.lastTo.IsZero() {
		through := r.lastTo
		lag := at.Add(-r.Opt.Lag).Sub(through).Seconds()
		if lag < 0 {
			lag = 0
		}
		state.CoverageThrough, state.CoverageLagSecs = &through, &lag
	}
	if r.pendingPoll != nil {
		from, to := r.pendingPoll.from, r.pendingPoll.to
		state.PollWindowPending = true
		state.PollWindowFrom, state.PollWindowTo = &from, &to
	}
	feedbackReady := r.feedbackReadinessLocked(at, &state)
	if !r.backfilled || !r.ready {
		if r.lastPollErr != "" {
			state.Status, state.Reason = "degraded", "upstream_backfill_failed"
		}
		return state
	}
	state.LastPoll = r.lastPoll
	if r.lastPoll.IsZero() {
		state.Status, state.Reason = "degraded", "upstream_poll_not_succeeded"
		return state
	}
	age := at.Sub(r.lastPoll)
	if age < 0 {
		age = 0
	}
	state.PollAgeSecs = age.Seconds()
	if r.lastPollErr != "" {
		state.Status, state.Reason = "degraded", "upstream_poll_failed"
		return state
	}
	if r.pendingPoll != nil {
		state.Status, state.Reason = "catching_up", "upstream_poll_catching_up"
		return state
	}
	staleAfter := time.Duration(1<<63 - 1)
	if r.Opt.PollInterval <= staleAfter/3 {
		staleAfter = 3 * r.Opt.PollInterval
	}
	if staleAfter < 30*time.Second {
		staleAfter = 30 * time.Second
	}
	if age > staleAfter {
		state.Status, state.Reason = "degraded", "upstream_poll_stale"
		return state
	}
	if !feedbackReady {
		state.Status, state.Reason = "degraded", state.FeedbackReason
		return state
	}
	state.Ready, state.Status, state.Reason = true, "ready", ""
	return state
}

// feedbackReadinessLocked exposes feedback freshness independently from Wazuh poll freshness.
func (r *Runner) feedbackReadinessLocked(at time.Time, state *Readiness) bool {
	if r.lastFeedback.IsZero() {
		state.FeedbackStatus = "pending"
		state.FeedbackReason = "feedback_not_refreshed"
		if r.lastFeedbackErr != "" {
			state.FeedbackStatus = "failed"
			state.FeedbackReason = r.lastFeedbackErr
		}
		return false
	}

	lastSuccess := r.lastFeedback
	state.LastFeedbackSuccess = &lastSuccess
	age := at.Sub(lastSuccess)
	if age < 0 {
		age = 0
	}
	ageSeconds := age.Seconds()
	state.FeedbackAgeSecs = &ageSeconds
	staleAfter := freshnessThreshold(r.Opt.FeedbackInterval)
	if age > staleAfter {
		state.FeedbackStatus = "stale"
		state.FeedbackReason = "feedback_stale"
		return false
	}
	if r.lastFeedbackErr != "" {
		state.FeedbackStatus = "failed"
		state.FeedbackReason = r.lastFeedbackErr
		return false
	}
	state.FeedbackReady = true
	state.FeedbackStatus = "ready"
	return true
}

func freshnessThreshold(interval time.Duration) time.Duration {
	staleAfter := time.Duration(1<<63 - 1)
	if interval <= staleAfter/3 {
		staleAfter = 3 * interval
	}
	if staleAfter < 30*time.Second {
		staleAfter = 30 * time.Second
	}
	return staleAfter
}

// Ready reports whether backfill, upstream polling, and feedback refresh are healthy.
func (r *Runner) Ready() bool { return r.Readiness(r.Now().UTC()).Ready }

// ingest reads [from,to) in order. A non-nil cursor with no error means the page
// budget was consumed, not that the source failed. On error, cursor remains at the
// last completely processed page so retry cannot skip the failed page's evidence.
func (r *Runner) ingest(ctx context.Context, from, to time.Time, maxPages int, cursor *sources.Cursor) ([]*model.Candidate, *sources.Cursor, error) {
	created := []*model.Candidate{}
	for page := 0; maxPages <= 0 || page < maxPages; page++ {
		if err := ctx.Err(); err != nil {
			return created, cursor, err
		}
		docs, next, err := r.Gateway.Page(ctx, from, to, cursor)
		if err != nil {
			r.C.GatewayErrors.Add(1)
			return created, cursor, err
		}
		r.C.Pages.Add(1)
		for _, d := range docs {
			obs, ok := r.Res.Observe(d)
			if !ok {
				r.C.Unparseable.Add(1)
				continue
			}
			created = append(created, r.Eng.Process(obs)...)
			r.mu.Lock()
			if obs.Time.After(r.cursorAt) {
				r.cursorAt = obs.Time
			}
			r.mu.Unlock()
		}
		if next == nil {
			return created, nil, nil
		}
		cursor = next
	}
	return created, cursor, nil
}

// Backfill rebuilds state over the look-back window (no emission of stale candidates).
func (r *Runner) Backfill(ctx context.Context) ([]*model.Candidate, error) {
	r.pollMu.Lock()
	defer r.pollMu.Unlock()
	now := r.Now().UTC()
	to := now.Add(-r.Opt.Lag)
	from := to.Add(-r.Opt.Backfill)
	// Feedback first so that historical suppressions apply in time order.
	if err := r.RefreshFeedback(ctx); err != nil {
		r.Log.Warn("feedback.unavailable_at_start", "error", errText(err))
	}
	start := time.Now()
	// Day-sized slices keep each search bounded.
	created := []*model.Candidate{}
	for sliceFrom := from; sliceFrom.Before(to); sliceFrom = sliceFrom.Add(24 * time.Hour) {
		sliceTo := sliceFrom.Add(24 * time.Hour)
		if sliceTo.After(to) {
			sliceTo = to
		}
		c, _, err := r.ingest(ctx, sliceFrom, sliceTo, 0, nil)
		created = append(created, c...)
		if err != nil {
			r.mu.Lock()
			r.lastPollErr = "upstream_backfill_failed"
			r.mu.Unlock()
			return created, err
		}
	}
	r.mu.Lock()
	r.lastTo, r.backfilled, r.ready = to, true, true
	r.pendingPoll = nil
	r.lastPoll, r.lastPollErr = r.Now().UTC(), ""
	r.mu.Unlock()
	r.attachAlerts()
	r.Log.Info("backfill.completed", "from", from, "to", to, "observations", r.Eng.Stats().Observations,
		"candidates", len(created), "duration_ms", time.Since(start).Milliseconds())
	return created, nil
}

// Poll reads new alerts since the last window (with overlap; ids dedupe).
func (r *Runner) Poll(ctx context.Context) ([]*model.Candidate, error) {
	r.pollMu.Lock()
	defer r.pollMu.Unlock()
	r.mu.RLock()
	window := r.pendingPoll
	if window == nil {
		window = &pollWindow{from: r.lastTo.Add(-r.Opt.Overlap), to: r.Now().UTC().Add(-r.Opt.Lag)}
	}
	r.mu.RUnlock()
	if !window.to.After(window.from) {
		return nil, nil
	}
	r.C.Polls.Add(1)
	created, next, err := r.ingest(ctx, window.from, window.to, r.Opt.MaxPagesPerPoll, window.after)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.pendingPoll = &pollWindow{from: window.from, to: window.to, after: next}
		r.lastPollErr = "upstream_poll_failed"
		return created, err
	}
	r.lastPollErr = ""
	if next != nil {
		r.pendingPoll = &pollWindow{from: window.from, to: window.to, after: next}
		r.C.PollYields.Add(1)
		return created, nil
	}
	r.pendingPoll = nil
	r.lastTo, r.lastPoll = window.to, r.Now().UTC()
	return created, nil
}

// RefreshFeedback pulls the QAPAQ alert feed, recomputes suppressions/proposals and dedup.
func (r *Runner) RefreshFeedback(ctx context.Context) error {
	now := r.Now().UTC()
	alerts, truncated, err := r.API.Alerts(ctx, now.Add(-r.Opt.FeedbackLookback))
	if err != nil {
		r.C.APIErrors.Add(1)
		r.C.FeedbackErrors.Add(1)
		r.mu.Lock()
		r.lastFeedbackErr = "feedback_refresh_failed"
		r.mu.Unlock()
		return err
	}
	completedAt := r.Now().UTC()
	policy := r.Opt.Feedback
	// The internal API intentionally caps the requested feedback feed at 29 days to
	// leave margin under its 30-day validation limit. Report and evaluate the effective
	// window so the denominator/coverage metadata never claims data we did not fetch.
	if r.Opt.FeedbackLookback > 0 && (policy.Window <= 0 || r.Opt.FeedbackLookback < policy.Window) {
		policy.Window = r.Opt.FeedbackLookback
	}
	if truncated {
		// Keep counts and human-review proposals visible, but never derive active
		// suppressions from a partial feed: it may omit a P1 or true-positive alert.
		policy.AutoSuppress = false
	}
	fb := feedback.Evaluate(alerts, r.Res.Canonical, policy, now)
	if truncated {
		// A truncated denominator cannot support a coverage ratio, even when the
		// visible subset contains adjudicated alerts.
		fb.ReviewCoverage = nil
		fb.ReviewCoverageStatus = feedback.ReviewCoverageIncomplete
	}
	r.Eng.SetSuppressor(fb)
	since := now.Add(-r.Opt.Backfill)
	recent := make([]model.QapaqAlert, 0, len(alerts))
	for _, a := range alerts {
		if !a.OccurredAt.Before(since) && !strings.HasPrefix(a.RuleID, risk.CorrelatorRulePrefix) {
			recent = append(recent, a)
		}
	}
	dedup := risk.DedupAlerts(recent, r.Res.Canonical, r.Eng.P.GroupGap, r.Eng.P.GroupMaxSpan)
	r.mu.Lock()
	r.fb, r.alerts, r.truncated, r.dedup, r.lastFeedback = fb, alerts, truncated, dedup, completedAt
	r.lastFeedbackErr = ""
	r.mu.Unlock()
	r.attachAlerts()
	return nil
}

func (r *Runner) attachAlerts() {
	r.mu.RLock()
	alerts := r.alerts
	r.mu.RUnlock()
	if len(alerts) > 0 {
		r.Eng.AttachAlerts(alerts)
	}
}

// AuditFeedback records feedback decisions (idempotent on the API side).
func (r *Runner) AuditFeedback(ctx context.Context) {
	if !r.Opt.Audit {
		return
	}
	r.mu.RLock()
	props := append([]feedback.Proposal(nil), r.fb.Proposals...)
	r.mu.RUnlock()
	for _, p := range props {
		actions := []string{"risk.feedback.proposed"}
		switch p.Suppression {
		case feedback.SuppressionActive:
			actions = append(actions, "risk.suppression.applied")
		case feedback.SuppressionExpired:
			actions = append(actions, "risk.suppression.applied", "risk.suppression.expired")
		}
		for _, action := range actions {
			mark := action + "|" + p.ID
			r.mu.RLock()
			done := r.audited[mark]
			r.mu.RUnlock()
			if done {
				continue
			}
			req := sources.AuditRequest{
				Action: action, ResourceID: p.ID, Outcome: "succeeded", Reason: p.Reason, RuleID: p.RuleID,
				Metadata: map[string]any{
					"kind": p.Kind, "falsePositives": p.FalsePos, "truePositives": p.TruePos,
					"ratio": p.Ratio, "protected": p.Protected, "thresholdAt": p.ThresholdAt.UTC().Format(time.RFC3339),
					"evidenceAlerts": len(p.EvidenceIDs),
				},
			}
			if p.EntityKey != "*" {
				req.EntityKey = p.EntityKey
			}
			if !p.ExpiresAt.IsZero() {
				req.Metadata["expiresAt"] = p.ExpiresAt.UTC().Format(time.RFC3339)
			}
			recorded, err := r.API.Audit(ctx, req)
			if err != nil {
				r.C.APIErrors.Add(1)
				r.Log.Warn("audit.failed", "action", action, "resource", p.ID, "error", errText(err))
				continue
			}
			if recorded {
				r.C.AuditRecorded.Add(1)
			}
			r.mu.Lock()
			r.audited[mark] = true
			r.mu.Unlock()
		}
	}
}

// emitVerdict says whether a candidate may be emitted now and whether it is "late".
//
// A candidate is fresh when its newest evidence is at most EmitMaxAge old. Past that it is
// normally dropped (an alert about something that ended hours ago is noise). The exception is a
// detection backlog (ingestion cursor stuck, correlator restarted after an outage): real
// multi-stage chains then surface "late" through no fault of the detection. Those are emitted
// only when high priority (P1/P2) and not older than EmitLateMaxAge, flagged in the summary,
// and they consume the same hourly slots, so they can never flood the SOC.
func (r *Runner) emitVerdict(now time.Time, c *model.Candidate) (ok, late bool) {
	age := now.Sub(c.LastSeen)
	if age <= r.Opt.EmitMaxAge {
		return true, false
	}
	if r.Opt.EmitLateMaxAge > 0 && age <= r.Opt.EmitLateMaxAge && (c.Priority == "P1" || c.Priority == "P2") {
		return true, true
	}
	return false, false
}

func priorityRank(p string) int {
	switch p {
	case "P1":
		return 0
	case "P2":
		return 1
	case "P3":
		return 2
	}
	return 3
}

// Emit materializes eligible candidates as QAPAQ alerts through the API. Candidates are taken in
// order of priority then score, so the limited hourly slots go to the most valuable ones.
func (r *Runner) Emit(ctx context.Context, cands []*model.Candidate) {
	now := r.Now().UTC()
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if ra, rb := priorityRank(a.Priority), priorityRank(b.Priority); ra != rb {
			return ra < rb
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.LastSeen.After(b.LastSeen)
	})
	for _, c := range cands {
		snap, ok := r.Eng.Candidate(c.ID)
		if !ok || snap.Status != model.CandidateProposed && snap.Status != model.CandidateFailed {
			continue
		}
		cur := &snap
		if !r.Opt.Emit {
			continue
		}
		eligible, late := r.emitVerdict(now, cur)
		if !eligible {
			r.C.EmitSkipped.Add(1)
			r.Eng.UpdateCandidate(c.ID, func(x *model.Candidate) { x.StatusDetail = "stale: not emitted (older than emit max age)" })
			continue
		}
		if !r.takeEmitSlot(now) {
			r.C.EmitSkipped.Add(1)
			r.Eng.UpdateCandidate(c.ID, func(x *model.Candidate) { x.StatusDetail = "rate limited: will retry" })
			continue
		}
		keys := []string{cur.Entity.Key()}
		for _, k := range cur.RelatedKeys {
			if len(keys) >= 8 {
				break
			}
			if strings.HasPrefix(k, "user:") || strings.HasPrefix(k, "ip:") || strings.HasPrefix(k, "host:") || strings.HasPrefix(k, "cloud:") {
				keys = append(keys, k)
			}
		}
		summary := cur.Summary
		if late {
			summary = lateNote(now.Sub(cur.LastSeen)) + " " + summary
		}
		resp, err := r.API.CreateCandidate(ctx, sources.CandidateRequest{
			IdempotencyKey: cur.IdempotencyKey, PatternID: cur.PatternID, Kind: cur.Kind,
			Title: cur.Title, Summary: summary, Priority: cur.Priority, Score: cur.Score,
			RiskScore: math.Min(cur.RiskScore, 100), Signal: cur.Signal, PrimaryEntityKey: cur.Entity.Key(),
			EntityKeys: keys, RelatedAlertIDs: cur.QapaqAlertIDs, OccurredAt: cur.LastSeen,
			FirstSeen: cur.FirstSeen, MemberCount: cur.MemberCount, Stages: cur.Stages,
			Sources: cur.Sources, Tactics: cur.Tactics, Explanation: explanationRequest(cur.Explanation),
		})
		if err != nil {
			r.C.EmitErrors.Add(1)
			r.Log.Warn("candidate.emit_failed", "candidate", c.ID, "error", errText(err))
			r.Eng.UpdateCandidate(c.ID, func(x *model.Candidate) { x.Status, x.StatusDetail = model.CandidateFailed, errText(err) })
			continue
		}
		r.C.Emitted.Add(1)
		if late {
			r.C.EmittedLate.Add(1)
		}
		r.Log.Info("candidate.emitted", "candidate", c.ID, "alert", resp.AlertID, "created", resp.Created, "priority", cur.Priority, "pattern", cur.PatternID)
		r.Eng.UpdateCandidate(c.ID, func(x *model.Candidate) {
			x.Status, x.AlertID, x.StatusDetail = model.CandidateEmitted, resp.AlertID, ""
		})
	}
}

// lateNote tells the analyst the evidence is old (backlog), so urgency is judged accordingly.
func lateNote(age time.Duration) string {
	return "[Detección tardía: la evidencia más reciente es de hace " + strconv.Itoa(int(age.Round(time.Hour)/time.Hour)) +
		" h; probable acumulación de ingesta. Verifica si la actividad sigue vigente.]"
}

func (r *Runner) takeEmitSlot(now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Opt.EmitMaxPerHour <= 0 {
		return false
	}
	kept := r.emitTimes[:0]
	for _, t := range r.emitTimes {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	r.emitTimes = kept
	if len(r.emitTimes) >= r.Opt.EmitMaxPerHour {
		return false
	}
	r.emitTimes = append(r.emitTimes, now)
	return true
}

// Run executes backfill and the loops until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) {
	for {
		created, err := r.Backfill(ctx)
		if err == nil {
			r.Emit(ctx, created)
			r.AuditFeedback(ctx)
			break
		}
		r.Log.Error("backfill.failed", "error", errText(err))
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
	poll := time.NewTicker(r.Opt.PollInterval)
	fbTick := time.NewTicker(r.Opt.FeedbackInterval)
	prune := time.NewTicker(10 * time.Minute)
	defer poll.Stop()
	defer fbTick.Stop()
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			created, err := r.Poll(ctx)
			if err != nil {
				r.Log.Warn("poll.failed", "error", errText(err))
			}
			r.attachAlerts()
			r.Emit(ctx, append(created, r.retryable()...))
		case <-fbTick.C:
			if err := r.RefreshFeedback(ctx); err != nil {
				r.Log.Warn("feedback.failed", "error", errText(err))
				continue
			}
			r.AuditFeedback(ctx)
		case <-prune.C:
			r.Eng.Prune(r.Now().UTC())
		}
	}
}

// retryable returns failed/rate-limited candidates still young enough to emit.
func (r *Runner) retryable() []*model.Candidate {
	if !r.Opt.Emit {
		return nil
	}
	now := r.Now().UTC()
	out := []*model.Candidate{}
	for _, c := range r.Eng.Candidates("", 200) {
		if c.Status == model.CandidateFailed || (c.Status == model.CandidateProposed && c.StatusDetail != "") {
			cp := c
			if ok, _ := r.emitVerdict(now, &cp); ok {
				out = append(out, &cp)
			}
		}
	}
	return out
}

// Snapshot is the read model served by the HTTP layer and the replay report.
type Snapshot struct {
	Ready        bool
	Backfilled   bool
	LastTo       time.Time
	CursorAt     time.Time
	LastPoll     time.Time
	LastFeedback time.Time
	Feedback     feedback.Result
	Dedup        risk.DedupResult
	AlertsTotal  int
	AlertsTrunc  bool
}

// Snapshot copies the runner's derived state.
func (r *Runner) Snapshot() Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return Snapshot{
		Ready: r.readinessLocked(r.Now().UTC()).Ready, Backfilled: r.backfilled, LastTo: r.lastTo, CursorAt: r.cursorAt,
		LastPoll: r.lastPoll, LastFeedback: r.lastFeedback, Feedback: r.fb, Dedup: r.dedup,
		AlertsTotal: len(r.alerts), AlertsTrunc: r.truncated,
	}
}

// Alerts returns the last QAPAQ feed (for the replay report).
func (r *Runner) Alerts() []model.QapaqAlert {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]model.QapaqAlert(nil), r.alerts...)
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// explanationRequest bounds the explanation for the API: stages, evidence ids, narrative and
// next steps become alert reasons that the console and notifications already render.
func explanationRequest(x model.Explanation) *sources.ExplanationRequest {
	ev := x.EvidenceObservationIDs
	if len(ev) > 20 {
		ev = ev[:20]
	}
	stages := x.Stages
	if len(stages) > 6 {
		stages = stages[:6]
	}
	narrative := x.Narrative
	if len(narrative) > 600 {
		narrative = narrative[:600]
	}
	steps := x.NextSteps
	if len(steps) > 4 {
		steps = steps[:4]
	}
	return &sources.ExplanationRequest{Narrative: narrative, Stages: stages, EvidenceObservationIDs: ev, NextSteps: steps}
}
