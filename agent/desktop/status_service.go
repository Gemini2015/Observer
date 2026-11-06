package main

import "errors"

// GetStatus 返回当前状态快照，供窗口初次加载与操作后刷新。
func (s *ConfigService) GetStatus() Status {
	if s.controller == nil {
		return Status{}
	}
	return s.controller.snapshot()
}

// SetPaused 切换暂停状态；当前正在执行的巡检会在本轮结束后停下。
func (s *ConfigService) SetPaused(paused bool) Status {
	if s.controller == nil {
		return Status{}
	}
	s.controller.setPaused(paused)
	return s.controller.snapshot()
}

// ScanNow 请求立即向 hub 拉取任务；未初始化、已暂停或正在巡检时返回错误。
func (s *ConfigService) ScanNow() (Status, error) {
	if s.controller == nil {
		return Status{}, errors.New("desktop controller 未初始化")
	}
	if err := s.controller.scanNow(); err != nil {
		return s.controller.snapshot(), err
	}
	return s.controller.snapshot(), nil
}

// SetAutostart 设置开机启动（非 Windows 平台为 no-op）。
func (s *ConfigService) SetAutostart(enabled bool) (Status, error) {
	if s.controller == nil {
		return Status{}, errors.New("desktop controller 未初始化")
	}
	if err := s.controller.setAutostart(enabled); err != nil {
		return s.controller.snapshot(), err
	}
	return s.controller.snapshot(), nil
}

// OpenConfigFolder 用系统文件管理器打开配置文件所在目录。
func (s *ConfigService) OpenConfigFolder() error {
	if s.controller == nil {
		return errors.New("desktop controller 未初始化")
	}
	return s.controller.openConfigFolder()
}

// QuitApp 退出整个应用（包括托盘）。
func (s *ConfigService) QuitApp() {
	if s.controller == nil {
		return
	}
	s.controller.quit()
}
