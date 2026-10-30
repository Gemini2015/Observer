package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"observer/agent/internal/hubclient"
	"observer/agent/internal/version"
)

// ProbeInput 是“识别已有节点”的输入。
type ProbeInput struct {
	Hub   string `json:"hub"`
	Token string `json:"token"`
}

// ProbeResult 是 hub 上已有节点的身份与挂载点配置。
type ProbeResult struct {
	MachineID string            `json:"machine_id"`
	Label     string            `json:"label"`
	Hostname  string            `json:"hostname"`
	Mounts    []SetupMountInput `json:"mounts"`
}

// ConfigService 暴露给前端：首次配置向导与设置页。
type ConfigService struct {
	mu         sync.Mutex
	controller *controller
	manager    *setupManager
}

// ProbeExistingNode 用接入 token 校验并读取已有节点信息（不写配置）。
func (s *ConfigService) ProbeExistingNode(input ProbeInput) (ProbeResult, error) {
	hub, err := validateHubURL(input.Hub)
	if err != nil {
		return ProbeResult{}, err
	}
	token := strings.TrimSpace(input.Token)
	if isPlaceholderToken(token) {
		return ProbeResult{}, errors.New("请填写 hub Web 机器页生成的接入 token")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := hubclient.New(hub, version.Version)
	identity, err := client.Identity(ctx, token)
	if err != nil {
		if hubclient.IsUnauthorized(err) {
			return ProbeResult{}, errors.New("接入 token 无效或已失效，请在 hub 机器页重新生成")
		}
		return ProbeResult{}, fmt.Errorf("连接 hub 失败: %w", err)
	}

	result := ProbeResult{
		MachineID: identity.MachineID,
		Label:     identity.Label,
		Hostname:  identity.Hostname,
		Mounts:    make([]SetupMountInput, 0, len(identity.Mounts)),
	}
	for _, mount := range identity.Mounts {
		result.Mounts = append(result.Mounts, SetupMountInput{
			ID:            mount.MountID,
			Label:         mount.Label,
			Path:          mount.PhysicalPath,
			Sentinel:      mount.Sentinel,
			Exclude:       append([]string(nil), mount.Exclude...),
			RepairAllowed: mount.RepairAllowed,
		})
	}
	return result, nil
}

func (s *ConfigService) GetSetupState() SetupState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.manager.GetState()
}

func (s *ConfigService) SaveInitialConfig(input SetupInput) (SetupState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.manager.GetState()
	if !state.NeedsSetup {
		return state, errors.New("配置已完成，无需重新初始化")
	}
	cfg, newState, err := s.manager.SaveInitial(input)
	if err != nil {
		return state, err
	}
	s.controller.applyConfig(cfg, newState)
	return newState, nil
}

func (s *ConfigService) GetSettings() (SettingsState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.manager.GetSettings()
}

func (s *ConfigService) SaveSettings(input SettingsInput) (SettingsState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, err := s.manager.SaveSettings(input)
	if err != nil {
		return SettingsState{}, err
	}
	state := SetupState{
		NeedsSetup: false,
		ConfigPath: s.manager.configPath,
		Defaults:   defaultSetupDefaults(),
	}
	s.controller.applyConfig(cfg, state)
	return s.manager.GetSettings()
}
