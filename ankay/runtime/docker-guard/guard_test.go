package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const workerImage = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testPolicy() Policy {
	return Policy{
		AllowedImages:  map[string]bool{workerImage: true, "frikky/shuffle:shuffle-tools_1.2.0": true},
		ComposeProject: "ankay",
		NetnsServices:  map[string]bool{"orborus": true},
		PidsLimit:      1024,
	}
}

func orborusFacts(string) (ContainerFacts, error) {
	return ContainerFacts{Labels: map[string]string{"com.docker.compose.project": "ankay", "com.docker.compose.service": "orborus"}}, nil
}

func TestClassifyAllowsOnlyTheExecutionSurface(t *testing.T) {
	allowed := [][2]string{
		{"GET", "/_ping"}, {"HEAD", "/v1.44/_ping"}, {"GET", "/v1.53/version"}, {"GET", "/info"},
		{"GET", "/v1.44/containers/json"}, {"POST", "/v1.44/containers/create"},
		{"POST", "/v1.44/containers/worker-abc/start"}, {"POST", "/containers/abc123/wait"},
		{"DELETE", "/v1.44/containers/abc123"}, {"GET", "/v1.44/containers/abc/logs"},
		{"GET", "/v1.44/images/json"}, {"GET", "/v1.44/images/frikky/shuffle:shuffle-tools_1.2.0/json"},
		{"GET", "/networks"}, {"GET", "/networks/ankay_default"},
	}
	for _, item := range allowed {
		if _, err := Classify(item[0], item[1]); err != nil {
			t.Errorf("%s %s should be allowed: %v", item[0], item[1], err)
		}
	}
	denied := [][2]string{
		{"POST", "/v1.44/images/create"}, {"POST", "/build"}, {"POST", "/v1.44/containers/abc/exec"},
		{"POST", "/exec/abc/start"}, {"POST", "/v1.44/containers/abc/attach"}, {"POST", "/swarm/init"},
		{"POST", "/services/create"}, {"POST", "/networks/create"}, {"POST", "/networks/x/connect"},
		{"POST", "/volumes/create"}, {"POST", "/plugins/pull"}, {"GET", "/containers/../info"},
		{"GET", "/containers/%2e%2e/json"}, {"POST", "/images/x/tag"}, {"GET", "/events"},
		{"POST", "/containers/abc/update"}, {"PUT", "/containers/abc/archive"}, {"GET", "/system/df"},
	}
	for _, item := range denied {
		if _, err := Classify(item[0], item[1]); !errors.Is(err, ErrDenied) {
			t.Errorf("%s %s should be denied", item[0], item[1])
		}
	}
}

func review(t *testing.T, body string) (map[string]any, error) {
	t.Helper()
	out, err := testPolicy().ReviewCreate([]byte(body), orborusFacts)
	if err != nil {
		return nil, err
	}
	var spec map[string]any
	if err := json.Unmarshal(out, &spec); err != nil {
		t.Fatal(err)
	}
	return spec, nil
}

func TestReviewCreateHardensAllowlistedWorker(t *testing.T) {
	spec, err := review(t, `{"Image":"`+workerImage+`","Env":["EXECUTIONID=1"],"HostConfig":{"NetworkMode":"container:abc","AutoRemove":true,"LogConfig":{"Type":"json-file"}}}`)
	if err != nil {
		t.Fatal(err)
	}
	host := spec["HostConfig"].(map[string]any)
	if host["PidsLimit"].(float64) != 1024 {
		t.Fatalf("pids limit not enforced: %v", host["PidsLimit"])
	}
	if opts := host["SecurityOpt"].([]any); len(opts) != 1 || opts[0] != "no-new-privileges:true" {
		t.Fatalf("no-new-privileges not enforced: %v", opts)
	}
	if spec["Labels"].(map[string]any)[GuardLabel] != "true" {
		t.Fatal("guard label missing")
	}
	if host["AutoRemove"] != true {
		t.Fatal("unrelated fields must be preserved")
	}
}

func TestReviewCreateRejectsHostEscapes(t *testing.T) {
	cases := map[string]string{
		"unlisted image":     `{"Image":"alpine:latest"}`,
		"privileged":         `{"Image":"` + workerImage + `","HostConfig":{"Privileged":true}}`,
		"docker socket bind": `{"Image":"` + workerImage + `","HostConfig":{"Binds":["/var/run/docker.sock:/var/run/docker.sock"]}}`,
		"mount":              `{"Image":"` + workerImage + `","HostConfig":{"Mounts":[{"Type":"bind","Source":"/","Target":"/host"}]}}`,
		"cap add":            `{"Image":"` + workerImage + `","HostConfig":{"CapAdd":["SYS_ADMIN"]}}`,
		"host network":       `{"Image":"` + workerImage + `","HostConfig":{"NetworkMode":"host"}}`,
		"host pid":           `{"Image":"` + workerImage + `","HostConfig":{"PidMode":"host"}}`,
		"seccomp unconfined": `{"Image":"` + workerImage + `","HostConfig":{"SecurityOpt":["seccomp=unconfined"]}}`,
		"apparmor":           `{"Image":"` + workerImage + `","HostConfig":{"SecurityOpt":["apparmor=unconfined"]}}`,
		"devices":            `{"Image":"` + workerImage + `","HostConfig":{"Devices":[{"PathOnHost":"/dev/sda"}]}}`,
		"ports":              `{"Image":"` + workerImage + `","HostConfig":{"PortBindings":{"80/tcp":[{"HostPort":"80"}]}}}`,
		"volumes":            `{"Image":"` + workerImage + `","Volumes":{"/data":{}}}`,
		"root user":          `{"Image":"` + workerImage + `","User":"0"}`,
		"spoofed label":      `{"Image":"` + workerImage + `","Labels":{"com.docker.compose.service":"orborus"}}`,
		"extra network":      `{"Image":"` + workerImage + `","NetworkingConfig":{"EndpointsConfig":{"ankay_data":{}}}}`,
		"userns host":        `{"Image":"` + workerImage + `","HostConfig":{"UsernsMode":"host"}}`,
		"not json":           `[]`,
		"trailing data":      `{"Image":"` + workerImage + `"}{}`,
	}
	for name, body := range cases {
		if _, err := review(t, body); !errors.Is(err, ErrDenied) {
			t.Errorf("%s: expected denial, got %v", name, err)
		}
	}
}

func TestReviewCreateAcceptsTheCLIDefaultEndpointOnly(t *testing.T) {
	if _, err := review(t, `{"Image":"`+workerImage+`","HostConfig":{"NetworkMode":"default","SecurityOpt":null,"Binds":null,"PortBindings":{}},"NetworkingConfig":{"EndpointsConfig":{"default":{}}}}`); err != nil {
		t.Fatalf("docker CLI default endpoint must be accepted: %v", err)
	}
	if _, err := review(t, `{"Image":"`+workerImage+`","HostConfig":{"NetworkMode":"default"},"NetworkingConfig":{"EndpointsConfig":{"ankay_data":{}}}}`); !errors.Is(err, ErrDenied) {
		t.Fatal("a different network than the network mode must be denied")
	}
}

func TestReviewCreateRestrictsNetworkNamespaceLenders(t *testing.T) {
	backend := func(string) (ContainerFacts, error) {
		return ContainerFacts{Labels: map[string]string{"com.docker.compose.project": "ankay", "com.docker.compose.service": "backend"}}, nil
	}
	body := []byte(`{"Image":"` + workerImage + `","HostConfig":{"NetworkMode":"container:ankay-backend-1"}}`)
	if _, err := testPolicy().ReviewCreate(body, backend); !errors.Is(err, ErrDenied) {
		t.Fatal("backend must not lend its network namespace")
	}
	guardOwned := func(string) (ContainerFacts, error) {
		return ContainerFacts{Labels: map[string]string{GuardLabel: "true"}}, nil
	}
	if _, err := testPolicy().ReviewCreate(body, guardOwned); err != nil {
		t.Fatalf("worker created by the guard must lend its namespace to apps: %v", err)
	}
}

// fakeDaemon escucha en un socket unix y registra lo que recibe.
type fakeDaemon struct {
	mu       sync.Mutex
	requests []string
	bodies   []string
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	d.mu.Lock()
	d.requests = append(d.requests, r.Method+" "+r.URL.Path)
	d.bodies = append(d.bodies, string(body))
	d.mu.Unlock()
	switch {
	case r.URL.Path == "/_ping":
		_, _ = io.WriteString(w, "OK")
	case strings.HasSuffix(r.URL.Path, "/json") && strings.Contains(r.URL.Path, "/containers/worker-1"):
		_, _ = io.WriteString(w, `{"Config":{"Labels":{"`+GuardLabel+`":"true"}}}`)
	case strings.HasSuffix(r.URL.Path, "/json") && strings.Contains(r.URL.Path, "/containers/ankay-backend-1"):
		_, _ = io.WriteString(w, `{"Config":{"Labels":{"com.docker.compose.project":"ankay","com.docker.compose.service":"backend"}}}`)
	case strings.HasSuffix(r.URL.Path, "/json") && strings.Contains(r.URL.Path, "/containers/ankay-orborus-1"):
		_, _ = io.WriteString(w, `{"Config":{"Labels":{"com.docker.compose.project":"ankay","com.docker.compose.service":"orborus"}}}`)
	case strings.HasSuffix(r.URL.Path, "/containers/create"):
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"Id":"worker-1"}`)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func startGuard(t *testing.T) (*httptest.Server, *fakeDaemon) {
	t.Helper()
	dir, err := os.MkdirTemp("", "dg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "d.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	daemon := &fakeDaemon{}
	daemonServer := &http.Server{Handler: daemon}
	go daemonServer.Serve(listener)
	t.Cleanup(func() { daemonServer.Close() })
	server := httptest.NewServer(newGuard(testPolicy(), socket))
	t.Cleanup(server.Close)
	return server, daemon
}

func TestGuardProxiesReviewedRequestsOnly(t *testing.T) {
	server, daemon := startGuard(t)
	do := func(method, path, body string) int {
		req, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if code := do("GET", "/_guard/health", ""); code != 200 {
		t.Fatalf("health: %d", code)
	}
	if code := do("POST", "/v1.44/containers/create?name=worker-1", `{"Image":"`+workerImage+`","HostConfig":{"NetworkMode":"container:ankay-orborus-1"}}`); code != 201 {
		t.Fatalf("create: %d", code)
	}
	if code := do("POST", "/v1.44/containers/worker-1/start", ""); code != 204 {
		t.Fatalf("start of guard container: %d", code)
	}
	if code := do("POST", "/v1.44/containers/ankay-backend-1/stop", ""); code != 403 {
		t.Fatalf("stopping backend must be denied: %d", code)
	}
	if code := do("GET", "/v1.44/containers/ankay-backend-1/json", ""); code != 403 {
		t.Fatalf("inspecting backend (its env holds secrets) must be denied: %d", code)
	}
	if code := do("POST", "/v1.44/containers/create", `{"Image":"`+workerImage+`","HostConfig":{"Binds":["/:/host"]}}`); code != 403 {
		t.Fatalf("bind create must be denied: %d", code)
	}
	if code := do("POST", "/v1.44/images/create?fromImage=alpine", ""); code != 403 {
		t.Fatalf("pull must be denied: %d", code)
	}

	daemon.mu.Lock()
	defer daemon.mu.Unlock()
	for _, request := range daemon.requests {
		if strings.Contains(request, "ankay-backend-1/stop") || strings.Contains(request, "images/create") {
			t.Fatalf("denied request reached the daemon: %s", request)
		}
	}
	created := ""
	for i, request := range daemon.requests {
		if strings.HasSuffix(request, "/containers/create") {
			created = daemon.bodies[i]
		}
	}
	if !strings.Contains(created, GuardLabel) || !strings.Contains(created, "no-new-privileges:true") {
		t.Fatalf("daemon did not receive the hardened body: %s", created)
	}
}

func TestParseAllowedImages(t *testing.T) {
	images, err := ParseAllowedImages(workerImage + ", frikky/shuffle:http_1.4.0")
	if err != nil || len(images) != 2 {
		t.Fatalf("unexpected: %v %v", images, err)
	}
	if _, err := ParseAllowedImages(""); err == nil {
		t.Fatal("empty allowlist must fail")
	}
	if _, err := ParseAllowedImages("UPPER/case"); err == nil {
		t.Fatal("invalid reference must fail")
	}
}
