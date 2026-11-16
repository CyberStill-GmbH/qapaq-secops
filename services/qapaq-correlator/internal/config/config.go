// Package config loads the correlator configuration from environment variables and secret
// files (mounted read-only from /opt/qapaq/secrets, mode 0600). Secrets are never accepted as
// plain environment values.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the full runtime configuration.
type Config struct {
	Listen           string
	GatewayURL       string
	GatewayTokenFile string
	CAFile           string
	APIURL           string
	ServiceTokenFile string // correlator -> API (/internal/correlator/*)
	ReadTokenFile    string // API -> correlator (/v1/*)
	Backfill         time.Duration
	PollInterval     time.Duration
	FeedbackInterval time.Duration
	Lag              time.Duration
	Overlap          time.Duration
	MinLevel         int
	GroupMinLevel    int
	Threshold        float64
	HalfLife         time.Duration
	Emit             bool
	EmitMaxAge       time.Duration
	EmitLateMaxAge   time.Duration
	EmitMaxPerHour   int
	AutoSuppress     bool
	SuppressionTTL   time.Duration
	FPMin            int
	CriticalityFile  string
	AdminIPsFile     string
	AliasesFile      string
	UserDomain       string
	ProtectedRules   []string
	PageSize         int
	FeedbackLookback time.Duration
}

func env(name, def string) string {
	if v, ok := os.LookupEnv(name); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func duration(name, def string) (time.Duration, error) {
	v := env(name, def)
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("%s: invalid duration", name)
	}
	return d, nil
}

func integer(name string, def, min, max int) (int, error) {
	v := env(name, strconv.Itoa(def))
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s: must be an integer in [%d,%d]", name, min, max)
	}
	return n, nil
}

func boolean(name string, def bool) (bool, error) {
	v := strings.ToLower(env(name, strconv.FormatBool(def)))
	switch v {
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	}
	return false, fmt.Errorf("%s: must be true or false", name)
}

// Load reads the configuration. Unknown QAPAQ_CORRELATOR_* variables are rejected (typos must
// not silently fall back to defaults), mirroring the API's KNOWN_QAPAQ_VARIABLES rule.
func Load() (Config, error) {
	known := map[string]bool{}
	for _, k := range []string{"LISTEN", "GATEWAY_URL", "GATEWAY_TOKEN_FILE", "CA_FILE", "API_URL",
		"SERVICE_TOKEN_FILE", "READ_TOKEN_FILE", "BACKFILL", "POLL_INTERVAL", "FEEDBACK_INTERVAL",
		"LAG", "OVERLAP", "MIN_LEVEL", "GROUP_MIN_LEVEL", "THRESHOLD", "HALF_LIFE", "EMIT",
		"EMIT_MAX_AGE", "EMIT_LATE_MAX_AGE", "EMIT_MAX_PER_HOUR", "AUTO_SUPPRESS", "SUPPRESSION_TTL", "FP_MIN",
		"CRITICALITY_FILE", "ALIASES_FILE", "USER_DOMAIN", "PROTECTED_RULES", "PAGE_SIZE",
		"FEEDBACK_LOOKBACK", "LOG_LEVEL", "ADMIN_IPS_FILE"} {
		known["QAPAQ_CORRELATOR_"+k] = true
	}
	for _, kv := range os.Environ() {
		name := strings.SplitN(kv, "=", 2)[0]
		if strings.HasPrefix(name, "QAPAQ_CORRELATOR_") && !known[name] {
			return Config{}, fmt.Errorf("unknown variable %s", name)
		}
		if strings.HasPrefix(name, "QAPAQ_CORRELATOR_") && strings.HasSuffix(name, "_TOKEN") {
			return Config{}, fmt.Errorf("%s: secrets are only accepted as *_FILE", name)
		}
	}
	c := Config{
		Listen:           env("QAPAQ_CORRELATOR_LISTEN", ":8080"),
		GatewayURL:       env("QAPAQ_CORRELATOR_GATEWAY_URL", "https://wazuh-gateway:8443"),
		GatewayTokenFile: env("QAPAQ_CORRELATOR_GATEWAY_TOKEN_FILE", "/run/secrets/qapaq-correlator/gateway.token"),
		CAFile:           env("QAPAQ_CORRELATOR_CA_FILE", ""),
		APIURL:           env("QAPAQ_CORRELATOR_API_URL", "http://api:3000/api"),
		ServiceTokenFile: env("QAPAQ_CORRELATOR_SERVICE_TOKEN_FILE", "/run/secrets/qapaq-correlator/service.token"),
		ReadTokenFile:    env("QAPAQ_CORRELATOR_READ_TOKEN_FILE", "/run/secrets/qapaq-correlator/read.token"),
		CriticalityFile:  env("QAPAQ_CORRELATOR_CRITICALITY_FILE", ""),
		AliasesFile:      env("QAPAQ_CORRELATOR_ALIASES_FILE", ""),
		AdminIPsFile:     env("QAPAQ_CORRELATOR_ADMIN_IPS_FILE", ""),
		UserDomain:       env("QAPAQ_CORRELATOR_USER_DOMAIN", ""),
	}
	var err error
	errs := []error{}
	set := func(e error) {
		if e != nil {
			errs = append(errs, e)
		}
	}
	c.Backfill, err = duration("QAPAQ_CORRELATOR_BACKFILL", "168h")
	set(err)
	c.PollInterval, err = duration("QAPAQ_CORRELATOR_POLL_INTERVAL", "30s")
	set(err)
	c.FeedbackInterval, err = duration("QAPAQ_CORRELATOR_FEEDBACK_INTERVAL", "60s")
	set(err)
	c.Lag, err = duration("QAPAQ_CORRELATOR_LAG", "30s")
	set(err)
	c.Overlap, err = duration("QAPAQ_CORRELATOR_OVERLAP", "2m")
	set(err)
	c.HalfLife, err = duration("QAPAQ_CORRELATOR_HALF_LIFE", "12h")
	set(err)
	c.EmitMaxAge, err = duration("QAPAQ_CORRELATOR_EMIT_MAX_AGE", "6h")
	set(err)
	c.EmitLateMaxAge, err = duration("QAPAQ_CORRELATOR_EMIT_LATE_MAX_AGE", "72h")
	set(err)
	if c.EmitLateMaxAge != 0 && c.EmitLateMaxAge < c.EmitMaxAge {
		errs = append(errs, fmt.Errorf("QAPAQ_CORRELATOR_EMIT_LATE_MAX_AGE: must be 0 (disabled) or >= QAPAQ_CORRELATOR_EMIT_MAX_AGE"))
	}
	c.SuppressionTTL, err = duration("QAPAQ_CORRELATOR_SUPPRESSION_TTL", "72h")
	set(err)
	c.FeedbackLookback, err = duration("QAPAQ_CORRELATOR_FEEDBACK_LOOKBACK", "696h")
	set(err)
	for _, item := range []struct {
		name  string
		value time.Duration
	}{
		{"QAPAQ_CORRELATOR_BACKFILL", c.Backfill},
		{"QAPAQ_CORRELATOR_POLL_INTERVAL", c.PollInterval},
		{"QAPAQ_CORRELATOR_FEEDBACK_INTERVAL", c.FeedbackInterval},
		{"QAPAQ_CORRELATOR_HALF_LIFE", c.HalfLife},
	} {
		if item.value == 0 {
			errs = append(errs, fmt.Errorf("%s: must be greater than zero", item.name))
		}
	}
	c.MinLevel, err = integer("QAPAQ_CORRELATOR_MIN_LEVEL", 3, 0, 15)
	set(err)
	c.GroupMinLevel, err = integer("QAPAQ_CORRELATOR_GROUP_MIN_LEVEL", 7, 0, 15)
	set(err)
	c.EmitMaxPerHour, err = integer("QAPAQ_CORRELATOR_EMIT_MAX_PER_HOUR", 10, 1, 1000)
	set(err)
	c.FPMin, err = integer("QAPAQ_CORRELATOR_FP_MIN", 3, 2, 100)
	set(err)
	c.PageSize, err = integer("QAPAQ_CORRELATOR_PAGE_SIZE", 500, 10, 5000)
	set(err)
	thr, err := integer("QAPAQ_CORRELATOR_THRESHOLD", 80, 10, 10000)
	set(err)
	c.Threshold = float64(thr)
	c.Emit, err = boolean("QAPAQ_CORRELATOR_EMIT", false)
	set(err)
	c.AutoSuppress, err = boolean("QAPAQ_CORRELATOR_AUTO_SUPPRESS", false)
	set(err)
	for _, r := range strings.Split(env("QAPAQ_CORRELATOR_PROTECTED_RULES", ""), ",") {
		if r = strings.TrimSpace(r); r != "" {
			c.ProtectedRules = append(c.ProtectedRules, r)
		}
	}
	if c.Backfill > 30*24*time.Hour {
		errs = append(errs, errors.New("QAPAQ_CORRELATOR_BACKFILL: at most 720h"))
	}
	// The API rejects feeds older than 30 days; keep a margin for clock skew between calls.
	if c.FeedbackLookback > 29*24*time.Hour {
		errs = append(errs, errors.New("QAPAQ_CORRELATOR_FEEDBACK_LOOKBACK: at most 696h"))
	}
	return c, errors.Join(errs...)
}

// ReadSecret reads a secret file, refusing group/world-readable files.
func ReadSecret(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("secret %s: %w", path, err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("secret %s: mode %o is too open (want 0600 or 0400)", path, info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(raw))
	if len(v) < 32 {
		return "", fmt.Errorf("secret %s: shorter than 32 characters", path)
	}
	return v, nil
}

// ReadList parses a Wazuh CDB-style list (key:value per line; keys with ':' are quoted;
// lines starting with '#' are comments). A missing optional file yields an empty map.
func ReadList(path string) (map[string]string, error) {
	out := map[string]string{}
	if path == "" {
		return out, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var key, value string
		if strings.HasPrefix(line, `"`) {
			end := strings.Index(line[1:], `"`)
			if end < 0 {
				continue
			}
			key = line[1 : end+1]
			value = strings.TrimPrefix(line[end+2:], ":")
		} else {
			i := strings.IndexByte(line, ':')
			if i <= 0 {
				continue
			}
			key, value = line[:i], line[i+1:]
		}
		out[strings.ToLower(strings.TrimSpace(key))] = strings.ToLower(strings.TrimSpace(value))
	}
	return out, sc.Err()
}
