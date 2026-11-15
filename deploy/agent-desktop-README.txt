Observer Agent 桌面客户端（Windows）
=====================================

1. 解压到有写权限的目录（例如 D:\Observer 或用户目录），不要在压缩包内直接运行，
   也不要放在 C:\Program Files：程序默认在 exe 同目录创建/读取 agent.yaml，需要写权限。
2. 双击 observer-agent-desktop.exe 启动。
3. 首次启动会进入配置向导：填写机器 ID、hub 地址、注册 token（或已有节点的接入 token）、
   巡检目录/挂载点；保存后开始巡检。
4. 运行要求：Microsoft Edge WebView2 Runtime。Windows 11 和 Windows 10 1803+ 通常已内置；
   若提示缺少 WebView2，请从以下地址安装后重试：
   https://developer.microsoft.com/microsoft-edge/webview2/
5. 关闭窗口会隐藏到系统托盘，巡检继续；托盘菜单可打开界面、立即同步、暂停/继续、
   开机启动、退出。
6. 单实例：重复双击只会聚焦已运行的窗口。
7. 日志：%LocalAppData%\Observer\observer-agent-desktop.log
   配置：exe 同目录的 agent.yaml（也可用 -config 指定）。
8. 本程序未做代码签名，首次运行可能出现 SmartScreen「未知发布者」提示：
   选择「更多信息」→「仍要运行」。请从 GitHub Release 下载并核对 SHA256SUMS。

命令行版本见 observer-agent_<版本>_windows_amd64.zip（不能双击运行）。
