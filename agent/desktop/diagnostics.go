package main

import (
	"errors"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var (
	// startupDone 在窗口首次显示后置位：此前的 Wails 错误按“启动失败”处理并弹框，
	// 之后的错误只写日志（FatalError 除外），避免运行期可恢复错误打扰用户。
	startupDone atomic.Bool
	// fatalDialogOnce 保证一次启动只弹一个错误框。
	fatalDialogOnce sync.Once
	// logPath 是本次启动的日志文件路径；初始化失败时为空。
	logPath string
)

// initDiagnostics 在 main 最早期初始化文件日志。
// windowsgui 生产构建没有可见的 stderr，因此必须把日志落到文件，
// 否则 Wails / agent 的错误在双击启动时完全不可见。
func initDiagnostics() (io.Writer, func()) {
	path := diagnosticsLogPath()
	if path == "" {
		log.SetOutput(io.Discard)
		return io.Discard, func() {}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.SetOutput(io.Discard)
		return io.Discard, func() {}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.SetOutput(io.Discard)
		return io.Discard, func() {}
	}
	log.SetOutput(file)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	logPath = path
	return file, func() { _ = file.Close() }
}

// diagnosticsLogPath 返回可写的日志路径；用户缓存目录不可用时回退到 exe 同目录。
func diagnosticsLogPath() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "Observer", "observer-agent-desktop.log")
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(executable), "observer-agent-desktop.log")
}

// wailsLogger 把 Wails 系统日志写入与 agent 相同的日志文件。
func wailsLogger(writer io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// fatalStartup 用于应用创建前的致命错误：写日志、弹框、退出。
func fatalStartup(err error) {
	if err == nil {
		return
	}
	reportFatalError(err)
	os.Exit(1)
}

// shouldShowStartupError 判断错误是否需要弹框：所有 FatalError，以及窗口显示前的任何错误。
func shouldShowStartupError(err error) bool {
	if err == nil {
		return false
	}
	var fatal *application.FatalError
	if errors.As(err, &fatal) {
		return true
	}
	return !startupDone.Load()
}

// reportFatalError 记录错误并在桌面端弹框说明（非 Windows 只写日志）。
func reportFatalError(err error) {
	if err == nil {
		return
	}
	log.Printf("桌面端错误: %v", err)
	fatalDialogOnce.Do(func() {
		title := "Observer Agent 启动失败"
		if startupDone.Load() {
			title = "Observer Agent 遇到错误"
		}
		showErrorDialog(title, errorMessage(err))
	})
}

// errorMessage 把底层错误转换成用户可执行的说明。
func errorMessage(err error) string {
	detail := err.Error()
	lower := strings.ToLower(detail)
	if strings.Contains(lower, "webview2") || strings.Contains(lower, "webview") {
		return "未检测到可用的 Microsoft Edge WebView2 Runtime。\n\n" +
			"请安装后重新启动 Observer Agent：\n" +
			"https://developer.microsoft.com/microsoft-edge/webview2/\n\n" +
			"Windows 10 1803+ 与 Windows 11 通常已内置；若是精简系统或 Windows Server，请手动安装 Evergreen Runtime。" +
			errorDetail(detail)
	}
	return "Observer Agent 运行时遇到错误并退出。\n\n" +
		"请查看日志文件获取详细信息；如问题可复现，请附上日志。" +
		errorDetail(detail)
}

// errorDetail 追加日志路径与技术错误，便于用户反馈问题。
func errorDetail(detail string) string {
	var builder strings.Builder
	if logPath != "" {
		builder.WriteString("\n\n日志：")
		builder.WriteString(logPath)
	}
	builder.WriteString("\n\n技术信息：")
	builder.WriteString(detail)
	return builder.String()
}
