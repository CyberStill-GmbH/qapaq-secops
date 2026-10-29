package main

// Política del docker-guard de Ankay: lista cerrada de operaciones del API Docker que
// Orborus y el worker de Shuffle necesitan para lanzar ejecuciones en modo no-swarm.
// Todo lo demás se rechaza. El guard es el único proceso con el socket del daemon.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// GuardLabel marca los contenedores creados a través del guard. Solo sobre ellos se
// permiten operaciones de ciclo de vida, inspección y logs.
const GuardLabel = "io.qapaq.ankay.docker-guard"

const maxCreateBody = 1 << 20

var (
	versionPrefix = regexp.MustCompile(`^/v[0-9]{1,2}\.[0-9]{1,3}(/.*)$`)
	safeRef       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	// Nombres que Orborus y el worker asignan a sus contenedores.
	safeName = regexp.MustCompile(`^/?[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)
)

// Route es la operación reconocida tras normalizar el path.
type Route struct {
	Kind   string // ping, version, info, containers-list, container-create, container-op, container-read, images-list, image-inspect, networks-list, network-inspect
	Target string // id/nombre de contenedor o imagen/red, si aplica
	Op     string // start, stop, kill, wait, delete, json, logs, stats
}

// Policy define las imágenes permitidas y los contenedores de Compose que pueden
// prestar su espacio de red al worker (Orborus).
type Policy struct {
	AllowedImages  map[string]bool
	ComposeProject string
	NetnsServices  map[string]bool
	PidsLimit      int64
}

// ContainerFacts es lo que el guard necesita saber de un contenedor existente.
type ContainerFacts struct {
	Labels map[string]string
}

var ErrDenied = errors.New("denied by Ankay docker-guard policy")

func deny(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrDenied, fmt.Sprintf(format, args...))
}

// Classify reconoce únicamente rutas de la lista cerrada.
func Classify(method, rawPath string) (Route, error) {
	if strings.Contains(rawPath, "..") || strings.Contains(rawPath, "//") || strings.Contains(rawPath, "%") {
		return Route{}, deny("non-canonical path")
	}
	path := rawPath
	if m := versionPrefix.FindStringSubmatch(rawPath); m != nil {
		path = m[1]
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	get := method == http.MethodGet || method == http.MethodHead

	switch {
	case len(parts) == 1 && parts[0] == "_ping" && get:
		return Route{Kind: "ping"}, nil
	case len(parts) == 1 && parts[0] == "version" && get:
		return Route{Kind: "version"}, nil
	case len(parts) == 1 && parts[0] == "info" && get:
		return Route{Kind: "info"}, nil
	case len(parts) == 2 && parts[0] == "containers" && parts[1] == "json" && get:
		return Route{Kind: "containers-list"}, nil
	case len(parts) == 2 && parts[0] == "containers" && parts[1] == "create" && method == http.MethodPost:
		return Route{Kind: "container-create"}, nil
	case len(parts) == 2 && parts[0] == "containers" && method == http.MethodDelete && safeRef.MatchString(parts[1]):
		return Route{Kind: "container-op", Target: parts[1], Op: "delete"}, nil
	case len(parts) == 3 && parts[0] == "containers" && safeRef.MatchString(parts[1]):
		switch {
		case method == http.MethodPost && (parts[2] == "start" || parts[2] == "stop" || parts[2] == "kill" || parts[2] == "wait"):
			return Route{Kind: "container-op", Target: parts[1], Op: parts[2]}, nil
		case get && (parts[2] == "json" || parts[2] == "logs" || parts[2] == "stats"):
			return Route{Kind: "container-read", Target: parts[1], Op: parts[2]}, nil
		}
	case len(parts) == 2 && parts[0] == "images" && parts[1] == "json" && get:
		return Route{Kind: "images-list"}, nil
	case len(parts) >= 3 && parts[0] == "images" && parts[len(parts)-1] == "json" && get:
		// Referencias con registro/ruta: images/<registry>/<repo>:<tag>/json.
		ref := strings.Join(parts[1:len(parts)-1], "/")
		if !validImageRef(ref) {
			return Route{}, deny("invalid image reference")
		}
		return Route{Kind: "image-inspect", Target: ref}, nil
	case len(parts) == 1 && parts[0] == "networks" && get:
		return Route{Kind: "networks-list"}, nil
	case len(parts) == 2 && parts[0] == "networks" && get && safeRef.MatchString(parts[1]):
		return Route{Kind: "network-inspect", Target: parts[1]}, nil
	}
	return Route{}, deny("operation %s %s is not allowlisted", method, path)
}

var imageRefPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`)

func validImageRef(ref string) bool {
	return len(ref) <= 512 && imageRefPattern.MatchString(ref)
}

// ManagedByGuard indica si el contenedor fue creado por el guard.
func ManagedByGuard(facts ContainerFacts) bool {
	return facts.Labels[GuardLabel] == "true"
}

// MayLendNetns permite `container:<x>` solo hacia contenedores del guard o hacia los
// servicios Compose aprobados (Orborus), nunca hacia backend u OpenSearch.
func (p Policy) MayLendNetns(facts ContainerFacts) bool {
	if ManagedByGuard(facts) {
		return true
	}
	return facts.Labels["com.docker.compose.project"] == p.ComposeProject &&
		p.NetnsServices[facts.Labels["com.docker.compose.service"]]
}

// ReviewCreate valida y endurece el cuerpo de POST /containers/create. lookup resuelve
// el contenedor que presta su red cuando NetworkMode es container:<x>.
func (p Policy) ReviewCreate(body []byte, lookup func(string) (ContainerFacts, error)) ([]byte, error) {
	if len(body) == 0 || len(body) > maxCreateBody {
		return nil, deny("container create body is missing or too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var spec map[string]any
	if err := decoder.Decode(&spec); err != nil {
		return nil, deny("container create body is not a JSON object")
	}
	if decoder.More() {
		return nil, deny("container create body has trailing data")
	}

	image, _ := spec["Image"].(string)
	if !p.AllowedImages[image] {
		return nil, deny("image %q is not allowlisted", image)
	}
	if present(spec["Volumes"]) {
		return nil, deny("anonymous volumes are not allowed")
	}
	if user, ok := spec["User"].(string); ok && user != "" && (user == "0" || strings.HasPrefix(user, "root") || strings.HasPrefix(user, "0:")) {
		return nil, deny("containers may not request the root user explicitly")
	}

	host, _ := spec["HostConfig"].(map[string]any)
	if host == nil {
		host = map[string]any{}
	}
	if err := p.reviewHostConfig(host, lookup); err != nil {
		return nil, err
	}
	spec["HostConfig"] = host

	if networking, ok := spec["NetworkingConfig"].(map[string]any); ok {
		if endpoints, ok := networking["EndpointsConfig"].(map[string]any); ok && len(endpoints) > 0 {
			// El CLI de Docker declara la red del NetworkMode como único endpoint; cualquier
			// otra red (p. ej. la de datos con OpenSearch) queda prohibida.
			mode, _ := host["NetworkMode"].(string)
			for name := range endpoints {
				if len(endpoints) != 1 || !(name == mode || ((mode == "" || mode == "default") && (name == "default" || name == "bridge"))) {
					return nil, deny("containers may not attach to additional networks")
				}
			}
		}
	}

	labels, _ := spec["Labels"].(map[string]any)
	if labels == nil {
		labels = map[string]any{}
	}
	for key := range labels {
		if strings.HasPrefix(key, "com.docker.compose.") || key == GuardLabel {
			return nil, deny("reserved label %q", key)
		}
	}
	labels[GuardLabel] = "true"
	spec["Labels"] = labels

	return json.Marshal(spec)
}

func (p Policy) reviewHostConfig(host map[string]any, lookup func(string) (ContainerFacts, error)) error {
	if b, _ := host["Privileged"].(bool); b {
		return deny("privileged containers are not allowed")
	}
	if b, _ := host["PublishAllPorts"].(bool); b {
		return deny("publishing ports is not allowed")
	}
	for _, field := range []string{
		"Binds", "Mounts", "VolumesFrom", "Devices", "DeviceRequests", "DeviceCgroupRules",
		"CapAdd", "PortBindings", "Sysctls", "Tmpfs", "Links", "ExtraHosts", "Dns",
		"MaskedPaths", "ReadonlyPaths", "GroupAdd", "StorageOpt",
	} {
		if present(host[field]) {
			return deny("host config field %s is not allowed", field)
		}
	}
	for _, field := range []string{"PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode", "Cgroup", "CgroupParent", "Runtime", "VolumeDriver", "Isolation"} {
		if value, _ := host[field].(string); value != "" && !(field == "CgroupnsMode" && value == "private") && !(field == "IpcMode" && (value == "private" || value == "none")) {
			return deny("host config field %s=%q is not allowed", field, value)
		}
	}

	options := []string{}
	if raw, ok := host["SecurityOpt"].([]any); ok {
		for _, item := range raw {
			value, _ := item.(string)
			lower := strings.ToLower(value)
			if strings.Contains(lower, "unconfined") || strings.HasPrefix(lower, "seccomp") ||
				strings.HasPrefix(lower, "apparmor") || strings.HasPrefix(lower, "label") ||
				strings.HasPrefix(lower, "systempaths") || lower == "no-new-privileges:false" || lower == "no-new-privileges=false" {
				return deny("security option %q is not allowed", value)
			}
			if lower != "no-new-privileges" && lower != "no-new-privileges:true" && lower != "no-new-privileges=true" {
				return deny("security option %q is not allowlisted", value)
			}
		}
	} else if present(host["SecurityOpt"]) {
		return deny("security options must be a list")
	}
	options = append(options, "no-new-privileges:true")
	host["SecurityOpt"] = options

	mode, _ := host["NetworkMode"].(string)
	switch {
	case mode == "" || mode == "default" || mode == "bridge" || mode == "none":
	case strings.HasPrefix(mode, "container:"):
		target := strings.TrimPrefix(mode, "container:")
		if !safeName.MatchString(target) {
			return deny("invalid network namespace target")
		}
		facts, err := lookup(strings.TrimPrefix(target, "/"))
		if err != nil {
			return deny("network namespace target is unknown")
		}
		if !p.MayLendNetns(facts) {
			return deny("network namespace target is not an Ankay execution container")
		}
	default:
		return deny("network mode %q is not allowed", mode)
	}

	if p.PidsLimit > 0 {
		host["PidsLimit"] = p.PidsLimit
	}
	return nil
}

// ParseAllowedImages acepta una lista separada por comas o espacios.
func ParseAllowedImages(raw string) (map[string]bool, error) {
	images := map[string]bool{}
	for _, item := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
		if !validImageRef(item) {
			return nil, fmt.Errorf("invalid allowlisted image reference %q", item)
		}
		images[item] = true
	}
	if len(images) == 0 {
		return nil, errors.New("at least one allowlisted image is required")
	}
	return images, nil
}

func (p Policy) describe() string {
	images := make([]string, 0, len(p.AllowedImages))
	for image := range p.AllowedImages {
		images = append(images, image)
	}
	sort.Strings(images)
	return fmt.Sprintf("%d allowlisted images, compose project %q", len(images), p.ComposeProject)
}

func present(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	case string:
		return v != ""
	case bool:
		return v
	default:
		return true
	}
}
