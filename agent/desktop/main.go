// observer-agent-desktop：Observer agent 的桌面客户端（Wails v3）。
package main

import (
	"context"
	"embed"
	"flag"
	"log"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	agentcore "observer/agent/internal/agent"
	"observer/agent/internal/config"
	"observer/agent/internal/scan"
	"observer/agent/internal/version"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var trayIcon []byte

// RunSummary 是前端展示的一轮巡检统计。
type RunSummary struct {
	Seen       int   `json:"seen"`
	Hashed     int64 `json:"hashed"`
	Skipped    int   `json:"skipped"`
	Unreadable int   `json:"unreadable"`
	Unstable   int   `json:"unstable"`
	BytesRead  int64 `json:"bytes_read"`
	Batches    int   `json:"batches"`
	DurationMs int64 `json:"duration_ms"`
}

// Status 通过 Wails 事件推送给前端。
type Status struct {
	MachineID string      `json:"machine_id"`
	Hub       string      `json:"hub"`
	Paused    bool        `json:"paused"`
	Running   bool        `json:"running"`
	Connected bool        `json:"connected"`
	LastError string      `json:"last_error"`
	LastRunAt int64       `json:"last_run_at"`
	LastStats *RunSummary `json:"last_stats"`
}

type controller struct {
	mu     sync.Mutex
	status Status
	cfg    *config.Config
	runner *agentcore.Runner
	app    *application.App
	window *application.WebviewWindow
	paused bool
}

func init() {
	application.RegisterEvent[Status]("status")
}

func main() {
	configPath := flag.String("config", "observer-agent.yaml", "agent 配置文件路径")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	c := &controller{
		cfg:    cfg,
		status: Status{MachineID: cfg.Agent.MachineID, Hub: cfg.Agent.Hub},
	}

	var cancel context.CancelFunc

	app := application.New(application.Options{
		Name:        "Observer Agent",
		Description: "Observer 文件完整性巡检客户端",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.observer.agent.desktop",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if c.window != nil {
					c.window.Show()
					c.window.Focus()
				}
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		OnShutdown: func() {
			if cancel != nil {
				cancel()
			}
		},
	})
	c.app = app

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Observer Agent",
		Width:            900,
		Height:           660,
		BackgroundColour: application.NewRGB(15, 23, 42),
		URL:              "/",
	})
	c.window = window
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		window.Hide()
	})

	tray := app.SystemTray.New()
	tray.SetIcon(trayIcon)
	tray.SetLabel("Observer Agent")
	tray.AttachWindow(window)
	tray.WindowOffset(10)

	menu := app.NewMenu()
	menu.Add("打开界面").OnClick(func(ctx *application.Context) {
		window.Show()
		window.Focus()
	})
	menu.Add("打开 hub Web").OnClick(func(ctx *application.Context) {
		if err := openBrowser(cfg.Agent.Hub); err != nil {
			log.Printf("打开浏览器失败: %v", err)
		}
	})
	pauseItem := menu.Add("暂停巡检")
	pauseItem.OnClick(func(ctx *application.Context) {
		c.mu.Lock()
		c.paused = !c.paused
		paused := c.paused
		c.mu.Unlock()
		if paused {
			pauseItem.SetLabel("继续巡检")
		} else {
			pauseItem.SetLabel("暂停巡检")
		}
		menu.Update()
	})
	menu.AddSeparator()
	autostartItem := menu.AddCheckbox("开机启动", autostartEnabled())
	autostartItem.OnClick(func(ctx *application.Context) {
		enabled := ctx.ClickedMenuItem().Checked()
		if err := setAutostart(enabled); err != nil {
			log.Printf("设置开机启动失败: %v", err)
		}
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		app.Quit()
	})
	tray.SetMenu(menu)

	ctx, cancel := context.WithCancel(context.Background())
	go c.start(ctx)
	go c.emitLoop(ctx)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// start 在 Wails 应用启动后再初始化 runner（避免第二个实例争抢 SQLite 锁）。
func (c *controller) start(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(500 * time.Millisecond):
	}

	runner, err := agentcore.New(c.cfg, version.Version)
	if err != nil {
		c.mu.Lock()
		c.status.LastError = err.Error()
		c.mu.Unlock()
		log.Printf("初始化 agent 失败: %v", err)
		return
	}
	defer runner.Close()

	c.mu.Lock()
	c.runner = runner
	c.mu.Unlock()

	c.runLoop(ctx)
}

func (c *controller) runLoop(ctx context.Context) {
	const interval = 5 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}

		c.mu.Lock()
		paused := c.paused
		c.mu.Unlock()

		c.mu.Lock()
		runner := c.runner
		c.mu.Unlock()
		if runner == nil {
			return
		}

		if !paused {
			c.mu.Lock()
			c.status.Running = true
			c.mu.Unlock()

			stats, err := runner.RunOnce(ctx)

			c.mu.Lock()
			c.status.Running = false
			c.status.LastRunAt = time.Now().UnixMilli()
			if err != nil {
				c.status.Connected = false
				c.status.LastError = err.Error()
			} else {
				c.status.Connected = true
				c.status.LastError = ""
				c.status.LastStats = summarize(stats)
			}
			c.mu.Unlock()
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func (c *controller) emitLoop(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	c.emit()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.emit()
		}
	}
}

func (c *controller) emit() {
	if c.app == nil {
		return
	}
	c.mu.Lock()
	snapshot := c.status
	c.mu.Unlock()
	c.app.Event.Emit("status", snapshot)
}

func summarize(stats scan.Stats) *RunSummary {
	return &RunSummary{
		Seen:       stats.Seen,
		Hashed:     stats.Hashed,
		Skipped:    stats.Skipped,
		Unreadable: stats.Unreadable,
		Unstable:   stats.Unstable,
		BytesRead:  stats.BytesRead,
		Batches:    stats.Batches,
		DurationMs: stats.DurationMs,
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
