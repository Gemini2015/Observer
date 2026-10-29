// Package config 负责 agent YAML 配置的解析与启动期校验。
package config

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"observer/agent/internal/rules"
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

const (
	defaultBytesPerSec = 200 << 20 // 200 MiB/s
	defaultFilesPerSec = 300
	defaultCacheDays   = 7
)

// ByteSize 支持 "200MiB" / "1GB" / 纯数字（字节）。
type ByteSize int64

func (b *ByteSize) UnmarshalYAML(value *yaml.Node) error {
	var text string
	if err := value.Decode(&text); err == nil {
		size, err := ParseByteSize(text)
		if err != nil {
			return err
		}
		*b = ByteSize(size)
		return nil
	}
	var number int64
	if err := value.Decode(&number); err != nil {
		return fmt.Errorf("invalid byte size: %s", value.Value)
	}
	*b = ByteSize(number)
	return nil
}

// ParseByteSize 解析带单位的字节数。
func ParseByteSize(text string) (int64, error) {
	input := strings.TrimSpace(text)
	if input == "" {
		return 0, errors.New("empty byte size")
	}
	units := []struct {
		suffix     string
		multiplier float64
	}{
		{"TiB", 1 << 40}, {"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10},
		{"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3},
		{"B", 1},
	}
	factor := 1.0
	for _, unit := range units {
		if strings.HasSuffix(input, unit.suffix) {
			factor = unit.multiplier
			input = strings.TrimSpace(strings.TrimSuffix(input, unit.suffix))
			break
		}
	}
	value, err := strconv.ParseFloat(input, 64)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("invalid byte size %q", text)
	}
	return int64(value * factor), nil
}

// Limits 是双闸限速配置。
type Limits struct {
	BytesPerSec ByteSize `yaml:"bytes_per_sec"`
	FilesPerSec float64  `yaml:"files_per_sec"`
	BurstBytes  ByteSize `yaml:"burst_bytes"`
	OnWindowEnd string   `yaml:"on_window_end"`
}

// Schedule 目前仅校验格式，M2 才真正参与调度。
type Schedule struct {
	BudgetMinutesPerDay int    `yaml:"budget_minutes_per_day"`
	Window              string `yaml:"window"`
}

// Mount 是单个挂载点配置。
type Mount struct {
	ID       string `yaml:"id"`
	Label    string `yaml:"label"`
	Path     string `yaml:"path"`
	Sentinel string `yaml:"sentinel"`

	FSKind        string `yaml:"fs_kind"`
	CaseSensitive string `yaml:"case_sensitive"`
	Unicode       string `yaml:"unicode"`

	Include []string `yaml:"include"`
	Exclude []string `yaml:"exclude"`

	Limits   *Limits  `yaml:"limits"`
	Schedule Schedule `yaml:"schedule"`

	ReadOnly      *bool `yaml:"read_only"`
	RepairAllowed *bool `yaml:"repair_allowed"`

	// 运行时派生字段，不参与 YAML 解析。
	Rules           *rules.Rules `yaml:"-"`
	RulesHash       string       `yaml:"-"`
	CaseFold        bool         `yaml:"-"`
	EffectiveLimits Limits       `yaml:"-"`
}

// Agent 是进程级配置。
type Agent struct {
	MachineID           string `yaml:"machine_id"`
	Label               string `yaml:"label"`
	Hub                 string `yaml:"hub"`
	TokenFile           string `yaml:"token_file"`
	CacheFullResyncDays int    `yaml:"cache_full_resync_days"`
}

// Defaults 是 mount 的默认值。
type Defaults struct {
	Limits Limits `yaml:"limits"`
}

// Config 是完整配置。
type Config struct {
	Agent    Agent    `yaml:"agent"`
	Defaults Defaults `yaml:"defaults"`
	Mounts   []Mount  `yaml:"mounts"`
}

// Load 读取并校验 YAML 配置文件。
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	return Parse(data)
}

// Parse 解析并校验 YAML 内容。
func Parse(data []byte) (*Config, error) {
	var cfg Config
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	if !idPattern.MatchString(c.Agent.MachineID) {
		return fmt.Errorf("agent.machine_id %q must match %s", c.Agent.MachineID, idPattern)
	}
	if c.Agent.Hub == "" {
		return errors.New("agent.hub is required")
	}
	parsed, err := url.Parse(c.Agent.Hub)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("agent.hub %q must be an http(s) URL", c.Agent.Hub)
	}
	if c.Agent.TokenFile == "" {
		c.Agent.TokenFile = ".observer/token"
	}
	if c.Agent.CacheFullResyncDays == 0 {
		c.Agent.CacheFullResyncDays = defaultCacheDays
	}
	if c.Agent.CacheFullResyncDays < 0 {
		return errors.New("agent.cache_full_resync_days must be >= 0")
	}
	if len(c.Mounts) == 0 {
		return errors.New("at least one mount is required")
	}

	base := defaultLimits()
	applyOverrides(&base, c.Defaults.Limits)
	if base.BytesPerSec < 0 || base.FilesPerSec < 0 || base.BurstBytes < 0 {
		return errors.New("limits must not be negative")
	}
	if base.BurstBytes == 0 {
		base.BurstBytes = ByteSize(int64(float64(base.BytesPerSec) * 60))
	}

	seen := make(map[string]struct{}, len(c.Mounts))
	paths := make([]string, 0, len(c.Mounts))

	for i := range c.Mounts {
		mount := &c.Mounts[i]
		if !idPattern.MatchString(mount.ID) {
			return fmt.Errorf("mount[%d].id %q must match %s", i, mount.ID, idPattern)
		}
		if _, exists := seen[mount.ID]; exists {
			return fmt.Errorf("duplicate mount id %q", mount.ID)
		}
		seen[mount.ID] = struct{}{}

		if mount.Path == "" {
			return fmt.Errorf("mount %q: path is required", mount.ID)
		}
		absolute, err := filepath.Abs(mount.Path)
		if err != nil {
			return fmt.Errorf("mount %q: resolve path: %w", mount.ID, err)
		}
		mount.Path = filepath.Clean(absolute)

		if mount.Sentinel != "" {
			sentinel := filepath.ToSlash(mount.Sentinel)
			if strings.HasPrefix(sentinel, "/") || strings.Contains(sentinel, "..") {
				return fmt.Errorf("mount %q: sentinel must be a relative path", mount.ID)
			}
		}

		if mount.FSKind == "" {
			mount.FSKind = "local"
		}
		switch mount.FSKind {
		case "local", "network", "removable", "fuse":
		default:
			return fmt.Errorf("mount %q: invalid fs_kind %q", mount.ID, mount.FSKind)
		}

		if mount.CaseSensitive == "" {
			mount.CaseSensitive = "auto"
		}
		switch mount.CaseSensitive {
		case "auto":
			mount.CaseFold = runtime.GOOS == "windows" || runtime.GOOS == "darwin"
		case "true":
			mount.CaseFold = false
		case "false":
			mount.CaseFold = true
		default:
			return fmt.Errorf("mount %q: invalid case_sensitive %q", mount.ID, mount.CaseSensitive)
		}

		if mount.Unicode == "" {
			mount.Unicode = "auto"
		}
		switch mount.Unicode {
		case "auto", "nfc", "nfd":
		default:
			return fmt.Errorf("mount %q: invalid unicode %q", mount.ID, mount.Unicode)
		}

		compiled, err := rules.Compile(mount.Include, mount.Exclude, mount.CaseFold)
		if err != nil {
			return fmt.Errorf("mount %q: %w", mount.ID, err)
		}
		mount.Rules = compiled
		mount.RulesHash = compiled.Hash()

		limits := base
		if mount.Limits != nil {
			applyOverrides(&limits, *mount.Limits)
		}
		if limits.BurstBytes == 0 {
			limits.BurstBytes = ByteSize(int64(float64(limits.BytesPerSec) * 60))
		}
		mount.EffectiveLimits = limits

		if mount.Schedule.Window != "" && !validWindow(mount.Schedule.Window) {
			return fmt.Errorf("mount %q: schedule.window must be HH:MM-HH:MM", mount.ID)
		}

		for _, existing := range paths {
			if pathsOverlap(existing, mount.Path) {
				return fmt.Errorf("mount %q path %q overlaps with %q", mount.ID, mount.Path, existing)
			}
		}
		paths = append(paths, mount.Path)
	}

	return nil
}

func defaultLimits() Limits {
	return Limits{
		BytesPerSec: ByteSize(defaultBytesPerSec),
		FilesPerSec: defaultFilesPerSec,
		OnWindowEnd: "finish",
	}
}

func applyOverrides(target *Limits, overlay Limits) {
	if overlay.BytesPerSec != 0 {
		target.BytesPerSec = overlay.BytesPerSec
	}
	if overlay.FilesPerSec != 0 {
		target.FilesPerSec = overlay.FilesPerSec
	}
	if overlay.BurstBytes != 0 {
		target.BurstBytes = overlay.BurstBytes
	}
	if overlay.OnWindowEnd != "" {
		if overlay.OnWindowEnd == "finish" || overlay.OnWindowEnd == "abort" {
			target.OnWindowEnd = overlay.OnWindowEnd
		}
	}
}

func validWindow(window string) bool {
	parts := strings.Split(window, "-")
	if len(parts) != 2 {
		return false
	}
	for _, part := range parts {
		segments := strings.Split(strings.TrimSpace(part), ":")
		if len(segments) != 2 {
			return false
		}
		hour, err := strconv.Atoi(segments[0])
		if err != nil || hour < 0 || hour > 23 {
			return false
		}
		minute, err := strconv.Atoi(segments[1])
		if err != nil || minute < 0 || minute > 59 {
			return false
		}
	}
	return true
}

func pathsOverlap(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		a = strings.ToLower(a)
		b = strings.ToLower(b)
	}
	if a == b {
		return true
	}
	return strings.HasPrefix(a, b+string(filepath.Separator)) ||
		strings.HasPrefix(b, a+string(filepath.Separator))
}
