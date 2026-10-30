package main

import (
	"errors"
	"sync"
)

// ConfigService 暴露给前端：首次配置向导与设置页。
type ConfigService struct {
	mu         sync.Mutex
	controller *controller
	manager    *setupManager
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
