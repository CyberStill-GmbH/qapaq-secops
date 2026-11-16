package engine_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/engine"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/server"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

const (
	gwToken   = "test-gateway-token-0123456789abcdef0123"
	svcToken  = "test-service-token-0123456789abcdef0123"
	readToken = "test-read-token-0123456789abcdef012345"
)

// fakeGateway implements POST /wazuh/_search over the fixture file: range on timestamp,
// rule.level >= n, sort [timestamp, id], search_after and size.
func fakeGateway(t *testing.T, docs []map[string]any) *httptest.Server {
	type row struct {
		ms  int64
		id  string
		doc map[string]any
		lvl float64
	}
	rows := []row{}
	for _, d := range docs {
		ts, _ := d["timestamp"].(string)
		at, err := time.Parse("2006-01-02T15:04:05.000-0700", ts)
		if err != nil {
			t.Fatalf("fixture timestamp %q", ts)
		}
		lvl := 0.0
		if r, ok := d["rule"].(map[string]any); ok {
			lvl, _ = r["level"].(float64)
		}
		rows = append(rows, row{at.UnixMilli(), d["id"].(string), d, lvl})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].ms == rows[j].ms {
			return rows[i].id < rows[j].id
		}
		return rows[i].ms < rows[j].ms
	})
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wazuh/_cluster/health" {
			w.WriteHeader(200)
			return
		}
		if r.URL.Path != "/wazuh/_search" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+gwToken {
			w.WriteHeader(401)
			return
		}
		var q struct {
			Size        int               `json:"size"`
			SearchAfter []json.RawMessage `json:"search_after"`
			Query       struct {
				Bool struct {
					Filter []map[string]map[string]map[string]any `json:"filter"`
				} `json:"bool"`
			} `json:"query"`
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &q); err != nil {
			w.WriteHeader(400)
			return
		}
		var from, to time.Time
		minLevel := 0.0
		for _, f := range q.Query.Bool.Filter {
			if ts, ok := f["range"]["timestamp"]; ok {
				from, _ = time.Parse(time.RFC3339Nano, ts["gte"].(string))
				to, _ = time.Parse(time.RFC3339Nano, ts["lt"].(string))
			}
			if lv, ok := f["range"]["rule.level"]; ok {
				minLevel = lv["gte"].(float64)
			}
		}
		var afterMs int64 = -1
		afterID := ""
		if len(q.SearchAfter) == 2 {
			_ = json.Unmarshal(q.SearchAfter[0], &afterMs)
			_ = json.Unmarshal(q.SearchAfter[1], &afterID)
		}
		hits := []map[string]any{}
		for _, rw := range rows {
			if rw.ms < from.UnixMilli() || rw.ms >= to.UnixMilli() || rw.lvl < minLevel {
				continue
			}
			if afterMs >= 0 && (rw.ms < afterMs || (rw.ms == afterMs && rw.id <= afterID)) {
				continue
			}
			hits = append(hits, map[string]any{"_source": rw.doc, "sort": []any{rw.ms, rw.id}})
			if len(hits) == q.Size {
				break
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"hits": map[string]any{"hits": hits}})
	}))
}

type fakeAPI struct {
	mu           sync.Mutex
	alerts       json.RawMessage
	alertsStatus int
	candidates   []sources.CandidateRequest
	audits       map[string]sources.AuditRequest
}

func (f *fakeAPI) server() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+svcToken {
			w.WriteHeader(404)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/api/internal/correlator/alerts":
			if f.alertsStatus != 0 {
				w.WriteHeader(f.alertsStatus)
				return
			}
			_, _ = w.Write(f.alerts)
		case "/api/internal/correlator/candidates":
			var req sources.CandidateRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			for _, c := range f.candidates {
				if c.IdempotencyKey == req.IdempotencyKey {
					_ = json.NewEncoder(w).Encode(map[string]any{"alertId": "dup", "created": false})
					return
				}
			}
			f.candidates = append(f.candidates, req)
			_ = json.NewEncoder(w).Encode(map[string]any{"alertId": "a-" + req.PatternID, "created": true})
		case "/api/internal/correlator/audit":
			var req sources.AuditRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			key := req.Action + "|" + req.ResourceID
			_, dup := f.audits[key]
			f.audits[key] = req
			_ = json.NewEncoder(w).Encode(map[string]any{"recorded": !dup})
		default:
			w.WriteHeader(404)
		}
	}))
}

func loadFixtures(t *testing.T) ([]map[string]any, json.RawMessage) {
	f, err := os.Open("../../testdata/wazuh-alerts.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	docs := []map[string]any{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var d map[string]any
		if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, d)
	}
	alerts, err := os.ReadFile("../../testdata/qapaq-alerts.json")
	if err != nil {
		t.Fatal(err)
	}
	return docs, alerts
}

func TestIntegrationFixtureReplayEmitsAuditsAndServes(t *testing.T) {
	docs, alerts := loadFixtures(t)
	gw := fakeGateway(t, docs)
	defer gw.Close()
	api := &fakeAPI{alerts: alerts, audits: map[string]sources.AuditRequest{}}
	apiSrv := api.server()
	defer apiSrv.Close()

	now := time.Date(2026, 11, 4, 20, 0, 0, 0, time.UTC)
	res := resolve.New(nil, "")
	eng := risk.NewEngine(risk.DefaultPolicy(), risk.DefaultPatterns(), res, nil, 7)
	fb := feedback.DefaultPolicy()
	fb.AutoSuppress = true
	runner := engine.New(engine.Options{
		Backfill: 48 * time.Hour, PollInterval: time.Minute, FeedbackInterval: time.Minute,
		Lag: 30 * time.Second, Overlap: 2 * time.Minute, Emit: true, EmitMaxAge: 24 * time.Hour,
		EmitMaxPerHour: 100, Audit: true, FeedbackLookback: 30 * 24 * time.Hour, Feedback: fb,
	}, eng, res,
		&sources.WazuhGateway{BaseURL: gw.URL, Token: func() string { return gwToken }, Client: gw.Client(), MinLevel: 3, PageSize: 7},
		&sources.QAPAQAPI{BaseURL: apiSrv.URL + "/api", Token: func() string { return svcToken }, Client: apiSrv.Client()},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	runner.Now = func() time.Time { return now }

	ctx := context.Background()
	created, err := runner.Backfill(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stats := eng.Stats()
	if stats.Observations != 67 || runner.C.Pages.Load() < 10 {
		t.Fatalf("observations %d, unparseable %d, pages %d", stats.Observations, runner.C.Unparseable.Load(), runner.C.Pages.Load())
	}
	patterns := map[string]model.Candidate{}
	for _, c := range eng.Candidates("", 0) {
		if c.Kind == "pattern" {
			patterns[c.PatternID] = c
		}
	}
	for _, want := range []string{"edge-to-ssh", "credential-to-privilege", "endpoint-protection-and-malware"} {
		if _, ok := patterns[want]; !ok {
			t.Errorf("missing pattern candidate %s (have %v)", want, patterns)
		}
	}
	if c := patterns["edge-to-ssh"]; c.Entity.Key() != "ip:203.0.113.77" || len(c.Stages) != 3 {
		t.Errorf("edge-to-ssh: %+v", c)
	}
	if x := patterns["edge-to-ssh"].Explanation; len(x.Stages) != 3 || len(x.EvidenceObservationIDs) < 3 || x.Narrative == "" ||
		len(x.NextSteps) == 0 || x.Entities[0].Role != "pivot" || x.PatternTitle == "" {
		t.Errorf("edge-to-ssh explanation: %+v", x)
	}
	if c := patterns["credential-to-privilege"]; c.Entity.Key() != "user:victima@qapaq.pe" || c.Priority != "P1" || len(c.QapaqAlertIDs) == 0 {
		t.Errorf("credential-to-privilege: %+v", c)
	}
	if c := patterns["endpoint-protection-and-malware"]; c.Entity.Key() != "host:pc-ep-a" {
		t.Errorf("endpoint pattern on merged host: %+v", c.Entity)
	}

	runner.Emit(ctx, created)
	runner.AuditFeedback(ctx)
	if len(api.candidates) != len(created) || len(created) == 0 {
		t.Fatalf("emitted %d of %d", len(api.candidates), len(created))
	}
	for _, c := range api.candidates {
		if c.IdempotencyKey == "" || c.PrimaryEntityKey == "" || c.Score < 0 || c.Score > 100 || c.RiskScore > 100 ||
			c.Explanation == nil || c.Explanation.Narrative == "" || len(c.Explanation.EvidenceObservationIDs) == 0 {
			t.Errorf("candidate request: %+v", c)
		}
	}
	// Re-emitting the same candidates is a no-op (status emitted).
	runner.Emit(ctx, created)
	if len(api.candidates) != len(created) {
		t.Fatal("re-emission")
	}
	// Feedback: allowlist (active) for 101501, review for the P1 rule, nothing for 5712.
	if _, ok := api.audits["risk.suppression.applied|"+findProposal(runner, "allowlist", "101501")]; !ok {
		t.Errorf("suppression audit missing: %v", keysOf(api.audits))
	}
	if _, ok := api.audits["risk.feedback.proposed|"+findProposal(runner, "review", "100502")]; !ok {
		t.Errorf("review audit missing: %v", keysOf(api.audits))
	}
	for k := range api.audits {
		if strings.Contains(k, "suppression") && strings.Contains(api.audits[k].RuleID, "100502") {
			t.Error("P1 rule suppressed")
		}
	}
	audits := len(api.audits)
	runner.AuditFeedback(ctx)
	if len(api.audits) != audits {
		t.Error("audit must be idempotent")
	}

	rep := runner.BuildReport(now.Add(-48*time.Hour), now, 5, true)
	red := rep.Reduction["qapaqAlerts"].(risk.DedupResult)
	if red.Alerts != 22 || red.Groups != 5 || red.Reduction != 4.4 {
		t.Errorf("qapaq reduction: %+v", red)
	}
	w := rep.Reduction["wazuhAlerts"].(map[string]any)
	if w["reductionFactor"].(float64) < 2 {
		t.Errorf("wazuh reduction: %+v", w)
	}
	if len(rep.TopEntities) == 0 || strings.Contains(rep.TopEntities[0].Value, "victima") {
		t.Errorf("top entities (redacted): %+v", rep.TopEntities)
	}
	coverage, coverageIsPointer := rep.Feedback["reviewCoverage"].(*float64)
	if !coverageIsPointer || coverage != nil || rep.Feedback["reviewCoverageStatus"] != feedback.ReviewCoverageNoData {
		t.Errorf("report must mark the absent correlator-alert denominator as NO_DATA: %+v", rep.Feedback)
	}

	// HTTP read model: auth, top entities, detail by key, candidates, metrics.
	srv := httptest.NewServer((&server.Server{Runner: runner, ReadToken: func() string { return readToken }, Now: func() time.Time { return now }, Version: "test"}).Handler())
	defer srv.Close()
	get := func(path, token string) (int, map[string]any) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	if code, body := get("/readyz", ""); code != 200 || body["ready"] != true || body["feedbackStatus"] != "ready" || body["lastFeedbackSuccess"] != now.Format(time.RFC3339Nano) {
		t.Fatalf("readyz must include a fresh successful feedback cycle: %d %v", code, body)
	}
	if code, _ := get("/v1/entities?top=5", ""); code != 401 {
		t.Fatalf("unauthenticated /v1: %d", code)
	}
	if code, _ := get("/v1/entities?top=5", "wrong-token-of-the-same-length-000000"); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	code, body := get("/v1/entities?top=5", readToken)
	if code != 200 || len(body["items"].([]any)) == 0 {
		t.Fatalf("entities: %d %v", code, body)
	}
	code, body = get("/v1/entity?key=user:victima@qapaq.pe", readToken)
	if code != 200 || len(body["candidates"].([]any)) == 0 {
		t.Fatalf("entity detail: %d", code)
	}
	if code, _ = get("/v1/candidates?status=emitted&limit=10", readToken); code != 200 {
		t.Fatalf("candidates: %d", code)
	}
	code, body = get("/v1/feedback", readToken)
	if code != 200 || body["reviewCoverage"] != nil || body["reviewCoverageStatus"] != feedback.ReviewCoverageNoData {
		t.Fatalf("feedback review coverage: %d %v", code, body)
	}
	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	m, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, want := range []string{
		"qapaq_correlator_observations_total{source=\"aws\"}",
		"qapaq_correlator_candidates_emitted_total",
		"qapaq_correlator_reduction_factor{stream=\"qapaq\"}",
		"# HELP qapaq_correlator_feedback_alerts Correlator alert counts by feedback category in the feedback window; false_positive groups false_positive and benign verdicts",
		"qapaq_correlator_feedback_alerts{verdict=\"false_positive\"}",
		"qapaq_correlator_feedback_ready 1",
		"qapaq_correlator_feedback_status{status=\"ready\"} 1",
		"qapaq_correlator_feedback_age_seconds 0",
		"qapaq_correlator_feedback_last_success_timestamp_seconds",
		"qapaq_correlator_feedback_refresh_errors_total 0",
		"qapaq_correlator_review_coverage_status{status=\"NO_DATA\"}",
		"qapaq_correlator_feedback_alert_feed_truncated",
	} {
		if !strings.Contains(string(m), want) {
			t.Errorf("metrics missing %s", want)
		}
	}
	if strings.Contains(string(m), "victima") || strings.Contains(string(m), "203.0.113") {
		t.Error("metrics must not carry entity values")
	}

	api.mu.Lock()
	api.alerts, err = json.Marshal(map[string]any{"items": []model.QapaqAlert{{
		ID: "correlator-duplicate", RuleID: model.CorrelatorRulePrefix + "test",
		Verdict: "duplicate", OccurredAt: now.Add(-time.Hour),
	}}})
	api.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.RefreshFeedback(ctx); err != nil {
		t.Fatal(err)
	}
	resp, err = srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	m, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	const reviewCoverageHelp = "# HELP qapaq_correlator_review_coverage Fraction of correlator candidates materialized as QAPAQ alerts in the effective feedback occurrence-time window adjudicated as true_positive, false_positive, benign, or duplicate; absent when unavailable"
	for _, want := range []string{
		reviewCoverageHelp,
		"qapaq_correlator_review_coverage 1",
		"qapaq_correlator_review_coverage_status{status=\"AVAILABLE\"} 1",
	} {
		if !strings.Contains(string(m), want) {
			t.Errorf("available review coverage metric missing %q", want)
		}
	}

	api.mu.Lock()
	api.alertsStatus = http.StatusServiceUnavailable
	api.mu.Unlock()
	if err := runner.RefreshFeedback(ctx); err == nil {
		t.Fatal("expected feedback refresh to fail after the API returned 503")
	}
	if code, body := get("/readyz", ""); code != http.StatusServiceUnavailable || body["ready"] != false || body["reason"] != "feedback_refresh_failed" || body["feedbackStatus"] != "failed" {
		t.Fatalf("readyz must degrade on feedback failure while exposing feedback status: %d %v", code, body)
	}
	resp, err = srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	m, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, want := range []string{
		"qapaq_correlator_ready 0",
		"qapaq_correlator_feedback_ready 0",
		"qapaq_correlator_feedback_status{status=\"failed\"} 1",
		"qapaq_correlator_feedback_age_seconds 0",
		"qapaq_correlator_feedback_refresh_errors_total 1",
	} {
		if !strings.Contains(string(m), want) {
			t.Errorf("failed feedback metrics missing %s", want)
		}
	}
}

func findProposal(r *engine.Runner, kind, rule string) string {
	for _, p := range r.Snapshot().Feedback.Proposals {
		if p.Kind == kind && p.RuleID == rule {
			return p.ID
		}
	}
	return "missing"
}

func keysOf(m map[string]sources.AuditRequest) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
