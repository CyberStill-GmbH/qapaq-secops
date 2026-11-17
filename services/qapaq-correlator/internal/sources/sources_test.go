package sources

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestGatewayRejectsIncompleteSearchWithoutReturningPartialEvidence(t *testing.T) {
	hit := `{"_source":{"id":"a"},"sort":[1000,"a"]}`
	cases := []struct {
		name, response, reason string
	}{
		{"timeout with usable hit", `{"timed_out":true,"hits":{"hits":[` + hit + `]}}`, "timed_out"},
		{"failed shard", `{"_shards":{"total":2,"successful":1,"failed":1},"hits":{"hits":[` + hit + `]}}`, "failed_shards"},
		{"terminated early", `{"terminated_early":true,"hits":{"hits":[` + hit + `]}}`, "terminated_early"},
		{"missing envelope", `{}`, "invalid_hits"},
		{"missing hit array", `{"hits":{}}`, "invalid_hits"},
		{"null hit array", `{"hits":{"hits":null}}`, "invalid_hits"},
		{"missing source", `{"hits":{"hits":[{"sort":[1000,"a"]}]}}`, "missing_source"},
		{"missing cursor on final hit", `{"hits":{"hits":[` + hit + `,{"_source":{"id":"b"}}]}}`, "invalid_hit_cursor"},
		{"null timestamp", `{"hits":{"hits":[{"_source":{"id":"a"},"sort":[null,"a"]}]}}`, "invalid_hit_cursor"},
		{"null id", `{"hits":{"hits":[{"_source":{"id":"a"},"sort":[1000,null]}]}}`, "invalid_hit_cursor"},
		{"empty id", `{"hits":{"hits":[{"_source":{"id":"a"},"sort":[1000,""]}]}}`, "invalid_hit_cursor"},
		{"same timestamp and id", `{"hits":{"hits":[` + hit + `,` + hit + `]}}`, "non_advancing_cursor"},
		{"reversed ids within timestamp", `{"hits":{"hits":[{"_source":{"id":"b"},"sort":[1000,"b"]},` + hit + `]}}`, "non_advancing_cursor"},
		{"older timestamp", `{"hits":{"hits":[` + hit + `,{"_source":{"id":"b"},"sort":[999,"b"]}]}}`, "non_advancing_cursor"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.response))
			}))
			defer srv.Close()
			gw := &WazuhGateway{BaseURL: srv.URL, Client: srv.Client(), Token: func() string { return "fixture-token" }, PageSize: 2}
			docs, next, err := gw.Page(context.Background(), time.Unix(0, 0), time.Unix(3, 0), nil)
			var incomplete ErrIncompleteSearch
			if !errors.As(err, &incomplete) || incomplete.Reason != tc.reason {
				t.Fatalf("got %v, want incomplete reason %q", err, tc.reason)
			}
			if docs != nil || next != nil {
				t.Fatalf("incomplete page must return neither evidence nor continuation: docs=%v next=%v", docs, next)
			}
		})
	}
}

func TestGatewayPaginationKeepsEqualTimestampEvidenceAndExactCursor(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var q struct {
			After []json.RawMessage `json:"search_after"`
		}
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			t.Error(err)
		}
		switch calls {
		case 1:
			if len(q.After) != 0 {
				t.Errorf("initial page unexpectedly has cursor %s", q.After)
			}
			_, _ = w.Write([]byte(`{"timed_out":false,"_shards":{"failed":0},"hits":{"hits":[{"_source":{"id":"a"},"sort":[1000,"a"]},{"_source":{"id":"b"},"sort":[1000,"b"]}]}}`))
		case 2:
			if !reflect.DeepEqual(q.After, []json.RawMessage{json.RawMessage(`1000`), json.RawMessage(`"b"`)}) {
				t.Errorf("exact timestamp/id continuation lost: %s", q.After)
			}
			_, _ = w.Write([]byte(`{"hits":{"hits":[{"_source":{"id":"c"},"sort":[1000,"c"]}]}}`))
		default:
			t.Error("unexpected extra request")
		}
	}))
	defer srv.Close()
	gw := &WazuhGateway{BaseURL: srv.URL, Client: srv.Client(), Token: func() string { return "fixture-token" }, PageSize: 2}
	docs, next, err := gw.Page(context.Background(), time.Unix(0, 0), time.Unix(3, 0), nil)
	if err != nil || len(docs) != 2 || next == nil {
		t.Fatalf("first page: docs=%v next=%v error=%v", docs, next, err)
	}
	docs, next, err = gw.Page(context.Background(), time.Unix(0, 0), time.Unix(3, 0), next)
	if err != nil || len(docs) != 1 || docs[0]["id"] != "c" || next != nil {
		t.Fatalf("last page must retain same-timestamp evidence and finish: docs=%v next=%v error=%v", docs, next, err)
	}
}

func TestGatewayRejectsRepeatedPageAcrossSearchAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"hits":{"hits":[{"_source":{"id":"a"},"sort":[1000,"a"]}]}}`))
	}))
	defer srv.Close()
	gw := &WazuhGateway{BaseURL: srv.URL, Client: srv.Client(), Token: func() string { return "fixture-token" }, PageSize: 1}
	after := &Cursor{Sort: []json.RawMessage{json.RawMessage(`1000`), json.RawMessage(`"a"`)}}
	_, _, err := gw.Page(context.Background(), time.Unix(0, 0), time.Unix(3, 0), after)
	var incomplete ErrIncompleteSearch
	if !errors.As(err, &incomplete) || incomplete.Reason != "non_advancing_cursor" {
		t.Fatalf("replayed cursor must fail rather than loop or complete: %v", err)
	}
}

func TestGatewayAcceptsExplicitEmptyCompletePage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"timed_out":false,"_shards":{"failed":0},"hits":{"hits":[]}}`))
	}))
	defer srv.Close()
	gw := &WazuhGateway{BaseURL: srv.URL, Client: srv.Client(), Token: func() string { return "fixture-token" }}
	docs, next, err := gw.Page(context.Background(), time.Unix(0, 0), time.Unix(3, 0), nil)
	if err != nil || len(docs) != 0 || next != nil {
		t.Fatalf("empty complete window: docs=%v next=%v error=%v", docs, next, err)
	}
}
