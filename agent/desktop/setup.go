package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"observer/agent/internal/config"
)

var machineIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// SetupMountInput 是首次向导中的挂载点输入。
type SetupMountInput struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Path          string   `json:"path"`
	Sentinel      string   `json:"sentinel"`
	Exclude       []string `json:"exclude"`
	RepairAllowed bool     `json:"repair_allowed"`
}

// SetupInput 是首次向导提交的配置。
type SetupInput struct {
	MachineID string            `json:"machine_id"`
	Label     string            `json:"label"`
	Hub       string            `json:"hub"`
	Token     string            `json:"token"`
	StateDir  string            `json:"state_dir"`
	Mounts    []SetupMountInput `json:"mounts"`
}

// SetupDefaults 是向导的初始默认值。
type SetupDefaults struct {
	MachineID string `json:"machine_id"`
	Label     string `json:"label"`
	Hub       string `json:"hub"`
}

// SetupState 描述当前是否需要首次配置。
type SetupState struct {
	NeedsSetup bool          `json:"needs_setup"`
	ConfigPath string        `json:"config_path"`
	Error      string        `json:"error"`
	Existing   bool          `json:"existing"`
	Defaults   SetupDefaults `json:"defaults"`
	Prefill    *SetupInput   `json:"prefill,omitempty"`
}

// SettingsMountInput 是设置页可编辑的挂载点字段（ID 只读）。
type SettingsMountInput struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Path          string   `json:"path"`
	Sentinel      string   `json:"sentinel"`
	Exclude       []string `json:"exclude"`
	RepairAllowed bool     `json:"repair_allowed"`
}

// SettingsInput 是设置页提交的修改。
type SettingsInput struct {
	Label  string               `json:"label"`
	Mounts []SettingsMountInput `json:"mounts"`
}

// SettingsState 是设置页的当前值。
type SettingsState struct {
	ConfigPath string               `json:"config_path"`
	MachineID  string               `json:"machine_id"`
	Hub        string               `json:"hub"`
	StateDir   string               `json:"state_dir"`
	Label      string               `json:"label"`
	Mounts     []SettingsMountInput `json:"mounts"`
}

type setupAgentYAML struct {
	MachineID string `yaml:"machine_id"`
	Label     string `yaml:"label,omitempty"`
	Hub       string `yaml:"hub"`
	Token     string `yaml:"token"`
	StateDir  string `yaml:"state_dir,omitempty"`
}

type setupMountYAML struct {
	ID            string   `yaml:"id"`
	Label         string   `yaml:"label,omitempty"`
	Path          string   `yaml:"path"`
	Sentinel      string   `yaml:"sentinel,omitempty"`
	Exclude       []string `yaml:"exclude,omitempty"`
	RepairAllowed bool     `yaml:"repair_allowed,omitempty"`
}

type setupConfigYAML struct {
	Agent  setupAgentYAML   `yaml:"agent"`
	Mounts []setupMountYAML `yaml:"mounts"`
}

func defaultSetupDefaults() SetupDefaults {
	hostname, _ := os.Hostname()
	machineID := sanitizeMachineID(hostname)
	label := strings.TrimSpace(hostname)
	if label == "" {
		label = "Windows PC"
	}
	return SetupDefaults{
		MachineID: machineID,
		Label:     label,
		Hub:       "http://127.0.0.1:8787",
	}
}

func sanitizeMachineID(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = regexp.MustCompile(`[^a-z0-9_-]+`).ReplaceAllString(value, "-")
	value = strings.Trim(value, "-_")
	if len(value) > 32 {
		value = value[:32]
	}
	if value == "" || !regexp.MustCompile(`^[a-z0-9]`).MatchString(value) {
		value = "pc-" + value
	}
	if len(value) > 32 {
		value = value[:32]
	}
	if !machineIDPattern.MatchString(value) {
		return "win-01"
	}
	return value
}

func isPlaceholderToken(token string) bool {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return true
	}
	lower := strings.ToLower(trimmed)
	if lower == "paste-token-here" || lower == "placeholder-token" || lower == "change-me" {
		return true
	}
	return strings.HasPrefix(trimmed, "<") && strings.HasSuffix(trimmed, ">")
}

func hasUsableTokenFile(path string) bool {
	if path == "" {
		return false
	}
	data, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(data)) != ""
}

func isConfigured(cfg *config.Config) bool {
	token := strings.TrimSpace(cfg.Agent.Token)
	if token != "" && !isPlaceholderToken(token) {
		return true
	}
	if hasUsableTokenFile(filepath.Join(cfg.Agent.StateDir, "agent.token")) {
		return true
	}
	if hasUsableTokenFile(cfg.Agent.TokenFile) {
		return true
	}
	return strings.TrimSpace(os.Getenv("OBSERVER_ENROLL_TOKEN")) != ""
}

// assessConfig 判断配置是否可加载、是否已经完成配置。
func assessConfig(path string) (*config.Config, SetupState) {
	state := SetupState{
		ConfigPath: path,
		Defaults:   defaultSetupDefaults(),
	}
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		state.Existing = true
	}

	cfg, err := config.Load(path)
	if err != nil {
		state.NeedsSetup = true
		// 首次使用（文件不存在）不把系统错误显示在向导上。
		if errors.Is(err, os.ErrNotExist) {
			state.Error = ""
		} else {
			state.Error = err.Error()
		}
		return nil, state
	}
	if !isConfigured(cfg) {
		state.NeedsSetup = true
		state.Error = "尚未配置注册 token（请在 hub Web 生成后填入）"
		state.Prefill = prefillFromConfig(cfg)
		return nil, state
	}
	return cfg, state
}

func prefillFromConfig(cfg *config.Config) *SetupInput {
	input := &SetupInput{
		MachineID: cfg.Agent.MachineID,
		Label:     cfg.Agent.Label,
		Hub:       cfg.Agent.Hub,
		Token:     cfg.Agent.Token,
		StateDir:  cfg.Agent.StateDir,
		Mounts:    make([]SetupMountInput, 0, len(cfg.Mounts)),
	}
	for _, mount := range cfg.Mounts {
		input.Mounts = append(input.Mounts, SetupMountInput{
			ID:            mount.ID,
			Label:         mount.Label,
			Path:          mount.Path,
			Sentinel:      mount.Sentinel,
			Exclude:       append([]string(nil), mount.Exclude...),
			RepairAllowed: mount.RepairAllowed != nil && *mount.RepairAllowed,
		})
	}
	return input
}

var defaultExclude = []string{"**/.observer-mount", "**/.observer-quarantine/**"}

func validateHubURL(raw string) (string, error) {
	hub := strings.TrimSpace(raw)
	parsed, err := url.Parse(hub)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("hub 地址必须是 http(s) URL")
	}
	return hub, nil
}

func cleanExclude(values []string) []string {
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			cleaned = append(cleaned, value)
		}
	}
	if len(cleaned) == 0 {
		return append([]string(nil), defaultExclude...)
	}
	return cleaned
}

func validateSentinel(sentinel string) (string, error) {
	sentinel = strings.TrimSpace(sentinel)
	if sentinel == "" {
		// 未配置 sentinel = 不启用挂载守卫（扫描整个目录）。
		return "", nil
	}
	slashed := filepath.ToSlash(sentinel)
	if strings.HasPrefix(slashed, "/") || strings.Contains(slashed, "..") {
		return "", errors.New("sentinel 必须是 mount 内的相对路径")
	}
	return sentinel, nil
}

func validateMountPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("挂载点目录不能为空")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("目录不可访问: %v", err)
	}
	if !info.IsDir() {
		return "", errors.New("挂载点必须是目录")
	}
	return path, nil
}

// validateInitial 校验首次配置并生成 YAML。
func validateInitial(input SetupInput) ([]byte, error) {
	machineID := strings.TrimSpace(input.MachineID)
	if !machineIDPattern.MatchString(machineID) {
		return nil, fmt.Errorf("机器 ID 必须匹配 %s", machineIDPattern)
	}
	hub, err := validateHubURL(input.Hub)
	if err != nil {
		return nil, err
	}
	token := strings.TrimSpace(input.Token)
	if isPlaceholderToken(token) {
		return nil, errors.New("请填写 hub Web 生成的注册 token")
	}
	if len(input.Mounts) == 0 {
		return nil, errors.New("至少需要一个挂载点")
	}

	stateDir := strings.TrimSpace(input.StateDir)
	if stateDir == "" {
		stateDir = filepath.Join(".observer", machineID)
	}

	seen := make(map[string]struct{}, len(input.Mounts))
	mounts := make([]setupMountYAML, 0, len(input.Mounts))
	for _, mount := range input.Mounts {
		id := strings.TrimSpace(mount.ID)
		if !machineIDPattern.MatchString(id) {
			return nil, fmt.Errorf("挂载点 ID %q 必须匹配 %s", id, machineIDPattern)
		}
		if _, exists := seen[id]; exists {
			return nil, fmt.Errorf("挂载点 ID 重复: %s", id)
		}
		seen[id] = struct{}{}
		path, err := validateMountPath(mount.Path)
		if err != nil {
			return nil, fmt.Errorf("挂载点 %s: %w", id, err)
		}
		sentinel, err := validateSentinel(mount.Sentinel)
		if err != nil {
			return nil, fmt.Errorf("挂载点 %s: %w", id, err)
		}
		mounts = append(mounts, setupMountYAML{
			ID:            id,
			Label:         strings.TrimSpace(mount.Label),
			Path:          path,
			Sentinel:      sentinel,
			Exclude:       cleanExclude(mount.Exclude),
			RepairAllowed: mount.RepairAllowed,
		})
	}

	data, err := yaml.Marshal(setupConfigYAML{
		Agent: setupAgentYAML{
			MachineID: machineID,
			Label:     strings.TrimSpace(input.Label),
			Hub:       hub,
			Token:     token,
			StateDir:  stateDir,
		},
		Mounts: mounts,
	})
	if err != nil {
		return nil, err
	}
	if _, err := config.Parse(data); err != nil {
		return nil, fmt.Errorf("配置校验失败: %w", err)
	}
	return data, nil
}

func settingsFromConfig(cfg *config.Config) SettingsState {
	state := SettingsState{
		MachineID: cfg.Agent.MachineID,
		Hub:       cfg.Agent.Hub,
		StateDir:  cfg.Agent.StateDir,
		Label:     cfg.Agent.Label,
		Mounts:    make([]SettingsMountInput, 0, len(cfg.Mounts)),
	}
	for _, mount := range cfg.Mounts {
		state.Mounts = append(state.Mounts, SettingsMountInput{
			ID:            mount.ID,
			Label:         mount.Label,
			Path:          mount.Path,
			Sentinel:      mount.Sentinel,
			Exclude:       append([]string(nil), mount.Exclude...),
			RepairAllowed: mount.RepairAllowed != nil && *mount.RepairAllowed,
		})
	}
	return state
}

// buildSettingsYAML 在现有 YAML 上只修改可编辑字段（保留 limits/schedule 等高级字段）。
func buildSettingsYAML(current []byte, input SettingsInput) ([]byte, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(current, &doc); err != nil {
		return nil, fmt.Errorf("解析现有配置失败: %w", err)
	}
	agentMap, ok := doc["agent"].(map[string]any)
	if !ok {
		return nil, errors.New("现有配置缺少 agent 段")
	}
	agentMap["label"] = strings.TrimSpace(input.Label)

	currentMounts, _ := doc["mounts"].([]any)
	byID := make(map[string]map[string]any, len(currentMounts))
	for _, raw := range currentMounts {
		mountMap, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, ok := mountMap["id"].(string); ok {
			byID[id] = mountMap
		}
	}
	if len(input.Mounts) == 0 {
		return nil, errors.New("至少需要一个挂载点")
	}

	seen := make(map[string]struct{}, len(input.Mounts))
	nextMounts := make([]any, 0, len(input.Mounts))
	for _, mount := range input.Mounts {
		id := strings.TrimSpace(mount.ID)
		if !machineIDPattern.MatchString(id) {
			return nil, fmt.Errorf("挂载点 ID %q 必须匹配 %s", id, machineIDPattern)
		}
		if _, exists := seen[id]; exists {
			return nil, fmt.Errorf("挂载点 ID 重复: %s", id)
		}
		seen[id] = struct{}{}
		path, err := validateMountPath(mount.Path)
		if err != nil {
			return nil, fmt.Errorf("挂载点 %s: %w", id, err)
		}
		sentinel, err := validateSentinel(mount.Sentinel)
		if err != nil {
			return nil, fmt.Errorf("挂载点 %s: %w", id, err)
		}

		mountMap := byID[id]
		if mountMap == nil {
			mountMap = map[string]any{"id": id}
		}
		mountMap["id"] = id
		mountMap["label"] = strings.TrimSpace(mount.Label)
		mountMap["path"] = path
		mountMap["sentinel"] = sentinel
		mountMap["exclude"] = stringSliceToAny(cleanExclude(mount.Exclude))
		mountMap["repair_allowed"] = mount.RepairAllowed
		nextMounts = append(nextMounts, mountMap)
	}
	doc["mounts"] = nextMounts

	data, err := yaml.Marshal(doc)
	if err != nil {
		return nil, err
	}
	if _, err := config.Parse(data); err != nil {
		return nil, fmt.Errorf("配置校验失败: %w", err)
	}
	return data, nil
}

func stringSliceToAny(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func writeConfigFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	if existing, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", existing, 0o600); err != nil {
			return fmt.Errorf("备份旧配置失败: %w", err)
		}
	}
	tmp, err := os.CreateTemp(dir, ".agent.yaml-*.tmp")
	if err != nil {
		return fmt.Errorf("写入配置失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入配置失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_ = os.Remove(path)
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("保存配置失败: %w", err)
	}
	return nil
}

type setupManager struct {
	configPath string
}

func newSetupManager(configPath string) *setupManager {
	return &setupManager{configPath: configPath}
}

func (m *setupManager) GetState() SetupState {
	_, state := assessConfig(m.configPath)
	return state
}

func (m *setupManager) SaveInitial(input SetupInput) (*config.Config, SetupState, error) {
	state := m.GetState()
	if !state.NeedsSetup {
		return nil, state, errors.New("配置已完成，无需重新初始化")
	}
	data, err := validateInitial(input)
	if err != nil {
		return nil, state, err
	}
	if err := writeConfigFile(m.configPath, data); err != nil {
		return nil, state, err
	}
	cfg, err := config.Load(m.configPath)
	if err != nil {
		return nil, state, fmt.Errorf("配置已写入但回读失败: %w", err)
	}
	state.NeedsSetup = false
	state.Error = ""
	state.Prefill = nil
	state.Existing = true
	state.ConfigPath = m.configPath
	state.Defaults = defaultSetupDefaults()
	return cfg, state, nil
}

func (m *setupManager) GetSettings() (SettingsState, error) {
	cfg, err := config.Load(m.configPath)
	if err != nil {
		return SettingsState{}, err
	}
	state := settingsFromConfig(cfg)
	state.ConfigPath = m.configPath
	return state, nil
}

func (m *setupManager) SaveSettings(input SettingsInput) (*config.Config, error) {
	current, err := os.ReadFile(m.configPath)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}
	data, err := buildSettingsYAML(current, input)
	if err != nil {
		return nil, err
	}
	if err := writeConfigFile(m.configPath, data); err != nil {
		return nil, err
	}
	cfg, err := config.Load(m.configPath)
	if err != nil {
		return nil, fmt.Errorf("配置已写入但回读失败: %w", err)
	}
	return cfg, nil
}
