// observer-agent-desktop：Observer agent 的桌面客户端（Wails v3）。
package main

import (
	"context"
	"embed"
	"flag"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	agentcore "observer/agent/internal/agent"
	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
	"observer/agent/internal/scan"
	"observer/agent/internal/version"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/trayicon.png
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
	MachineID  string                 `json:"machine_id"`
	Hub        string                 `json:"hub"`
	Paused     bool                   `json:"paused"`
	Running    bool                   `json:"running"`
	Connected  bool                   `json:"connected"`
	LastError  string                 `json:"last_error"`
	LastRunAt  int64                  `json:"last_run_at"`
	LastStats  *RunSummary            `json:"last_stats"`
	Current    *agentcore.CurrentJob  `json:"current"`
	RecentJobs []hubclient.JobSummary `json:"recent_jobs"`
}

type controller struct {
	mu     sync.Mutex
	status Status
	cfg    *config.Config
	runner *agentcore.Runner
	app    *application.App
	window *application.WebviewWindow
	paused bool

	configPath    string
	setup         SetupState
	appCtx        context.Context
	runnerCancel  context.CancelFunc
	runnerDone    chan struct{}
	runnerStarted bool
}

func init() {
	application.RegisterEvent[Status]("status")
	application.RegisterEvent[SetupState]("setup")
}

func main() {
	configPath := flag.String("config", "", "配置文件路径（默认：exe 同级目录下的 agent.yaml）")
	flag.Parse()

	resolved := *configPath
	if resolved == "" {
		executable, exeErr := os.Executable()
		if exeErr != nil {
			log.Fatalf("定位程序路径失败: %v", exeErr)
		}
		resolved = filepath.Join(filepath.Dir(executable), "agent.yaml")
	}
	absoluteConfig, err := filepath.Abs(resolved)
	if err != nil {
		log.Fatalf("解析配置路径失败: %v", err)
	}
	// 让配置中的相对路径（token_file/state_dir/mounts）相对配置文件目录解析。
	if err := os.Chdir(filepath.Dir(absoluteConfig)); err != nil {
		log.Printf("切换配置目录失败（将使用当前目录）: %v", err)
	}

	cfg, setupState := assessConfig(absoluteConfig)

	c := &controller{
		cfg:        cfg,
		configPath: absoluteConfig,
		setup:      setupState,
	}
	if cfg != nil {
		c.status = Status{MachineID: cfg.Agent.MachineID, Hub: cfg.Agent.Hub}
	}

	var cancel context.CancelFunc

	windowTitle := "Observer Agent"
	if setupState.NeedsSetup {
		windowTitle = "Observer Agent（首次配置）"
	}

	app := application.New(application.Options{
		Name:        "Observer Agent",
		Description: "Observer 文件完整性巡检客户端",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Services: []application.Service{
			application.NewService(&ConfigService{
				controller: c,
				manager:    newSetupManager(absoluteConfig),
			}),
			application.NewService(&FileService{controller: c}),
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
		Title:            windowTitle,
		Width:            1100,
		Height:           800,
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
		hub := c.currentHub()
		if hub == "" {
			window.Show()
			window.Focus()
			return
		}
		if err := openBrowser(hub); err != nil {
			log.Printf("打开浏览器失败: %v", err)
		}
	})
	pauseItem := menu.Add("暂停巡检")
	pauseItem.OnClick(func(ctx *application.Context) {
		c.mu.Lock()
		runnerReady := c.runner != nil
		c.mu.Unlock()
		if !runnerReady {
			window.Show()
			window.Focus()
			return
		}
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
		if err := setAutostart(enabled, absoluteConfig); err != nil {
			log.Printf("设置开机启动失败: %v", err)
		}
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		app.Quit()
	})
	tray.SetMenu(menu)

	ctx, cancel := context.WithCancel(context.Background())
	c.appCtx = ctx
	go c.emitLoop(ctx)
	if cfg != nil && !setupState.NeedsSetup {
		c.startRunner(ctx)
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
	cancel()
	c.stopRunner()
}

func (c *controller) currentHub() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cfg == nil {
		return ""
	}
	return c.cfg.Agent.Hub
}

// startRunner 启动一个新的 runner（设置保存后也会调用）。
func (c *controller) startRunner(parent context.Context) {
	c.mu.Lock()
	if c.runnerStarted || c.cfg == nil || parent == nil {
		c.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	c.runnerStarted = true
	c.runnerCancel = cancel
	c.runnerDone = done
	c.mu.Unlock()

	go c.start(runCtx, done)
}

func (c *controller) stopRunner() {
	c.mu.Lock()
	cancel := c.runnerCancel
	done := c.runnerDone
	c.runnerCancel = nil
	c.runnerDone = nil
	c.runnerStarted = false
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			log.Printf("等待旧 runner 关闭超时")
		}
	}

	c.mu.Lock()
	c.runner = nil
	c.status.Running = false
	c.mu.Unlock()
}

func (c *controller) restartRunner() {
	c.stopRunner()
	c.mu.Lock()
	parent := c.appCtx
	c.mu.Unlock()
	if parent != nil {
		c.startRunner(parent)
	}
}

// applyConfig 在首次保存或设置保存后应用新配置并（重）启动 runner。
func (c *controller) applyConfig(cfg *config.Config, state SetupState) {
	c.mu.Lock()
	c.cfg = cfg
	c.setup = state
	c.status.MachineID = cfg.Agent.MachineID
	c.status.Hub = cfg.Agent.Hub
	c.status.LastError = ""
	c.status.Connected = false
	parent := c.appCtx
	started := c.runnerStarted
	c.mu.Unlock()

	if c.window != nil {
		c.window.SetTitle("Observer Agent")
	}
	if c.app != nil {
		c.app.Event.Emit("setup", state)
	}
	if started {
		c.restartRunner()
		return
	}
	if parent != nil {
		c.startRunner(parent)
	}
}

// start 在 Wails 应用启动后再初始化 runner（避免第二个实例争抢 SQLite 锁）。
func (c *controller) start(ctx context.Context, done chan struct{}) {
	defer close(done)
	select {
	case <-ctx.Done():
		return
	case <-time.After(500 * time.Millisecond):
	}

	c.mu.Lock()
	cfg := c.cfg
	c.mu.Unlock()
	if cfg == nil {
		return
	}

	runner, err := agentcore.New(cfg, version.Version)
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
	defer func() {
		c.mu.Lock()
		if c.runner == runner {
			c.runner = nil
		}
		c.mu.Unlock()
	}()

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

		// 任务历史独立于暂停状态刷新；失败时保留旧值。
		if jobs, err := runner.RecentJobs(ctx, 20); err == nil {
			c.mu.Lock()
			c.status.RecentJobs = jobs
			c.mu.Unlock()
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
	runner := c.runner
	c.mu.Unlock()
	if runner != nil {
		snapshot.Current = runner.CurrentJob()
	}
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
