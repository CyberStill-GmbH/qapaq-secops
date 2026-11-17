// Package resolve turns raw Wazuh alert documents (as served by the QAPAQ wazuh-gateway) into
// observations with canonical entities, and keeps the alias graph that links identifiers of
// the same host (agent name, private IP, EC2 instance id, Bitdefender endpoint) and of the
// same person (UPN/e-mail, AWS SSO role session, IAM user via configured aliases).
//
// Resolution rules (documented in the tests):
//   - users: lower-cased UPN/e-mail; SSO sessions "assumed-role/<role>/<email>" resolve to the
//     e-mail; IAM users "user/<name>" resolve to the e-mail when the name is one, otherwise to
//     "iam:<account>/<name>" unless an explicit alias maps them; "DOMAIN\name" maps to
//     name@<default domain> when one is configured; local Linux accounts are scoped to their
//     host ("local:<host>/<name>"); attacker-chosen names of failed SSH logins are ignored.
//   - hosts: first DNS label, lower-cased. Identifiers seen together in one alert are merged
//     (union-find). Only private/CGNAT IPs alias a host: a public IP may be NAT shared.
//   - ip: canonical textual form (netip); private IPs that alias a host resolve to the host.
//   - cloud: AWS ARNs (roles, resources), S3 buckets, security groups, Cloudflare zones.
package resolve

import (
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/model"
)

// Doc is a decoded Wazuh alert `_source`.
type Doc = map[string]any

// Resolver is safe for concurrent use.
type Resolver struct {
	mu            sync.Mutex
	parent        map[string]string // union-find over entity keys (hosts and private IPs)
	rank          map[string]int
	userAliases   map[string]string // raw (lower) -> canonical user value
	defaultDomain string
	merges        []Merge
}

// Merge reports that `From` became an alias of `Into` (the engine merges state).
type Merge struct{ From, Into string }

// New builds a resolver. aliases maps raw identifiers (e.g. "iam:061098277310/ci-deploy" or
// "jdoe") to a canonical user value (e.g. "svc-ci@qapaq.pe").
func New(aliases map[string]string, defaultDomain string) *Resolver {
	r := &Resolver{
		parent:        map[string]string{},
		rank:          map[string]int{},
		userAliases:   map[string]string{},
		defaultDomain: strings.ToLower(strings.TrimSpace(defaultDomain)),
	}
	for k, v := range aliases {
		r.userAliases[strings.ToLower(strings.TrimSpace(k))] = strings.ToLower(strings.TrimSpace(v))
	}
	return r
}

// DrainMerges returns and clears alias merges observed since the last call.
func (r *Resolver) DrainMerges() []Merge {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.merges
	r.merges = nil
	return out
}

// typeRank decides which identifier names the merged host: agent/endpoint names beat
// instance ids, which beat IPs.
func typeRank(key string) int {
	switch {
	case strings.HasPrefix(key, "host:i-"):
		return 2
	case strings.HasPrefix(key, "host:"):
		return 3
	case strings.HasPrefix(key, "ip:"):
		return 1
	}
	return 0
}

func (r *Resolver) find(k string) string {
	p, ok := r.parent[k]
	if !ok {
		return k
	}
	if p == k {
		return k
	}
	root := r.find(p)
	r.parent[k] = root
	return root
}

func (r *Resolver) union(a, b string) {
	ra, rb := r.find(a), r.find(b)
	if ra == rb {
		r.parent[a], r.parent[b] = ra, ra
		return
	}
	// The more descriptive identifier becomes the root (stable display name).
	into, from := ra, rb
	if typeRank(rb) > typeRank(ra) || (typeRank(rb) == typeRank(ra) && rb < ra) {
		into, from = rb, ra
	}
	r.parent[from] = into
	if _, ok := r.parent[into]; !ok {
		r.parent[into] = into
	}
	r.merges = append(r.merges, Merge{From: from, Into: into})
}

// Canonical resolves an entity key through the alias graph.
func (r *Resolver) Canonical(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.find(key)
}

// Aliases lists every key that resolves to canonical (including itself).
func (r *Resolver) Aliases(canonical string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for k := range r.parent {
		if r.find(k) == canonical && k != canonical {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------------------------
// Field access helpers

func get(doc Doc, path string) any {
	var cur any = doc
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		// Wazuh flattens some keys with dots (e.g. "data.aws.source_ip" can be nested or not).
		cur, ok = m[part]
		if !ok {
			return nil
		}
	}
	return cur
}

func str(doc Doc, path string) string {
	switch v := get(doc, path).(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

func strs(doc Doc, path string) []string {
	switch v := get(doc, path).(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if v != "" {
			return []string{v}
		}
	}
	return nil
}

func truthy(doc Doc, path string) bool {
	switch v := get(doc, path).(type) {
	case bool:
		return v
	case string:
		l := strings.ToLower(v)
		return l == "true" || l == "yes" || l == "1"
	case float64:
		return v != 0
	}
	return false
}

// ---------------------------------------------------------------------------------------------
// Normalizers

var (
	emailRe       = regexp.MustCompile(`^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$`)
	instanceRe    = regexp.MustCompile(`\bi-[0-9a-f]{8,17}\b`)
	ec2HostRe     = regexp.MustCompile(`^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$`)
	junkUsers     = map[string]bool{"": true, "-": true, "n/a": true, "unknown": true, "system": true, "local service": true, "network service": true, "anonymous logon": true, "(unknown user)": true}
	cgnat         = netip.MustParsePrefix("100.64.0.0/10")
	privilegedAWS = map[string]bool{
		"AttachUserPolicy": true, "AttachRolePolicy": true, "AttachGroupPolicy": true,
		"PutUserPolicy": true, "PutRolePolicy": true, "PutGroupPolicy": true,
		"CreateAccessKey": true, "CreateUser": true, "CreateLoginProfile": true,
		"UpdateLoginProfile": true, "AddUserToGroup": true, "UpdateAssumeRolePolicy": true,
		"CreatePolicyVersion": true, "SetDefaultPolicyVersion": true, "CreateRole": true,
		"DeactivateMFADevice": true, "DeleteRolePermissionsBoundary": true,
		"DeleteUserPermissionsBoundary": true, "PassRole": true, "AssumeRoot": true,
	}
	tamperAWS = map[string]bool{
		"StopLogging": true, "DeleteTrail": true, "UpdateTrail": true, "PutEventSelectors": true,
		"DeleteDetector": true, "DisableSecurityHub": true, "DeleteFlowLogs": true,
		"DeleteConfigurationRecorder": true, "StopConfigurationRecorder": true,
	}
)

// NormalizeIP returns the canonical form of an IP, or "" when it is not one.
func NormalizeIP(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	addr, err := netip.ParseAddr(strings.Trim(raw, "[]"))
	if err != nil {
		return ""
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() || addr.IsLoopback() {
		return ""
	}
	return addr.String()
}

// IsInternalIP reports private, link-local or CGNAT addresses (eligible as host aliases).
func IsInternalIP(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	return addr.IsPrivate() || addr.IsLinkLocalUnicast() || cgnat.Contains(addr)
}

// NormalizeHost returns the first DNS label of a host name, lower-cased.
func NormalizeHost(raw string) string {
	h := strings.ToLower(strings.TrimSpace(raw))
	if h == "" || h == "-" || h == "localhost" {
		return ""
	}
	if NormalizeIP(h) != "" {
		return ""
	}
	if m := instanceRe.FindString(h); m != "" && m == h {
		return m
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	if strings.ContainsAny(h, " /\\") {
		return ""
	}
	return h
}

// NormalizeUser resolves a raw principal to a canonical user value, or "".
func (r *Resolver) NormalizeUser(raw string) string {
	u := strings.ToLower(strings.TrimSpace(raw))
	if junkUsers[u] || strings.HasSuffix(u, "$") {
		return ""
	}
	if alias, ok := r.userAliases[u]; ok {
		return alias
	}
	if strings.HasPrefix(u, "arn:aws:") {
		return r.userFromARN(u)
	}
	if i := strings.IndexByte(u, '\\'); i > 0 && i < len(u)-1 {
		name := u[i+1:]
		if alias, ok := r.userAliases[name]; ok {
			return alias
		}
		if r.defaultDomain != "" {
			return name + "@" + r.defaultDomain
		}
		return name
	}
	if emailRe.MatchString(u) {
		return u
	}
	if strings.ContainsAny(u, " \t") || len(u) > 128 {
		return ""
	}
	return u
}

func (r *Resolver) userFromARN(arn string) string {
	parts := strings.SplitN(arn, ":", 6)
	if len(parts) < 6 {
		return ""
	}
	account, resource := parts[4], parts[5]
	switch {
	case resource == "root":
		return "aws-root:" + account
	case strings.HasPrefix(resource, "assumed-role/"):
		seg := strings.Split(resource, "/")
		if len(seg) >= 3 {
			session := seg[len(seg)-1]
			if emailRe.MatchString(session) {
				return session
			}
			key := "iam:" + account + "/" + seg[1] + "/" + session
			if alias, ok := r.userAliases[key]; ok {
				return alias
			}
			return key
		}
	case strings.HasPrefix(resource, "user/"):
		name := resource[strings.LastIndexByte(resource, '/')+1:]
		if emailRe.MatchString(name) {
			return name
		}
		key := "iam:" + account + "/" + name
		if alias, ok := r.userAliases[key]; ok {
			return alias
		}
		if alias, ok := r.userAliases[name]; ok {
			return alias
		}
		return key
	}
	return ""
}

// roleFromARN extracts the IAM role ARN of an assumed-role session as a cloud resource.
func roleFromARN(arn string) string {
	arn = strings.ToLower(arn)
	parts := strings.SplitN(arn, ":", 6)
	if len(parts) < 6 || !strings.HasPrefix(parts[5], "assumed-role/") {
		return ""
	}
	seg := strings.Split(parts[5], "/")
	if len(seg) < 2 {
		return ""
	}
	return "arn:aws:iam::" + parts[4] + ":role/" + seg[1]
}

// ---------------------------------------------------------------------------------------------
// Observation building

var tacticOrder = []string{
	"reconnaissance", "resource-development", "initial-access", "execution", "persistence",
	"privilege-escalation", "defense-evasion", "credential-access", "discovery",
	"lateral-movement", "collection", "command-and-control", "exfiltration", "impact",
}

// TacticIndex returns the kill-chain position of a normalized tactic, or -1.
func TacticIndex(t string) int {
	for i, v := range tacticOrder {
		if v == t {
			return i
		}
	}
	return -1
}

func normalizeTactic(t string) string {
	t = strings.ToLower(strings.TrimSpace(t))
	t = strings.ReplaceAll(t, " ", "-")
	t = strings.ReplaceAll(t, "_", "-")
	if t == "command-and-control" || TacticIndex(t) >= 0 {
		return t
	}
	return ""
}

func hasAny(set map[string]bool, values ...string) bool {
	for _, v := range values {
		if set[v] {
			return true
		}
	}
	return false
}

// SourceOf names the telemetry source of a document (vendor, then rule groups, then decoder).
func SourceOf(doc Doc, groups map[string]bool) string {
	if v := strings.ToLower(str(doc, "data.qapaq.vendor")); v != "" {
		return v
	}
	switch {
	case groups["office365"]:
		return "m365"
	case groups["amazon"] || groups["aws"] || str(doc, "data.aws.eventSource") != "":
		return "aws"
	case groups["cloudflare"]:
		return "cloudflare"
	case groups["bitdefender"]:
		return "bitdefender"
	case groups["sshd"]:
		return "linux-ssh"
	case groups["windows"] || str(doc, "data.win.system.eventID") != "":
		return "windows"
	case groups["web"] || groups["accesslog"] || groups["nginx"]:
		return "web"
	case groups["syscheck"]:
		return "fim"
	}
	if d := strings.ToLower(str(doc, "decoder.name")); d != "" {
		return d
	}
	return "wazuh"
}

// Observe converts one Wazuh alert into an observation. ok is false when the document has
// no usable timestamp or rule.
func (r *Resolver) Observe(doc Doc) (model.Observation, bool) {
	ts := str(doc, "timestamp")
	if ts == "" {
		ts = str(doc, "@timestamp")
	}
	at, err := parseTime(ts)
	if err != nil {
		return model.Observation{}, false
	}
	ruleID := str(doc, "rule.id")
	if ruleID == "" {
		return model.Observation{}, false
	}
	level := 0
	if lv, ok := get(doc, "rule.level").(float64); ok {
		level = int(lv)
	}
	groupList := strs(doc, "rule.groups")
	groups := map[string]bool{}
	for _, g := range groupList {
		groups[strings.ToLower(g)] = true
	}
	tactics := []string{}
	seenTactic := map[string]bool{}
	for _, t := range strs(doc, "rule.mitre.tactic") {
		if n := normalizeTactic(t); n != "" && !seenTactic[n] {
			seenTactic[n] = true
			tactics = append(tactics, n)
		}
	}
	obs := model.Observation{
		ID:          str(doc, "id"),
		Time:        at,
		RuleID:      ruleID,
		Level:       level,
		Description: str(doc, "rule.description"),
		Groups:      groupList,
		Tactics:     tactics,
		Source:      SourceOf(doc, groups),
	}
	if obs.ID == "" {
		obs.ID = ruleID + "@" + at.UTC().Format(time.RFC3339Nano)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	ents := map[string]model.Entity{}
	add := func(e model.Entity) {
		if e.Value == "" {
			return
		}
		ents[e.Key()] = e
	}

	// --- hosts: every identifier of the reporting/affected machine, merged together.
	hostIDs := []string{}
	addHost := func(raw string) {
		if h := NormalizeHost(raw); h != "" {
			hostIDs = append(hostIDs, "host:"+h)
			if m := ec2HostRe.FindStringSubmatch(h); m != nil {
				hostIDs = append(hostIDs, "ip:"+m[1]+"."+m[2]+"."+m[3]+"."+m[4])
			}
		}
	}
	addHostIP := func(raw string) {
		if ip := NormalizeIP(raw); ip != "" && IsInternalIP(ip) {
			hostIDs = append(hostIDs, "ip:"+ip)
		}
	}
	agentID := str(doc, "agent.id")
	agentName := str(doc, "agent.name")
	vendor := obs.Source
	isProvider := vendor == "cloudflare" || vendor == "aws" || vendor == "m365" || vendor == "snyk" || vendor == "bitdefender"
	// The manager (agent 000) is only the collector for provider events: it is not the
	// affected host there, so it is not attached to them.
	if agentName != "" && !(isProvider && (agentID == "000" || agentID == "")) {
		addHost(agentName)
		addHostIP(str(doc, "agent.ip"))
	}
	if h := str(doc, "predecoder.hostname"); h != "" && !isProvider {
		addHost(h)
	}
	if bd := str(doc, "data.bitdefender.endpoint.name"); bd != "" {
		// A Bitdefender endpoint is its own host group (name, FQDN, IP).
		group := []string{}
		if h := NormalizeHost(bd); h != "" {
			group = append(group, "host:"+h)
		}
		if h := NormalizeHost(str(doc, "data.bitdefender.endpoint.fqdn")); h != "" {
			group = append(group, "host:"+h)
		}
		if ip := NormalizeIP(str(doc, "data.bitdefender.endpoint.ip")); ip != "" && IsInternalIP(ip) {
			group = append(group, "ip:"+ip)
		}
		r.link(group)
		if len(group) > 0 {
			add(entityOf(r.find(group[0])))
		}
	}
	if comp := str(doc, "data.win.system.computer"); comp != "" {
		addHost(comp)
	}
	for _, field := range []string{"data.aws.instance_id", "data.aws.instanceId", "data.aws.resource.instanceDetails.instanceId"} {
		if id := strings.ToLower(str(doc, field)); instanceRe.MatchString(id) {
			hostIDs = append(hostIDs, "host:"+instanceRe.FindString(id))
		}
	}
	r.link(hostIDs)
	if len(hostIDs) > 0 {
		add(entityOf(r.find(hostIDs[0])))
	}

	// --- users
	failedSSH := groups["sshd"] && (groups["authentication_failed"] || groups["invalid_login"] || groups["authentication_failures"])
	hostForLocal := ""
	if len(hostIDs) > 0 {
		hostForLocal = strings.TrimPrefix(r.find(hostIDs[0]), "host:")
	}
	for _, field := range []string{
		"data.office365.UserId", "data.aws.principal_arn", "data.aws.userIdentity.arn",
		"data.aws.principal", "data.aws.userIdentity.userName", "data.cloudflare.audit.actor_email",
		"data.win.eventdata.targetUserName", "data.win.eventdata.subjectUserName",
		"data.srcuser", "data.dstuser", "data.user",
	} {
		raw := str(doc, field)
		if raw == "" {
			continue
		}
		if failedSSH && (field == "data.srcuser" || field == "data.dstuser" || field == "data.user") {
			continue // attacker-chosen names of failed logins are not identities
		}
		if field == "data.aws.principal" && str(doc, "data.aws.principal_arn") != "" {
			continue
		}
		if field == "data.win.eventdata.subjectUserName" && str(doc, "data.win.eventdata.targetUserName") != "" {
			continue
		}
		u := r.NormalizeUser(raw)
		if u == "" {
			continue
		}
		local := (field == "data.srcuser" || field == "data.dstuser" || field == "data.user") && !strings.Contains(u, "@")
		if local {
			if _, aliased := r.userAliases[strings.ToLower(raw)]; !aliased {
				if hostForLocal == "" {
					continue
				}
				u = "local:" + hostForLocal + "/" + u
			}
		}
		add(model.Entity{Type: model.EntityUser, Value: u})
		if strings.HasPrefix(strings.ToLower(raw), "arn:aws:") {
			if role := roleFromARN(raw); role != "" {
				add(model.Entity{Type: model.EntityCloud, Value: role})
			}
		}
	}

	// --- source IPs (actors). A private IP known as a host resolves to that host.
	for _, field := range []string{
		"data.srcip", "data.aws.source_ip", "data.aws.sourceIPAddress", "data.office365.ClientIP",
		"data.office365.ActorIpAddress", "data.cloudflare.firewall.client_ip",
		"data.cloudflare.audit.actor_ip", "data.win.eventdata.ipAddress", "data.src_ip",
	} {
		ip := NormalizeIP(stripPort(str(doc, field)))
		if ip == "" {
			continue
		}
		key := r.find("ip:" + ip)
		add(entityOf(key))
	}

	// --- cloud resources
	if zone := strings.ToLower(str(doc, "data.cloudflare.zone_name")); zone != "" {
		add(model.Entity{Type: model.EntityCloud, Value: "cloudflare:zone/" + zone})
	}
	if project := strings.ToLower(str(doc, "data.snyk.project.name")); project != "" {
		add(model.Entity{Type: model.EntityCloud, Value: "snyk:project/" + project})
	}
	if params := str(doc, "data.aws.request_parameters"); params != "" {
		for _, re := range []*regexp.Regexp{bucketRe, sgRe} {
			if m := re.FindStringSubmatch(params); m != nil {
				add(model.Entity{Type: model.EntityCloud, Value: m[1]})
			}
		}
	}
	for _, arn := range strs(doc, "data.aws.resources") {
		if strings.HasPrefix(strings.ToLower(arn), "arn:aws:") {
			add(model.Entity{Type: model.EntityCloud, Value: strings.ToLower(arn)})
		}
	}

	keys := make([]string, 0, len(ents))
	for k := range ents {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		obs.Entities = append(obs.Entities, ents[k])
	}
	obs.Stages = classify(doc, groups, obs)
	return obs, true
}

var (
	bucketRe = regexp.MustCompile(`"bucketName"\s*:\s*"([a-z0-9.\-]{3,63})"`)
	sgRe     = regexp.MustCompile(`"groupId"\s*:\s*"(sg-[0-9a-f]{8,17})"`)
)

func (r *Resolver) link(keys []string) {
	for i := 1; i < len(keys); i++ {
		r.union(keys[0], keys[i])
	}
	if len(keys) == 1 {
		if _, ok := r.parent[keys[0]]; !ok {
			r.parent[keys[0]] = keys[0]
		}
	}
}

func entityOf(key string) model.Entity {
	e, _ := model.ParseKey(key)
	return e
}

func stripPort(v string) string {
	if strings.Count(v, ":") == 1 {
		if host, _, ok := strings.Cut(v, ":"); ok {
			return host
		}
	}
	return v
}

func parseTime(v string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000-0700", "2006-01-02T15:04:05.000Z0700", "2006-01-02T15:04:05Z0700"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, &time.ParseError{Value: v}
}

// classify maps the alert to the multi-stage pattern vocabulary.
func classify(doc Doc, groups map[string]bool, obs model.Observation) []model.Stage {
	out := []model.Stage{}
	addStage := func(s model.Stage) {
		for _, x := range out {
			if x == s {
				return
			}
		}
		out = append(out, s)
	}
	action := strings.ToLower(str(doc, "data.cloudflare.firewall.action"))
	if obs.Source == "cloudflare" && (action == "block" || action == "drop" || action == "managed_challenge" || action == "challenge" || action == "jschallenge") {
		addStage(model.StageEdgeWAFBlock)
	}
	if obs.Source == "cloudflare" && obs.RuleID == "101740" {
		addStage(model.StageEdgeScan) // WAF attack surge = scanning at the edge
	}
	webScan := (groups["web"] || groups["accesslog"] || groups["nginx"] || groups["apache"]) &&
		(groups["attack"] || groups["recon"] || groups["web_scan"] || groups["invalid_access"] || groups["sql_injection"] || groups["multiple_web_errors"])
	if webScan || hasAny(groups, "web_scan", "scan", "recon") {
		addStage(model.StageEdgeScan)
	}
	if groups["sshd"] && (groups["authentication_failed"] || groups["invalid_login"] || groups["authentication_failures"] || groups["brute_force"]) {
		addStage(model.StageSSHBruteForce)
	}
	if groups["sshd"] && groups["authentication_success"] {
		addStage(model.StageSSHSuccess)
	}
	consoleLogin := strings.ToLower(str(doc, "data.aws.console_login"))
	op := str(doc, "data.office365.Operation")
	if hasAny(groups, "authentication_failed", "authentication_failures", "win_authentication_failed", "invalid_login") ||
		consoleLogin == "failure" || op == "UserLoginFailed" {
		addStage(model.StageAuthFailure)
	}
	if groups["authentication_success"] || consoleLogin == "success" || op == "UserLoggedIn" {
		addStage(model.StageAuthSuccess)
	}
	eventName := str(doc, "data.aws.event_name")
	if eventName == "" {
		eventName = str(doc, "data.aws.eventName")
	}
	if privilegedAWS[eventName] || op == "Add member to role." || op == "Add member to group." ||
		hasAny(groups, "qapaq_privilege_escalation", "group_changed", "adduser", "sudo_privilege") {
		addStage(model.StagePrivilegedChange)
	}
	for _, t := range obs.Tactics {
		if t == "privilege-escalation" && (obs.Source == "aws" || obs.Source == "m365" || obs.Source == "entra") {
			addStage(model.StagePrivilegedChange)
		}
	}
	if tamperAWS[eventName] {
		addStage(model.StageCloudTamper)
	}
	if truthy(doc, "data.bitdefender.endpoint.antimalware_disabled") || truthy(doc, "data.bitdefender.endpoint.atc_disabled") {
		addStage(model.StageProtectionOff)
	}
	if truthy(doc, "data.bitdefender.endpoint.infected") || truthy(doc, "data.bitdefender.endpoint.detection") ||
		hasAny(groups, "malware", "virus", "virustotal") {
		addStage(model.StageEndpointMalware)
	}
	return out
}
