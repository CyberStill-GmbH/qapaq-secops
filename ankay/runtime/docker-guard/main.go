// docker-guard es el único proceso de Ankay con acceso al socket del daemon Docker.
// Orborus y los workers dinámicos de Shuffle hablan con él por DOCKER_HOST=tcp://…;
// el guard reenvía solo las operaciones de la lista cerrada de policy.go, fuerza
// no-new-privileges y etiqueta los contenedores que crea para no tocar ningún otro.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type guard struct {
	policy  Policy
	proxy   *httputil.ReverseProxy
	backend *http.Client
}

func newGuard(policy Policy, socket string) *guard {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns:    16,
		IdleConnTimeout: 30 * time.Second,
	}
	target := &url.URL{Scheme: "http", Host: "docker"}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = "docker"
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("docker-guard: daemon request failed: %v", err)
			writeError(w, http.StatusBadGateway, "Docker daemon unavailable through Ankay docker-guard")
		},
	}
	return &guard{policy: policy, proxy: proxy, backend: &http.Client{Transport: transport, Timeout: 15 * time.Second}}
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}

func (g *guard) facts(ctx context.Context, ref string) (ContainerFacts, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+url.PathEscape(ref)+"/json", nil)
	if err != nil {
		return ContainerFacts{}, err
	}
	resp, err := g.backend.Do(req)
	if err != nil {
		return ContainerFacts{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ContainerFacts{}, fmt.Errorf("inspect returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return ContainerFacts{}, err
	}
	return ContainerFacts{Labels: payload.Config.Labels}, nil
}

func (g *guard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/_guard/health" {
		g.health(w, r)
		return
	}
	if r.Header.Get("Upgrade") != "" || strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		g.reject(w, r, errors.New("connection upgrades (attach/exec) are not allowed"))
		return
	}
	route, err := Classify(r.Method, r.URL.EscapedPath())
	if err != nil {
		g.reject(w, r, err)
		return
	}

	switch route.Kind {
	case "container-op":
		facts, err := g.facts(r.Context(), route.Target)
		if err != nil || !ManagedByGuard(facts) {
			g.reject(w, r, deny("container is not managed by the Ankay docker-guard"))
			return
		}
	case "container-read":
		facts, err := g.facts(r.Context(), route.Target)
		if err != nil || !(ManagedByGuard(facts) || g.policy.MayLendNetns(facts)) {
			g.reject(w, r, deny("container is outside the Ankay execution scope"))
			return
		}
	case "container-create":
		if name := r.URL.Query().Get("name"); name != "" && !safeName.MatchString(name) {
			g.reject(w, r, deny("invalid container name"))
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxCreateBody+1))
		if err != nil {
			g.reject(w, r, deny("could not read container create body"))
			return
		}
		reviewed, err := g.policy.ReviewCreate(body, func(ref string) (ContainerFacts, error) {
			return g.facts(r.Context(), ref)
		})
		if err != nil {
			g.reject(w, r, err)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(reviewed))
		r.ContentLength = int64(len(reviewed))
		r.Header.Set("Content-Length", strconv.Itoa(len(reviewed)))
		r.Header.Set("Content-Type", "application/json")
	}
	log.Printf("docker-guard: allow %s %s (%s)", r.Method, r.URL.Path, route.Kind)
	g.proxy.ServeHTTP(w, r)
}

func (g *guard) reject(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("docker-guard: deny %s %s: %v", r.Method, r.URL.Path, err)
	writeError(w, http.StatusForbidden, err.Error())
}

func (g *guard) health(w http.ResponseWriter, r *http.Request) {
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://docker/_ping", nil)
	resp, err := g.backend.Do(req)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "docker daemon unreachable")
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusServiceUnavailable, "docker daemon unhealthy")
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, "OK")
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func healthcheck(listen string) int {
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/_guard/health")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	check := flag.Bool("healthcheck", false, "probe the local guard health endpoint and exit")
	flag.Parse()
	listen := env("DOCKER_GUARD_LISTEN", ":2375")
	if *check {
		os.Exit(healthcheck(listen))
	}

	images, err := ParseAllowedImages(os.Getenv("DOCKER_GUARD_ALLOWED_IMAGES"))
	if err != nil {
		log.Fatalf("docker-guard: %v", err)
	}
	pids, err := strconv.ParseInt(env("DOCKER_GUARD_PIDS_LIMIT", "1024"), 10, 64)
	if err != nil || pids < 64 {
		log.Fatal("docker-guard: DOCKER_GUARD_PIDS_LIMIT must be an integer >= 64")
	}
	services := map[string]bool{}
	for _, name := range strings.Split(env("DOCKER_GUARD_NETNS_SERVICES", "orborus"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			services[name] = true
		}
	}
	policy := Policy{
		AllowedImages:  images,
		ComposeProject: env("DOCKER_GUARD_COMPOSE_PROJECT", "ankay"),
		NetnsServices:  services,
		PidsLimit:      pids,
	}
	server := &http.Server{
		Addr:              listen,
		Handler:           newGuard(policy, env("DOCKER_GUARD_SOCKET", "/var/run/docker.sock")),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("docker-guard: listening on %s with %s", listen, policy.describe())
	log.Fatal(server.ListenAndServe())
}
