// Package server exposes the correlator over HTTP on the internal Docker network only (no
// published port). /v1/* requires the API→correlator bearer token; /healthz, /readyz and
// /metrics carry no entity data and are unauthenticated for the container healthcheck and
// scraping from the internal network.
package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/engine"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// Server serves the read model.
type Server struct {
	Runner    *engine.Runner
	ReadToken func() string
	Now       func() time.Time
	Version   string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) authorized(r *http.Request) bool {
	want := s.ReadToken()
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if want == "" || got == "" || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "AUTH_REQUIRED"})
			return
		}
		h(w, r)
	}
}

// Handler builds the mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": s.Version})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		state := s.Runner.Readiness(s.Now().UTC())
		if !state.Ready {
			writeJSON(w, http.StatusServiceUnavailable, state)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("GET /metrics", s.metrics)
	mux.HandleFunc("GET /v1/entities", s.guard(s.entities))
	mux.HandleFunc("GET /v1/entities/keys", s.guard(s.keys))
	mux.HandleFunc("GET /v1/entity", s.guard(s.entity))
	mux.HandleFunc("GET /v1/candidates", s.guard(s.candidates))
	mux.HandleFunc("GET /v1/feedback", s.guard(s.feedback))
	mux.HandleFunc("GET /v1/feedback/allowlist.cdb", s.guard(s.cdb))
	mux.HandleFunc("GET /v1/stats", s.guard(s.stats))
	return http.MaxBytesHandler(mux, 1<<16)
}

func (s *Server) entities(w http.ResponseWriter, r *http.Request) {
	top, err := strconv.Atoi(r.URL.Query().Get("top"))
	if r.URL.Query().Get("top") == "" {
		top, err = 20, nil
	}
	typ := r.URL.Query().Get("type")
	if err != nil || top < 1 || top > 500 || (typ != "" && !model.ValidEntityType(typ)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "VALIDATION_FAILED"})
		return
	}
	now := s.Now().UTC()
	snap := s.Runner.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"asOf": now, "ready": snap.Ready, "threshold": s.Runner.Eng.P.Threshold,
		"items": s.Runner.Eng.Top(top, typ, now),
	})
}

func (s *Server) keys(w http.ResponseWriter, r *http.Request) {
	typ := r.URL.Query().Get("type")
	if !model.ValidEntityType(typ) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "VALIDATION_FAILED"})
		return
	}
	keys := s.Runner.Eng.Keys(typ)
	if len(keys) > 50000 {
		keys = keys[:50000]
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) entity(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if _, ok := model.ParseKey(key); !ok || len(key) > 512 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "VALIDATION_FAILED"})
		return
	}
	now := s.Now().UTC()
	d, ok := s.Runner.Eng.Detail(key, now)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "RESOURCE_UNAVAILABLE"})
		return
	}
	cands := []model.Candidate{}
	for _, id := range d.CandidateIDs {
		if c, ok := s.Runner.Eng.Candidate(id); ok {
			cands = append(cands, c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"asOf": now, "entity": d, "candidates": cands})
}

func (s *Server) candidates(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", model.CandidateProposed, model.CandidateEmitted, model.CandidateSuppressed, model.CandidateFailed:
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "VALIDATION_FAILED"})
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "VALIDATION_FAILED"})
			return
		}
		limit = n
	}
	items := s.Runner.Eng.Candidates(status, limit)
	_, _, red := s.Runner.Eng.GroupStats()
	writeJSON(w, http.StatusOK, map[string]any{
		"asOf": s.Now().UTC(), "items": items,
		"reduction": map[string]any{"wazuhAlerts": red, "qapaqAlerts": s.Runner.Snapshot().Dedup.Reduction},
	})
}

func (s *Server) feedback(w http.ResponseWriter, r *http.Request) {
	snap := s.Runner.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"evaluatedAt": snap.Feedback.EvaluatedAt, "windowSeconds": snap.Feedback.WindowSeconds,
		"verdicts":              snap.Feedback.Verdicts,
		"falsePositiveVerdicts": snap.Feedback.FalsePos, "truePositiveVerdicts": snap.Feedback.TruePos,
		"correlatorAlerts":                snap.Feedback.CorrelatorAlerts,
		"correlatorAdjudicated":           snap.Feedback.CorrelatorAdjudicated,
		"correlatorUnreviewed":            snap.Feedback.CorrelatorUnreviewed,
		"correlatorFalsePositiveVerdicts": snap.Feedback.CorrelatorFalsePos,
		"correlatorTruePositiveVerdicts":  snap.Feedback.CorrelatorTruePos,
		"reviewCoverage":                  snap.Feedback.ReviewCoverage,
		"reviewCoverageStatus":            snap.Feedback.ReviewCoverageStatus,
		"alertFeedTruncated":              snap.AlertsTrunc,
		"activeSuppressions":              snap.Feedback.ActiveCount(s.Now().UTC()),
		"proposals":                       snap.Feedback.Proposals, "cdbListName": "qapaq-correlator-fp-allowlist",
	})
}

func (s *Server) cdb(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(s.Runner.Snapshot().Feedback.CDB()))
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	snap := s.Runner.Snapshot()
	writeJSON(w, http.StatusOK, s.Runner.BuildReport(snap.LastTo.Add(-s.Runner.Opt.Backfill), s.Now().UTC(), 10, false))
}

// metrics renders Prometheus text exposition (no entity values in labels).
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	eng := s.Runner.Eng
	stats := eng.Stats()
	snap := s.Runner.Snapshot()
	now := s.Now().UTC()
	readiness := s.Runner.Readiness(now)
	var b strings.Builder
	gauge := func(name, help string, v float64, labels ...string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
		l := ""
		if len(labels) > 0 {
			l = "{" + strings.Join(labels, ",") + "}"
		}
		fmt.Fprintf(&b, "%s%s %g\n", name, l, v)
	}
	counter := func(name, help string, v int64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
	}
	ready := 0.0
	if readiness.Ready {
		ready = 1
	}
	gauge("qapaq_correlator_ready", "1 when backfill, upstream polling, and feedback refresh are ready", ready)
	pending := 0.0
	if readiness.PollWindowPending {
		pending = 1
	}
	gauge("qapaq_correlator_poll_window_pending", "1 when a fixed poll window still has unread or failed pages", pending)
	if readiness.CoverageLagSecs != nil {
		gauge("qapaq_correlator_coverage_lag_seconds", "Seconds between the polling target and the last completely read window; not source delivery latency", *readiness.CoverageLagSecs)
	}
	counter("qapaq_correlator_poll_yields_total", "Poll batches that exhausted their page budget and preserved a continuation", s.Runner.C.PollYields.Load())
	feedbackReady := 0.0
	if readiness.FeedbackReady {
		feedbackReady = 1
	}
	gauge("qapaq_correlator_feedback_ready", "1 when the QAPAQ alert feedback feed has a recent successful refresh", feedbackReady)
	fmt.Fprintf(&b, "# HELP qapaq_correlator_feedback_status Current QAPAQ feedback refresh state; one status is always 1\n# TYPE qapaq_correlator_feedback_status gauge\n")
	fmt.Fprintf(&b, "qapaq_correlator_feedback_status{status=%q} 1\n", readiness.FeedbackStatus)
	if readiness.FeedbackAgeSecs != nil {
		gauge("qapaq_correlator_feedback_age_seconds", "Seconds since the last successful QAPAQ feedback refresh", *readiness.FeedbackAgeSecs)
	}
	if readiness.LastFeedbackSuccess != nil {
		gauge("qapaq_correlator_feedback_last_success_timestamp_seconds", "Unix timestamp of the last successful QAPAQ feedback refresh", float64(readiness.LastFeedbackSuccess.UnixNano())/float64(time.Second))
	}
	counter("qapaq_correlator_feedback_refresh_errors_total", "Failed QAPAQ alert feedback refreshes", s.Runner.C.FeedbackErrors.Load())
	fmt.Fprintf(&b, "# HELP qapaq_correlator_observations_total Wazuh alerts processed\n# TYPE qapaq_correlator_observations_total counter\n")
	srcs := make([]string, 0, len(stats.BySource))
	for k := range stats.BySource {
		srcs = append(srcs, k)
	}
	sort.Strings(srcs)
	for _, k := range srcs {
		fmt.Fprintf(&b, "qapaq_correlator_observations_total{source=%q} %d\n", k, stats.BySource[k])
	}
	counter("qapaq_correlator_observations_duplicate_total", "Overlapping reads skipped by id", int64(stats.Duplicates))
	counter("qapaq_correlator_observations_suppressed_total", "Contributions zeroed by an active feedback suppression", int64(stats.Suppressed))
	counter("qapaq_correlator_gateway_errors_total", "Failed wazuh-gateway reads", s.Runner.C.GatewayErrors.Load())
	counter("qapaq_correlator_api_errors_total", "Failed QAPAQ API calls", s.Runner.C.APIErrors.Load())
	counter("qapaq_correlator_candidates_emitted_total", "Candidates materialized as QAPAQ alerts", s.Runner.C.Emitted.Load())
	counter("qapaq_correlator_candidates_emit_errors_total", "Failed candidate emissions", s.Runner.C.EmitErrors.Load())
	counter("qapaq_correlator_candidates_emit_skipped_total", "Candidates not emitted (stale or rate limited)", s.Runner.C.EmitSkipped.Load())
	counter("qapaq_correlator_candidates_emitted_late_total", "Candidates emitted after the fresh window (ingest backlog), flagged as late", s.Runner.C.EmittedLate.Load())
	counter("qapaq_correlator_audit_recorded_total", "Feedback decisions recorded in the QAPAQ audit chain", s.Runner.C.AuditRecorded.Load())
	fmt.Fprintf(&b, "# HELP qapaq_correlator_entities Tracked entities\n# TYPE qapaq_correlator_entities gauge\n")
	for _, t := range []string{"user", "host", "ip", "cloud"} {
		fmt.Fprintf(&b, "qapaq_correlator_entities{type=%q} %d\n", t, eng.EntityCounts()[t])
	}
	byStatus := map[string]int{}
	for _, c := range eng.Candidates("", 0) {
		byStatus[c.Status]++
	}
	fmt.Fprintf(&b, "# HELP qapaq_correlator_candidates Candidates by status\n# TYPE qapaq_correlator_candidates gauge\n")
	for _, st := range []string{model.CandidateProposed, model.CandidateEmitted, model.CandidateSuppressed, model.CandidateFailed} {
		fmt.Fprintf(&b, "qapaq_correlator_candidates{status=%q} %d\n", st, byStatus[st])
	}
	_, _, wred := eng.GroupStats()
	fmt.Fprintf(&b, "# HELP qapaq_correlator_reduction_factor Alerts per group (dedup)\n# TYPE qapaq_correlator_reduction_factor gauge\n")
	fmt.Fprintf(&b, "qapaq_correlator_reduction_factor{stream=\"wazuh\"} %g\n", wred)
	fmt.Fprintf(&b, "qapaq_correlator_reduction_factor{stream=\"qapaq\"} %g\n", snap.Dedup.Reduction)
	gauge("qapaq_correlator_suppressions_active", "Active temporary suppressions", float64(snap.Feedback.ActiveCount(now)))
	gauge("qapaq_correlator_feedback_proposals", "Feedback proposals", float64(len(snap.Feedback.Proposals)))
	gauge("qapaq_correlator_feedback_window_seconds", "Lookback window of correlator adjudication counts", float64(snap.Feedback.WindowSeconds))
	fmt.Fprintf(&b, "# HELP qapaq_correlator_feedback_alerts Correlator alert counts by feedback category in the feedback window; false_positive groups false_positive and benign verdicts\n# TYPE qapaq_correlator_feedback_alerts gauge\n")
	fmt.Fprintf(&b, "qapaq_correlator_feedback_alerts{verdict=\"all\"} %d\n", snap.Feedback.CorrelatorAlerts)
	fmt.Fprintf(&b, "qapaq_correlator_feedback_alerts{verdict=\"unreviewed\"} %d\n", snap.Feedback.CorrelatorUnreviewed)
	fmt.Fprintf(&b, "qapaq_correlator_feedback_alerts{verdict=\"false_positive\"} %d\n", snap.Feedback.CorrelatorFalsePos)
	fmt.Fprintf(&b, "qapaq_correlator_feedback_alerts{verdict=\"true_positive\"} %d\n", snap.Feedback.CorrelatorTruePos)
	if snap.Feedback.ReviewCoverage != nil && snap.Feedback.ReviewCoverageStatus == "AVAILABLE" {
		gauge("qapaq_correlator_review_coverage", "Fraction of correlator candidates materialized as QAPAQ alerts in the effective feedback occurrence-time window adjudicated as true_positive, false_positive, benign, or duplicate; absent when unavailable", *snap.Feedback.ReviewCoverage)
	}
	fmt.Fprintf(&b, "# HELP qapaq_correlator_review_coverage_status Status of review coverage: 1 for the single current status label\n# TYPE qapaq_correlator_review_coverage_status gauge\n")
	status := snap.Feedback.ReviewCoverageStatus
	if status == "" {
		status = "NO_DATA"
	}
	fmt.Fprintf(&b, "qapaq_correlator_review_coverage_status{status=%q} 1\n", status)
	fmt.Fprintf(&b, "# HELP qapaq_correlator_feedback_alert_feed_truncated 1 when the API feedback feed was truncated\n# TYPE qapaq_correlator_feedback_alert_feed_truncated gauge\n")
	truncated := 0
	if snap.AlertsTrunc {
		truncated = 1
	}
	fmt.Fprintf(&b, "qapaq_correlator_feedback_alert_feed_truncated %d\n", truncated)
	lag := 0.0
	if !snap.CursorAt.IsZero() {
		lag = now.Sub(snap.CursorAt).Seconds()
	}
	gauge("qapaq_correlator_ingest_lag_seconds", "Now minus the newest processed alert", lag)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(b.String()))
}
