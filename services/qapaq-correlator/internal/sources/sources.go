// Package sources holds the two read paths of the correlator and its one write path:
//
//   - WazuhGateway: the existing C-28 static-token gateway (POST /wazuh/_search), read-only
//     over wazuh-alerts-* with the qapaq_reader role. No new indexer credential is created.
//   - QAPAQAPI: internal endpoints of the QAPAQ API (/internal/correlator/*) authenticated with a
//     service token. The API owns PostgreSQL: the correlator never connects to the database.
package sources

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// ErrStatus wraps an unexpected HTTP status.
type ErrStatus struct {
	Op     string
	Status int
}

func (e ErrStatus) Error() string { return fmt.Sprintf("%s: HTTP %d", e.Op, e.Status) }

// NewHTTPClient builds a client that trusts caFile (when set) in addition to nothing else.
func NewHTTPClient(caFile string, timeout time.Duration) (*http.Client, error) {
	tr := &http.Transport{
		MaxIdleConns: 4, IdleConnTimeout: 60 * time.Second,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file has no certificates")
		}
		tr.TLSClientConfig.RootCAs = pool
	}
	return &http.Client{Transport: tr, Timeout: timeout}, nil
}

// ---------------------------------------------------------------------------------------------
// Wazuh gateway

// WazuhGateway reads wazuh-alerts-* through the static-token gateway.
type WazuhGateway struct {
	BaseURL  string
	Token    func() string
	Client   *http.Client
	MinLevel int
	PageSize int
}

// Cursor is an opaque search_after position (the sort values of the last hit, verbatim).
type Cursor struct {
	Sort []json.RawMessage
}

// ErrIncompleteSearch prevents a partial or malformed HTTP 200 response from being
// mistaken for the end of a window. Reasons contain no event or credential data.
type ErrIncompleteSearch struct {
	Reason string
}

func (e ErrIncompleteSearch) Error() string { return "gateway search incomplete: " + e.Reason }

// sortPosition follows the explicit timestamp/id sort requested below. Dates without
// a custom sort format are returned as epoch milliseconds; ids are keyword strings.
type sortPosition struct {
	timestamp int64
	id        string
}

func position(sort []json.RawMessage) (sortPosition, bool) {
	var p sortPosition
	if len(sort) != 2 || string(sort[0]) == "null" || string(sort[1]) == "null" {
		return p, false
	}
	if json.Unmarshal(sort[0], &p.timestamp) != nil || json.Unmarshal(sort[1], &p.id) != nil || p.id == "" {
		return p, false
	}
	return p, true
}

func (p sortPosition) after(previous sortPosition) bool {
	return p.timestamp > previous.timestamp || (p.timestamp == previous.timestamp && p.id > previous.id)
}

// sourceFields limits the payload to what entity resolution and classification read.
var sourceFields = []string{"timestamp", "id", "rule", "agent", "data", "predecoder.hostname", "decoder.name", "location"}

// Page fetches alerts with timestamp in [from, to) after the cursor, ascending.
func (g *WazuhGateway) Page(ctx context.Context, from, to time.Time, after *Cursor) ([]map[string]any, *Cursor, error) {
	var previous sortPosition
	hasPrevious := after != nil
	if after != nil {
		var valid bool
		previous, valid = position(after.Sort)
		if !valid {
			return nil, nil, ErrIncompleteSearch{Reason: "invalid_request_cursor"}
		}
	}
	size := g.PageSize
	if size <= 0 {
		size = 500
	}
	query := map[string]any{
		"size":    size,
		"_source": sourceFields,
		"sort":    []any{map[string]any{"timestamp": "asc"}, map[string]any{"id": "asc"}},
		"query": map[string]any{"bool": map[string]any{"filter": []any{
			map[string]any{"range": map[string]any{"timestamp": map[string]any{
				"gte": from.UTC().Format(time.RFC3339Nano), "lt": to.UTC().Format(time.RFC3339Nano),
			}}},
			map[string]any{"range": map[string]any{"rule.level": map[string]any{"gte": g.MinLevel}}},
		}}},
		"track_total_hits": false,
	}
	if after != nil {
		query["search_after"] = after.Sort
	}
	body, _ := json.Marshal(query)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(g.BaseURL, "/")+"/wazuh/_search", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token())
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.Client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("gateway search: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, nil, ErrStatus{Op: "gateway search", Status: resp.StatusCode}
	}
	var parsed struct {
		TimedOut        bool `json:"timed_out"`
		TerminatedEarly bool `json:"terminated_early"`
		Shards          struct {
			Failed int `json:"failed"`
		} `json:"_shards"`
		Hits *struct {
			Hits []struct {
				Source map[string]any    `json:"_source"`
				Sort   []json.RawMessage `json:"sort"`
			} `json:"hits"`
		} `json:"hits"`
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 256<<20))
	if err := dec.Decode(&parsed); err != nil {
		return nil, nil, fmt.Errorf("gateway search decode: %w", err)
	}
	if parsed.TimedOut {
		return nil, nil, ErrIncompleteSearch{Reason: "timed_out"}
	}
	if parsed.TerminatedEarly {
		return nil, nil, ErrIncompleteSearch{Reason: "terminated_early"}
	}
	if parsed.Shards.Failed > 0 {
		return nil, nil, ErrIncompleteSearch{Reason: "failed_shards"}
	}
	if parsed.Hits == nil || parsed.Hits.Hits == nil || len(parsed.Hits.Hits) > size {
		return nil, nil, ErrIncompleteSearch{Reason: "invalid_hits"}
	}
	docs := make([]map[string]any, 0, len(parsed.Hits.Hits))
	var next *Cursor
	for _, h := range parsed.Hits.Hits {
		if len(h.Source) == 0 {
			return nil, nil, ErrIncompleteSearch{Reason: "missing_source"}
		}
		current, valid := position(h.Sort)
		if !valid {
			return nil, nil, ErrIncompleteSearch{Reason: "invalid_hit_cursor"}
		}
		if hasPrevious && !current.after(previous) {
			return nil, nil, ErrIncompleteSearch{Reason: "non_advancing_cursor"}
		}
		previous, hasPrevious = current, true
		docs = append(docs, h.Source)
		next = &Cursor{Sort: h.Sort}
	}
	if len(docs) < size {
		next = nil
	}
	return docs, next, nil
}

// Health checks the gateway (and through it the indexer).
func (g *WazuhGateway) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(g.BaseURL, "/")+"/wazuh/_cluster/health", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token())
	resp, err := g.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return ErrStatus{Op: "gateway health", Status: resp.StatusCode}
	}
	return nil
}

// ---------------------------------------------------------------------------------------------
// QAPAQ API (internal correlator endpoints)

// QAPAQAPI calls the API's internal service endpoints.
type QAPAQAPI struct {
	BaseURL string
	Token   func() string
	Client  *http.Client
}

func (a *QAPAQAPI) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.BaseURL, "/")+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.Token())
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.Client.Do(req)
	if err != nil {
		return fmt.Errorf("qapaq api %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return ErrStatus{Op: "qapaq api " + strings.SplitN(path, "?", 2)[0], Status: resp.StatusCode}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(out)
}

// Alerts returns the QAPAQ alert feed (with verdicts) since t.
func (a *QAPAQAPI) Alerts(ctx context.Context, since time.Time) ([]model.QapaqAlert, bool, error) {
	var out struct {
		Items     []model.QapaqAlert `json:"items"`
		Truncated bool             `json:"truncated"`
	}
	err := a.do(ctx, http.MethodGet, "/internal/correlator/alerts?since="+url.QueryEscape(since.UTC().Format(time.RFC3339)), nil, &out)
	return out.Items, out.Truncated, err
}

// CandidateRequest is the body of POST /internal/correlator/candidates.
type CandidateRequest struct {
	IdempotencyKey   string              `json:"idempotencyKey"`
	PatternID        string              `json:"patternId"`
	Kind             string              `json:"kind"`
	Title            string              `json:"title"`
	Summary          string              `json:"summary"`
	Priority         string              `json:"priority"`
	Score            int                 `json:"score"`
	RiskScore        float64             `json:"riskScore"`
	Signal           string              `json:"signal"`
	PrimaryEntityKey string              `json:"primaryEntityKey"`
	EntityKeys       []string            `json:"entityKeys"`
	RelatedAlertIDs  []string            `json:"relatedAlertIds"`
	OccurredAt       time.Time           `json:"occurredAt"`
	FirstSeen        time.Time           `json:"firstSeen"`
	MemberCount      int                 `json:"memberCount"`
	Stages           []model.StageHit    `json:"stages"`
	Sources          []string            `json:"sources"`
	Tactics          []string            `json:"tactics"`
	Explanation      *ExplanationRequest `json:"explanation,omitempty"`
}

// ExplanationRequest is the bounded explanation sent with a candidate.
type ExplanationRequest struct {
	Narrative              string           `json:"narrative"`
	Stages                 []model.StageHit `json:"stages"`
	EvidenceObservationIDs []string         `json:"evidenceObservationIds"`
	NextSteps              []string         `json:"nextSteps"`
}

// CandidateResponse is the API's answer.
type CandidateResponse struct {
	AlertID string `json:"alertId"`
	Created bool   `json:"created"`
}

// CreateCandidate materializes a candidate as a QAPAQ alert through the API's ingestion path.
func (a *QAPAQAPI) CreateCandidate(ctx context.Context, req CandidateRequest) (CandidateResponse, error) {
	var out CandidateResponse
	err := a.do(ctx, http.MethodPost, "/internal/correlator/candidates", req, &out)
	return out, err
}

// AuditRequest is the body of POST /internal/correlator/audit.
type AuditRequest struct {
	Action     string         `json:"action"`
	ResourceID string         `json:"resourceId"`
	Outcome    string         `json:"outcome"`
	Reason     string         `json:"reason,omitempty"`
	RuleID     string         `json:"ruleId,omitempty"`
	EntityKey  string         `json:"entityKey,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// Audit records (idempotently, by action+resourceId) a correlator decision in the QAPAQ chain.
func (a *QAPAQAPI) Audit(ctx context.Context, req AuditRequest) (bool, error) {
	var out struct {
		Recorded bool `json:"recorded"`
	}
	err := a.do(ctx, http.MethodPost, "/internal/correlator/audit", req, &out)
	return out.Recorded, err
}
