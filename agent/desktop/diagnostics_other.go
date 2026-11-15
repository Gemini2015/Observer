//go:build !windows

package main

// showErrorDialog 在非 Windows 平台只写日志，不弹系统框。
func showErrorDialog(title, message string) {
	_, _ = title, message
}
