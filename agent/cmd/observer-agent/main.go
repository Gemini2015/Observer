// observer-agent：部署在受管机器上的巡检端。
// P0 只提供命令骨架，扫描能力在 P3/P4 实现。
package main

import (
	"flag"
	"fmt"
	"os"

	"observer/agent/internal/version"
)

func printUsage() {
	fmt.Printf(`observer-agent %s

用法:
  observer-agent version
  observer-agent run    -config <path>
  observer-agent doctor -config <path>
  observer-agent scan   -config <path> -mount <mount_id>

说明:
  run     常驻运行：注册、心跳、领取任务
  doctor  自检：配置、连通性、目录权限
  scan    一次性执行某个挂载点的巡检
`, version.Version)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version.Version)
	case "help", "--help", "-h":
		printUsage()
	case "run", "doctor", "scan":
		flags := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
		config := flags.String("config", "observer-agent.yaml", "配置文件路径")
		_ = flags.Parse(os.Args[2:])
		fmt.Fprintf(
			os.Stderr,
			"observer-agent %s: %q 尚未实现（P0 仅骨架，config=%s）\n",
			version.Version,
			os.Args[1],
			*config,
		)
		os.Exit(2)
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}
