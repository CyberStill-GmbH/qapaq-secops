// Command qapaq-correlator is the QAPAQ SecOps risk correlator: entity resolution across sources,
// per-entity risk with time decay, multi-stage patterns, alert grouping and an analyst
// feedback loop. Subcommands:
//
//	qapaq-correlator [serve]      backfill, poll, serve /v1, /metrics, /healthz, /readyz
//	qapaq-correlator replay       one-shot dry run over QAPAQ_CORRELATOR_BACKFILL (no emission, no
//	                            audit writes); prints a JSON report on stdout
//	qapaq-correlator healthcheck  container healthcheck (distroless has no shell or wget)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/config"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/engine"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/feedback"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/resolve"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/risk"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/server"
	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/sources"
)

const version = "0.2.0"

func main() {
	mode := "serve"
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		mode = os.Args[1]
	}
	switch mode {
	case "healthcheck":
		os.Exit(healthcheck(os.Getenv("QAPAQ_CORRELATOR_LISTEN")))
	case "serve", "replay":
	default:
		fmt.Fprintln(os.Stderr, "usage: qapaq-correlator [serve|replay|healthcheck]")
		os.Exit(2)
	}
	// Replay writes its report on stdout; logs always go to stderr there.
	out := os.Stdout
	if mode == "replay" {
		out = os.Stderr
	}
	logger := slog.New(slog.NewJSONHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo})).
		With("service", "qapaq-correlator", "version", version)
	var err error
	if mode == "replay" {
		err = replay(logger, os.Args[2:])
	} else {
		err = serve(logger)
	}
	if err != nil {
		// Do not log raw error text: transport errors may contain internal URLs.
		logger.Error("application.failed", "errorType", typeName(err), "error", sanitize(err))
		os.Exit(1)
	}
}

// build wires the engine and the runner. dryRun disables emission and audit writes and does
// not require the read token (replay only reads).
func build(cfg config.Config, log *slog.Logger, dryRun bool) (*engine.Runner, string, error) {
	gatewayToken, err := config.ReadSecret(cfg.GatewayTokenFile)
	if err != nil {
		return nil, "", err
	}
	serviceToken, err := config.ReadSecret(cfg.ServiceTokenFile)
	if err != nil {
		return nil, "", err
	}
	readToken := ""
	if !dryRun {
		if readToken, err = config.ReadSecret(cfg.ReadTokenFile); err != nil {
			return nil, "", err
		}
	}
	aliases, err := config.ReadList(cfg.AliasesFile)
	if err != nil {
		return nil, "", err
	}
	criticality, err := config.ReadList(cfg.CriticalityFile)
	if err != nil {
		return nil, "", err
	}
	resolver := resolve.New(aliases, cfg.UserDomain)
	policy := risk.DefaultPolicy()
	policy.HalfLife, policy.Threshold, policy.MinLevel = cfg.HalfLife, cfg.Threshold, cfg.MinLevel
	adminIPs, err := config.ReadList(cfg.AdminIPsFile)
	if err != nil {
		return nil, "", err
	}
	lookup := risk.CriticalityLookup(criticality, adminIPs)
	criticalityOf := func(entity model.Entity) string {
		canonicalKey := resolver.Canonical(entity.Key())
		if canonical, ok := model.ParseKey(canonicalKey); ok {
			if v := lookup(canonical); v != "" {
				return v
			}
		}
		if v := lookup(entity); v != "" {
			return v
		}
		// Any alias of the same machine/person (e.g. the manager container name of the SOC node).
		for _, alias := range resolver.Aliases(canonicalKey) {
			if e, ok := model.ParseKey(alias); ok {
				if v := lookup(e); v != "" {
					return v
				}
			}
		}
		return ""
	}
	eng := risk.NewEngine(policy, risk.DefaultPatterns(), resolver, criticalityOf, cfg.GroupMinLevel)

	fbPolicy := feedback.DefaultPolicy()
	fbPolicy.MinFalsePositives = cfg.FPMin
	fbPolicy.SuppressionTTL = cfg.SuppressionTTL
	fbPolicy.AutoSuppress = cfg.AutoSuppress
	fbPolicy.ProtectedRules = make(map[string]bool, len(cfg.ProtectedRules))
	for _, id := range cfg.ProtectedRules {
		fbPolicy.ProtectedRules[id] = true
	}

	client, err := sources.NewHTTPClient(cfg.CAFile, 30*time.Second)
	if err != nil {
		return nil, "", err
	}
	gateway := &sources.WazuhGateway{BaseURL: cfg.GatewayURL, Token: func() string { return gatewayToken }, Client: client, MinLevel: cfg.MinLevel, PageSize: cfg.PageSize}
	api := &sources.QAPAQAPI{BaseURL: cfg.APIURL, Token: func() string { return serviceToken }, Client: client}
	runner := engine.New(engine.Options{
		Backfill: cfg.Backfill, PollInterval: cfg.PollInterval, FeedbackInterval: cfg.FeedbackInterval,
		Lag: cfg.Lag, Overlap: cfg.Overlap, Emit: cfg.Emit && !dryRun, EmitMaxAge: cfg.EmitMaxAge, EmitLateMaxAge: cfg.EmitLateMaxAge,
		EmitMaxPerHour: cfg.EmitMaxPerHour, Audit: !dryRun, FeedbackLookback: cfg.FeedbackLookback,
		Feedback: fbPolicy,
	}, eng, resolver, gateway, api, log)
	return runner, readToken, nil
}

func serve(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	runner, readToken, err := build(cfg, log, false)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go runner.Run(ctx)
	httpServer := &http.Server{
		Addr: cfg.Listen, Handler: (&server.Server{Runner: runner, ReadToken: func() string { return readToken }, Now: time.Now, Version: version}).Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.ListenAndServe() }()
	log.Info("application.started", "pollIntervalSeconds", cfg.PollInterval.Seconds(), "emitEnabled", cfg.Emit, "autoSuppress", cfg.AutoSuppress, "backfillHours", cfg.Backfill.Hours())
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdown); err != nil {
		return err
	}
	<-serveErr
	return nil
}

func replay(log *slog.Logger, args []string) error {
	fs := flag.NewFlagSet("replay", flag.ContinueOnError)
	redact := fs.Bool("redact", false, "mask user and IP values in the report")
	top := fs.Int("top", 15, "number of top risky entities in the report")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	runner, _, err := build(cfg, log, true)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	start := time.Now()
	if _, err := runner.Backfill(ctx); err != nil {
		return err
	}
	to := runner.Snapshot().LastTo
	report := runner.BuildReport(to.Add(-cfg.Backfill), to, *top, *redact)
	log.Info("replay.completed", "durationMs", time.Since(start).Milliseconds())
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}

func healthcheck(listen string) int {
	if listen == "" {
		listen = ":8080"
	}
	if strings.HasPrefix(listen, ":") {
		listen = "127.0.0.1" + listen
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + listen + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func typeName(err error) string {
	if err == nil {
		return "unknown"
	}
	return fmt.Sprintf("%T", err)
}

// sanitize keeps configuration/validation messages (they name variables, never values) and
// drops URLs from transport errors.
func sanitize(err error) string {
	s := err.Error()
	if i := strings.Index(s, "http"); i >= 0 {
		s = s[:i] + "[url]"
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
