package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"observer/agent/internal/config"
)

func writeTestConfig(t *testing.T, dir, content string) string {
	t.Helper()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func baseConfigYAML(t *testing.T, root string, extraAgent string, mountExtra string) string {
	t.Helper()
	return fmt.Sprintf(`agent:
  machine_id: test-pc
  hub: http://127.0.0.1:8787
%s
mounts:
  - id: data
    path: %s
    sentinel: .observer-mount
%s
`, extraAgent, filepath.ToSlash(root), mountExtra)
}

func TestAssessConfig(t *testing.T) {
	dir := t.TempDir()

	missing := filepath.Join(dir, "missing.yaml")
	_, state := assessConfig(missing)
	if !state.NeedsSetup || state.Existing {
		t.Fatalf("missing config state = %+v", state)
	}
	if state.Error != "" {
		t.Fatalf("missing config should not show raw error: %q", state.Error)
	}

	invalid := writeTestConfig(t, t.TempDir(), "agent: [broken")
	_, state = assessConfig(invalid)
	if !state.NeedsSetup || state.Error == "" || !state.Existing {
		t.Fatalf("invalid config state = %+v", state)
	}

	mountDir := t.TempDir()
	emptyToken := writeTestConfig(t, t.TempDir(), baseConfigYAML(t, mountDir, "", ""))
	_, state = assessConfig(emptyToken)
	if !state.NeedsSetup || state.Prefill == nil || state.Prefill.MachineID != "test-pc" {
		t.Fatalf("empty token should need setup: %+v", state)
	}

	withToken := writeTestConfig(t, t.TempDir(), baseConfigYAML(t, mountDir, "  token: token-123", ""))
	cfg, state := assessConfig(withToken)
	if state.NeedsSetup || cfg == nil || cfg.Agent.Token != "token-123" {
		t.Fatalf("token config state = %+v cfg=%v", state, cfg)
	}

	placeholder := writeTestConfig(t, t.TempDir(), baseConfigYAML(t, mountDir, "  token: \"<paste-token>\"", ""))
	_, state = assessConfig(placeholder)
	if !state.NeedsSetup {
		t.Fatalf("placeholder token should need setup: %+v", state)
	}

	stateDir := filepath.Join(t.TempDir(), "state")
	cachedDir := t.TempDir()
	cachedConfig := writeTestConfig(t, cachedDir, baseConfigYAML(t, mountDir, "  state_dir: "+filepath.ToSlash(stateDir), ""))
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("mkdir state: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "agent.token"), []byte("cached-token\n"), 0o600); err != nil {
		t.Fatalf("write cached token: %v", err)
	}
	_, state = assessConfig(cachedConfig)
	if state.NeedsSetup {
		t.Fatalf("cached token should be configured: %+v", state)
	}
}

func TestValidateInitial(t *testing.T) {
	mountDir := t.TempDir()
	valid := SetupInput{
		MachineID: "test-pc",
		Label:     "Test PC",
		Hub:       "http://127.0.0.1:8787",
		Token:     "token-abc",
		Mounts: []SetupMountInput{
			{ID: "data", Path: mountDir, Sentinel: ".observer-mount"},
		},
	}
	data, err := validateInitial(valid)
	if err != nil {
		t.Fatalf("validateInitial: %v", err)
	}
	cfg, err := config.Parse(data)
	if err != nil {
		t.Fatalf("generated config invalid: %v", err)
	}
	if cfg.Agent.Token != "token-abc" || len(cfg.Mounts) != 1 {
		t.Fatalf("unexpected config: %+v", cfg.Agent)
	}
	if !strings.Contains(string(data), "state_dir:") {
		t.Fatalf("expected state_dir in generated yaml: %s", data)
	}

	withoutSentinel := valid
	withoutSentinel.Mounts = []SetupMountInput{{ID: "data", Path: mountDir}}
	data, err = validateInitial(withoutSentinel)
	if err != nil {
		t.Fatalf("validateInitial without sentinel: %v", err)
	}
	cfg, err = config.Parse(data)
	if err != nil {
		t.Fatalf("config without sentinel invalid: %v", err)
	}
	if cfg.Mounts[0].Sentinel != "" {
		t.Fatalf("sentinel should be optional, got %q", cfg.Mounts[0].Sentinel)
	}

	cases := []struct {
		name   string
		mutate func(*SetupInput)
		want   string
	}{
		{"bad machine", func(input *SetupInput) { input.MachineID = "Bad ID" }, "机器 ID"},
		{"bad hub", func(input *SetupInput) { input.Hub = "ftp://x" }, "http(s)"},
		{"empty token", func(input *SetupInput) { input.Token = "" }, "注册 token"},
		{"no mounts", func(input *SetupInput) { input.Mounts = nil }, "至少需要"},
		{"duplicate mount", func(input *SetupInput) {
			input.Mounts = append(input.Mounts, input.Mounts[0])
		}, "重复"},
		{"missing path", func(input *SetupInput) { input.Mounts[0].Path = filepath.Join(t.TempDir(), "nope") }, "目录不可访问"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := valid
			input.Mounts = append([]SetupMountInput(nil), valid.Mounts...)
			if testCase.mutate != nil {
				testCase.mutate(&input)
			}
			if _, err := validateInitial(input); err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error = %v, want contains %q", err, testCase.want)
			}
		})
	}
}

func TestBuildSettingsYAMLKeepsAdvancedFields(t *testing.T) {
	mountDir := t.TempDir()
	current := fmt.Sprintf(`agent:
  machine_id: test-pc
  label: old
  hub: http://127.0.0.1:8787
  token: token-123
mounts:
  - id: data
    label: old-data
    path: %s
    sentinel: .observer-mount
    read_only: true
    limits:
      bytes_per_sec: 200MiB
      files_per_sec: 300
    schedule:
      window: "01:00-06:00"
      interval_minutes: 60
`, filepath.ToSlash(mountDir))

	updated, err := buildSettingsYAML([]byte(current), SettingsInput{
		Label: "new-label",
		Mounts: []SettingsMountInput{
			{
				ID:            "data",
				Label:         "new-data",
				Path:          mountDir,
				Sentinel:      ".observer-mount",
				Exclude:       []string{"**/.observer-mount"},
				RepairAllowed: true,
			},
		},
	})
	if err != nil {
		t.Fatalf("buildSettingsYAML: %v", err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(updated, &doc); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	agent := doc["agent"].(map[string]any)
	if agent["label"] != "new-label" {
		t.Fatalf("agent label = %v", agent["label"])
	}
	mounts := doc["mounts"].([]any)
	mount := mounts[0].(map[string]any)
	if mount["label"] != "new-data" || mount["repair_allowed"] != true {
		t.Fatalf("mount not updated: %+v", mount)
	}
	if mount["read_only"] != true {
		t.Fatalf("read_only lost: %+v", mount)
	}
	limits, _ := mount["limits"].(map[string]any)
	if limits["bytes_per_sec"] != "200MiB" {
		t.Fatalf("limits lost: %+v", mount["limits"])
	}
	schedule, _ := mount["schedule"].(map[string]any)
	if schedule["window"] != "01:00-06:00" {
		t.Fatalf("schedule lost: %+v", mount["schedule"])
	}
	if _, err := config.Parse(updated); err != nil {
		t.Fatalf("updated config invalid: %v", err)
	}
}

func TestBuildSettingsYAMLAddRemoveMount(t *testing.T) {
	firstDir := t.TempDir()
	secondDir := t.TempDir()
	current := fmt.Sprintf(`agent:
  machine_id: test-pc
  hub: http://127.0.0.1:8787
  token: token-123
mounts:
  - id: data
    path: %s
`, filepath.ToSlash(firstDir))

	updated, err := buildSettingsYAML([]byte(current), SettingsInput{
		Mounts: []SettingsMountInput{
			{ID: "data", Path: firstDir},
			{ID: "photos", Path: secondDir, Sentinel: ".observer-mount"},
		},
	})
	if err != nil {
		t.Fatalf("add mount: %v", err)
	}
	var doc map[string]any
	_ = yaml.Unmarshal(updated, &doc)
	if len(doc["mounts"].([]any)) != 2 {
		t.Fatalf("expected 2 mounts: %s", updated)
	}

	updated, err = buildSettingsYAML(updated, SettingsInput{
		Mounts: []SettingsMountInput{{ID: "photos", Path: secondDir}},
	})
	if err != nil {
		t.Fatalf("remove mount: %v", err)
	}
	_ = yaml.Unmarshal(updated, &doc)
	mounts := doc["mounts"].([]any)
	if len(mounts) != 1 || mounts[0].(map[string]any)["id"] != "photos" {
		t.Fatalf("remove mount failed: %s", updated)
	}

	if _, err := buildSettingsYAML([]byte(current), SettingsInput{}); err == nil {
		t.Fatal("expected error for zero mounts")
	}
}

func TestWriteConfigFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "agent.yaml")
	if err := writeConfigFile(path, []byte("first: 1\n")); err != nil {
		t.Fatalf("write first: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "first: 1\n" {
		t.Fatalf("read first: %v %q", err, data)
	}
	if err := writeConfigFile(path, []byte("second: 2\n")); err != nil {
		t.Fatalf("write second: %v", err)
	}
	backup, err := os.ReadFile(path + ".bak")
	if err != nil || string(backup) != "first: 1\n" {
		t.Fatalf("backup = %q err=%v", backup, err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != "second: 2\n" {
		t.Fatalf("current = %q", data)
	}
}

func TestSetupManagerRoundTrip(t *testing.T) {
	mountDir := t.TempDir()
	configPath := filepath.Join(t.TempDir(), "agent.yaml")
	manager := newSetupManager(configPath)
	if !manager.GetState().NeedsSetup {
		t.Fatal("missing config should need setup")
	}

	cfg, state, err := manager.SaveInitial(SetupInput{
		MachineID: "test-pc",
		Hub:       "http://127.0.0.1:8787",
		Token:     "token-abc",
		Mounts:    []SetupMountInput{{ID: "data", Path: mountDir}},
	})
	if err != nil {
		t.Fatalf("SaveInitial: %v", err)
	}
	if state.NeedsSetup || cfg.Agent.Token != "token-abc" {
		t.Fatalf("unexpected state: %+v", state)
	}
	if _, err := manager.GetSettings(); err != nil {
		t.Fatalf("GetSettings: %v", err)
	}

	settings, err := manager.SaveSettings(SettingsInput{
		Label:  "renamed",
		Mounts: []SettingsMountInput{{ID: "data", Path: mountDir}},
	})
	if err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	if settings.Agent.Label != "renamed" {
		t.Fatalf("label = %q", settings.Agent.Label)
	}
	loaded, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Agent.Label != "renamed" {
		t.Fatalf("label = %q", loaded.Agent.Label)
	}
}

func TestConfigServiceInitialAndSettings(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.yaml")
	firstMount := t.TempDir()
	secondMount := t.TempDir()
	controller := &controller{configPath: configPath}
	service := &ConfigService{controller: controller, manager: newSetupManager(configPath)}

	state := service.GetSetupState()
	if !state.NeedsSetup {
		t.Fatalf("GetSetupState = %+v", state)
	}

	state, err := service.SaveInitialConfig(SetupInput{
		MachineID: "test-pc",
		Hub:       "http://127.0.0.1:8787",
		Token:     "token-abc",
		Mounts:    []SetupMountInput{{ID: "data", Path: firstMount}},
	})
	if err != nil {
		t.Fatalf("SaveInitialConfig: %v", err)
	}
	if state.NeedsSetup || controller.cfg == nil || controller.cfg.Agent.Token != "token-abc" {
		t.Fatalf("unexpected controller config: %+v", controller.cfg)
	}
	if _, err := os.Stat(configPath); err != nil {
		t.Fatalf("config not written: %v", err)
	}

	settings, err := service.SaveSettings(SettingsInput{
		Label: "edited",
		Mounts: []SettingsMountInput{
			{ID: "data", Path: firstMount},
			{ID: "photos", Path: secondMount, Sentinel: ".observer-mount"},
		},
	})
	if err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	if len(settings.Mounts) != 2 || controller.cfg == nil || len(controller.cfg.Mounts) != 2 {
		t.Fatalf("settings not applied: %+v controller=%+v", settings, controller.cfg)
	}
	if settings.Label != "edited" {
		t.Fatalf("label = %q", settings.Label)
	}
	loaded, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.Agent.Token != "token-abc" || len(loaded.Mounts) != 2 {
		t.Fatalf("unexpected reloaded config: %+v", loaded.Agent)
	}
}
