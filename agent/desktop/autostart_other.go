//go:build !windows

package main

// 非 Windows 平台暂不支持开机启动（macOS LaunchAgent 在 M4 处理）。
func autostartEnabled() bool { return false }

func setAutostart(enabled bool, configPath string) error { return nil }
