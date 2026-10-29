// observer-agent：部署在受管机器上的巡检端。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"observer/agent/internal/agent"
	"observer/agent/internal/config"
	"observer/agent/internal/version"
)

func printUsage() {
	fmt.Printf(`observer-agent %s

用法:
  observer-agent version
  observer-agent run    -config <path> [-enroll-token <token>] [-interval 15s]
  observer-agent scan   -config <path> [-enroll-token <token>]
  observer-agent doctor -config <path>

说明:
  run     常驻运行：注册、心跳、领取任务、巡检
  scan    执行一轮（补发 spool、心跳、有任务则巡检）
  doctor  自检：配置、目录、sentinel、hub 连通性
`, version.Version)
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		printUsage()
		return 2
	}
	switch args[0] {
	case "version", "--version", "-v":
		fmt.Println(version.Version)
		return 0
	case "help", "--help", "-h":
		printUsage()
		return 0
	case "run":
		return cmdRun(args[1:])
	case "scan":
		return cmdScan(args[1:])
	case "doctor":
		return cmdDoctor(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", args[0])
		printUsage()
		return 2
	}
}

func cmdRun(args []string) int {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := flags.String("config", "observer-agent.yaml", "配置文件路径")
	enrollToken := flags.String("enroll-token", "", "一次性注册 token（也可用 OBSERVER_ENROLL_TOKEN）")
	interval := flags.Duration("interval", 15*time.Second, "心跳间隔")
	_ = flags.Parse(args)

	cfg, err := config.Load(*configPath)
	if err != nil {
		return fail(err)
	}
	runner, err := agent.New(cfg, version.Version)
	if err != nil {
		return fail(err)
	}
	defer runner.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runner.EnsureToken(ctx, *enrollToken); err != nil {
		return fail(err)
	}

	fmt.Printf(
		"observer-agent %s: machine=%s hub=%s mounts=%d\n",
		version.Version, cfg.Agent.MachineID, cfg.Agent.Hub, len(cfg.Mounts),
	)
	if err := runner.Run(ctx, *interval); err != nil && !errors.Is(err, context.Canceled) {
		return fail(err)
	}
	return 0
}

func cmdScan(args []string) int {
	flags := flag.NewFlagSet("scan", flag.ExitOnError)
	configPath := flags.String("config", "observer-agent.yaml", "配置文件路径")
	enrollToken := flags.String("enroll-token", "", "一次性注册 token（也可用 OBSERVER_ENROLL_TOKEN）")
	_ = flags.Parse(args)

	cfg, err := config.Load(*configPath)
	if err != nil {
		return fail(err)
	}
	runner, err := agent.New(cfg, version.Version)
	if err != nil {
		return fail(err)
	}
	defer runner.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runner.EnsureToken(ctx, *enrollToken); err != nil {
		return fail(err)
	}

	stats, err := runner.RunOnce(ctx)
	if err != nil {
		return fail(err)
	}
	if stats.Batches == 0 && stats.Seen == 0 && stats.Skipped == 0 {
		fmt.Println("没有可执行的任务（spool 已补发、心跳正常）")
		return 0
	}
	fmt.Printf(
		"done: seen=%d hashed=%d skipped=%d unreadable=%d unstable=%d batches=%d bytes=%d duration=%dms\n",
		stats.Seen, stats.Hashed, stats.Skipped, stats.Unreadable, stats.Unstable,
		stats.Batches, stats.BytesRead, stats.DurationMs,
	)
	return 0
}

func cmdDoctor(args []string) int {
	flags := flag.NewFlagSet("doctor", flag.ExitOnError)
	configPath := flags.String("config", "observer-agent.yaml", "配置文件路径")
	_ = flags.Parse(args)

	cfg, err := config.Load(*configPath)
	if err != nil {
		return fail(err)
	}
	runner, err := agent.New(cfg, version.Version)
	if err != nil {
		return fail(err)
	}
	defer runner.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := runner.Doctor(ctx); err != nil {
		return fail(err)
	}
	fmt.Printf("doctor ok: machine=%s hub=%s mounts=%d\n", cfg.Agent.MachineID, cfg.Agent.Hub, len(cfg.Mounts))
	return 0
}

func fail(err error) int {
	fmt.Fprintf(os.Stderr, "observer-agent: %v\n", err)
	return 1
}
