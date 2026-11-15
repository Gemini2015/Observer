Observer agent（Windows 命令行版）
=================================

这是命令行程序，不是桌面客户端。

直接双击 observer-agent.exe 时，Windows 会打开一个控制台窗口，
程序打印用法后立即退出（窗口一闪而过），这是正常现象，不是崩溃。

正确用法（在 PowerShell 中）：

  1. 复制 agent.example.yaml 为 agent.yaml，按需修改：
     - agent.machine_id：本机唯一 ID
     - agent.hub：hub 地址
     - agent.token：hub Web「注册新机器」生成的一次性 token
     - mounts：要巡检的目录
  2. 运行：
     .\observer-agent.exe run -config agent.yaml
  3. 其他命令：
     .\observer-agent.exe version
     .\observer-agent.exe scan   -config agent.yaml
     .\observer-agent.exe doctor -config agent.yaml

需要桌面图形界面/系统托盘？

  下载 observer-agent-desktop_<版本>_windows_amd64.zip，
  解压后双击 observer-agent-desktop.exe。

详细文档见 GitHub 仓库的 docs/QUICKSTART.md、docs/CONFIG.md。
