package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func sampleConfig(path string) string {
	return fmt.Sprintf(`
agent:
  machine_id: test-agent
  hub: http://127.0.0.1:8787
mounts:
  - id: photos
    path: %q
    include: ["**/*.jpg"]
`, filepath.ToSlash(path))
}

func TestParseValidConfig(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Parse([]byte(sampleConfig(dir)))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Agent.MachineID != "test-agent" {
		t.Errorf("machine id = %q", cfg.Agent.MachineID)
	}
	if cfg.Agent.TokenFile == "" {
		t.Error("expected default token file")
	}
	if len(cfg.Mounts) != 1 {
		t.Fatalf("mounts = %d", len(cfg.Mounts))
	}
	mount := cfg.Mounts[0]
	if mount.RulesHash == "" {
		t.Error("expected rules hash")
	}
	if mount.EffectiveLimits.BytesPerSec != 200<<20 {
		t.Errorf("bytes limit = %d", mount.EffectiveLimits.BytesPerSec)
	}
	if mount.EffectiveLimits.FilesPerSec != 300 {
		t.Errorf("files limit = %v", mount.EffectiveLimits.FilesPerSec)
	}
	if mount.EffectiveLimits.BurstBytes != 60*(200<<20) {
		t.Errorf("burst = %d", mount.EffectiveLimits.BurstBytes)
	}
}

func TestParseByteSize(t *testing.T) {
	cases := map[string]int64{
		"200MiB": 200 << 20,
		"1GiB":   1 << 30,
		"1GB":    1_000_000_000,
		"512":    512,
		"1.5KiB": 1536,
	}
	for input, want := range cases {
		got, err := ParseByteSize(input)
		if err != nil {
			t.Fatalf("ParseByteSize(%q): %v", input, err)
		}
		if got != want {
			t.Errorf("ParseByteSize(%q) = %d, want %d", input, got, want)
		}
	}
	if _, err := ParseByteSize("abc"); err == nil {
		t.Error("expected error for invalid size")
	}
}

func TestMountLimitsOverrideDefaults(t *testing.T) {
	dir := t.TempDir()
	yaml := fmt.Sprintf(`
agent:
  machine_id: test-agent
  hub: http://127.0.0.1:8787
defaults:
  limits:
    bytes_per_sec: 10MiB
    files_per_sec: 10
mounts:
  - id: photos
    path: %q
    limits:
      bytes_per_sec: 5MiB
`, filepath.ToSlash(dir))
	cfg, err := Parse([]byte(yaml))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	limits := cfg.Mounts[0].EffectiveLimits
	if limits.BytesPerSec != 5<<20 {
		t.Errorf("bytes = %d", limits.BytesPerSec)
	}
	if limits.FilesPerSec != 10 {
		t.Errorf("files = %v", limits.FilesPerSec)
	}
}

func TestValidationErrors(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())

	cases := []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "bad machine id",
			yaml: fmt.Sprintf("agent:\n  machine_id: Bad/ID\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n", dir),
			want: "machine_id",
		},
		{
			name: "no mounts",
			yaml: "agent:\n  machine_id: test-agent\n  hub: http://x\n",
			want: "at least one mount",
		},
		{
			name: "duplicate mount id",
			yaml: fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n  - id: a\n    path: %q\n", dir+"\\a", dir+"\\b"),
			want: "duplicate mount id",
		},
		{
			name: "overlapping paths",
			yaml: fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n  - id: b\n    path: %q\n", dir, dir+"\\nested"),
			want: "overlaps",
		},
		{
			name: "invalid pattern",
			yaml: fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n    include: [\"../**\"]\n", dir),
			want: "pattern",
		},
		{
			name: "invalid fs kind",
			yaml: fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n    fs_kind: nope\n", dir),
			want: "fs_kind",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Parse([]byte(testCase.yaml))
			if err == nil {
				t.Fatalf("expected error containing %q", testCase.want)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q does not contain %q", err, testCase.want)
			}
		})
	}
}

func TestWindowValidation(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	valid := fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\nmounts:\n  - id: a\n    path: %q\n    schedule:\n      window: \"01:00-06:00\"\n", dir)
	if _, err := Parse([]byte(valid)); err != nil {
		t.Fatalf("expected valid window: %v", err)
	}
	invalid := strings.Replace(valid, "01:00-06:00", "25:00-06:00", 1)
	if _, err := Parse([]byte(invalid)); err == nil {
		t.Fatal("expected invalid window error")
	}
}

func TestInlineTokenConfig(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	raw := fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\n  token: inline-token-abc\nmounts:\n  - id: a\n    path: %q\n", dir)
	cfg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Agent.Token != "inline-token-abc" {
		t.Errorf("token = %q", cfg.Agent.Token)
	}
	if cfg.Agent.TokenFile != "" {
		t.Errorf("inline token should not default token file, got %q", cfg.Agent.TokenFile)
	}
	wantState := filepath.Join(".observer", "test-agent")
	if cfg.Agent.StateDir != wantState {
		t.Errorf("state dir = %q, want %q", cfg.Agent.StateDir, wantState)
	}
}

func TestExplicitStateDir(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	stateDir := filepath.ToSlash(filepath.Join(t.TempDir(), "state"))
	raw := fmt.Sprintf("agent:\n  machine_id: test-agent\n  hub: http://x\n  token: inline-token-abc\n  state_dir: %q\nmounts:\n  - id: a\n    path: %q\n", stateDir, dir)
	cfg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Agent.StateDir != stateDir {
		t.Errorf("state dir = %q, want %q", cfg.Agent.StateDir, stateDir)
	}
}
