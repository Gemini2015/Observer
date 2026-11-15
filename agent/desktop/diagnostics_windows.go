//go:build windows

package main

import "golang.org/x/sys/windows"

// showErrorDialog 在 Windows 上弹系统错误框；windowsgui 构建没有控制台，这是唯一可见的错误出口。
func showErrorDialog(title, message string) {
	titlePointer, titleErr := windows.UTF16PtrFromString(title)
	messagePointer, messageErr := windows.UTF16PtrFromString(message)
	if titleErr != nil || messageErr != nil {
		return
	}
	_, _ = windows.MessageBox(
		0,
		messagePointer,
		titlePointer,
		windows.MB_OK|windows.MB_ICONERROR|windows.MB_SETFOREGROUND|windows.MB_TOPMOST,
	)
}
