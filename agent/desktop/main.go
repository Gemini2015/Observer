// observer-agent-desktop：Observer agent 的桌面客户端（Wails v3）。
package main

import (
	"context"
	"embed"
	"errors"
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
	MachineID          string                 `json:"machine_id"`
	Hub                string                 `json:"hub"`
	Version            string                 `json:"version"`
	Paused             bool                   `json:"paused"`
	Running            bool                   `json:"running"`
	Connected          bool                   `json:"connected"`
	LastError          string                 `json:"last_error"`
	LastErrorAt        int64                  `json:"last_error_at"`
	LastOkAt           int64                  `json:"last_ok_at"`
	LastRunAt          int64                  `json:"last_run_at"`
	LastStats          *RunSummary            `json:"last_stats"`
	Current            *agentcore.CurrentJob  `json:"current"`
	RecentJobs         []hubclient.JobSummary `json:"recent_jobs"`
	Autostart          bool                   `json:"autostart"`
	AutostartSupported bool                   `json:"autostart_supported"`
}

type controller struct {
	mu     sync.Mutex
	status Status
	cfg    *config.Config
	runner *agentcore.Runner
	app    *application.App
	window *application.WebviewWindow
	paused bool
	wake   chan struct{}

	pauseItem     *application.MenuItem
	autostartItem *application.MenuItem
	menu          *application.Menu

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
		wake:       make(chan struct{}, 1),
	}
	c.status = Status{
		Version:            version.Version,
		Autostart:          autostartEnabled(),
		AutostartSupported: runtime.GOOS == "windows",
	}
	if cfg != nil {
		c.status.MachineID = cfg.Agent.MachineID
		c.status.Hub = cfg.Agent.Hub
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
		MinWidth:         880,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(15, 23, 42),
		Windows: application.WindowsWindow{
			Theme: application.Dark,
		},
		URL: "/",
	})
	c.window = window
	if cfg != nil {
		window.SetTitle("Observer Agent · " + cfg.Agent.MachineID)
	}
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
	menu.Add("立即同步").OnClick(func(ctx *application.Context) {
		if err := c.scanNow(); err != nil {
			window.Show()
			window.Focus()
			c.setError(err)
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
		c.setPaused(!c.isPaused())
	})
	menu.AddSeparator()
	autostartItem := menu.AddCheckbox("开机启动", c.status.Autostart)
	autostartItem.OnClick(func(ctx *application.Context) {
		enabled := ctx.ClickedMenuItem().Checked()
		if err := c.setAutostart(enabled); err != nil {
			log.Printf("设置开机启动失败: %v", err)
			c.refreshTray()
		}
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		app.Quit()
	})
	tray.SetMenu(menu)

	c.mu.Lock()
	c.pauseItem = pauseItem
	c.autostartItem = autostartItem
	c.menu = menu
	c.mu.Unlock()

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

func (c *controller) isPaused() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.paused
}

// setPaused 切换暂停状态，并同步托盘文案与前端。
func (c *controller) setPaused(paused bool) {
	c.mu.Lock()
	c.paused = paused
	c.status.Paused = paused
	c.mu.Unlock()
	c.refreshTray()
	c.emit()
}

func (c *controller) refreshTray() {
	c.mu.Lock()
	paused := c.paused
	autostart := c.status.Autostart
	pauseItem := c.pauseItem
	autostartItem := c.autostartItem
	menu := c.menu
	c.mu.Unlock()

	if pauseItem != nil {
		if paused {
			pauseItem.SetLabel("继续巡检")
		} else {
			pauseItem.SetLabel("暂停巡检")
		}
	}
	if autostartItem != nil {
		autostartItem.SetChecked(autostart)
	}
	if menu != nil {
		menu.Update()
	}
}

// scanNow 唤醒 runLoop 立即执行一轮；未初始化/暂停/扫描中会返回错误。
func (c *controller) scanNow() error {
	c.mu.Lock()
	runner := c.runner
	paused := c.paused
	c.mu.Unlock()
	if runner == nil {
		return errors.New("agent 尚未连接，请等待初始化完成")
	}
	if paused {
		return errors.New("巡检已暂停，请先继续巡检")
	}
	if runner.CurrentJob() != nil {
		return errors.New("巡检正在进行中")
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return nil
}

func (c *controller) setAutostart(enabled bool) error {
	if err := setAutostart(enabled, c.configPath); err != nil {
		return err
	}
	c.mu.Lock()
	c.status.Autostart = enabled
	c.mu.Unlock()
	c.refreshTray()
	c.emit()
	return nil
}

func (c *controller) setError(err error) {
	if err == nil {
		return
	}
	c.mu.Lock()
	c.status.LastError = err.Error()
	c.status.LastErrorAt = time.Now().UnixMilli()
	c.mu.Unlock()
	c.emit()
}

// recordPoll 记录一次与 hub 的轮询结果（用于连接徽章与「最后通信」）。
func (c *controller) recordPoll(err error, now int64) {
	c.mu.Lock()
	if err != nil {
		c.status.Connected = false
		c.status.LastError = err.Error()
		c.status.LastErrorAt = now
	} else {
		c.status.Connected = true
		c.status.LastOkAt = now
	}
	c.mu.Unlock()
}

// recordRun 记录一轮 RunOnce 的结果：空闲轮询不清空统计/错误。
func (c *controller) recordRun(ran bool, stats scan.Stats, err error, now int64) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err != nil {
		c.status.LastError = err.Error()
		c.status.LastErrorAt = now
		if ran {
			c.status.LastRunAt = now
		}
		return
	}
	if !ran {
		return
	}
	c.status.Connected = true
	c.status.LastOkAt = now
	c.status.LastRunAt = now
	c.status.LastError = ""
	c.status.LastErrorAt = 0
	c.status.LastStats = summarize(stats)
}

func (c *controller) snapshot() Status {
	c.mu.Lock()
	snapshot := c.status
	runner := c.runner
	c.mu.Unlock()
	if runner != nil {
		snapshot.Current = runner.CurrentJob()
	}
	snapshot.Running = snapshot.Current != nil
	return snapshot
}

func (c *controller) openConfigFolder() error {
	return openPath(filepath.Dir(c.configPath))
}

func (c *controller) quit() {
	if c.app != nil {
		c.app.Quit()
	}
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
	c.status.LastErrorAt = 0
	c.status.LastOkAt = 0
	c.status.LastRunAt = 0
	c.status.LastStats = nil
	c.status.Connected = false
	c.status.Paused = c.paused
	parent := c.appCtx
	started := c.runnerStarted
	c.mu.Unlock()

	if c.window != nil {
		c.window.SetTitle("Observer Agent · " + cfg.Agent.MachineID)
	}
	if c.app != nil {
		c.app.Event.Emit("setup", state)
	}
	if started {
		c.restartRunner()
	} else if parent != nil {
		c.startRunner(parent)
	}
	c.emit()
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
		log.Printf("初始化 agent 失败: %v", err)
		c.setError(err)
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
		runner := c.runner
		c.mu.Unlock()
		if runner == nil {
			return
		}

		// 任务历史与连接状态独立于暂停状态刷新；失败时保留旧的任务列表。
		now := time.Now().UnixMilli()
		jobs, jobsErr := runner.RecentJobs(ctx, 20)
		c.recordPoll(jobsErr, now)
		if jobsErr == nil {
			c.mu.Lock()
			c.status.RecentJobs = jobs
			c.mu.Unlock()
		}

		if !paused {
			stats, ran, err := runner.RunOnce(ctx)
			c.recordRun(ran, stats, err, time.Now().UnixMilli())
		}

		select {
		case <-ctx.Done():
			return
		case <-c.wake:
			// 立即巡检：跳过本轮等待。
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
	c.app.Event.Emit("status", c.snapshot())
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

func openPath(path string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", path).Start()
	case "darwin":
		return exec.Command("open", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}
