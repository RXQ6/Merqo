# Windows 全屏阅读层关闭按钮修复

最新动态复用 FullscreenOverlayBase。Windows 原生 titleBarOverlay 高度为 48px，原阅读层从 y=0 开始，右上关闭/复制控件与原生关闭/最大化区域冲突；DOM z-index 无法覆盖原生窗口按钮。

Electron Windows 主渲染入口在 documentElement 设置 --fullscreen-overlay-top=48px；其他平台和 WebUI 为 0。共享全屏层使用此变量设置顶部边界，让标题、关闭、复制、滚动区域一起避开窗口控制区。没有修改窗口退出逻辑。

源码构建及 Electron TypeScript 检查通过。真实 Electron 隔离工作区回归覆盖普通、800px 窄窗、最大化；关闭按钮 y=58.875px，实际鼠标坐标点击和 Escape 均只关闭对话层，BrowserWindow 保持存活。脚本 scripts/merqo-overlay-close-check.cjs，记录 artifacts/overlay-close/2026-10-22T06-29-31-217Z/result.json。

本机便携修正版目录为 artifacts/windows/local-overlay-fix/win-unpacked，由已发布 beta.8 运行文件及本次重新编译的 renderer 组成。它仍显示 beta.8，不代表新的 GitHub 发布；原发布安装包未覆盖。根目录“打开Merqo-修正版.cmd”使用原 .runtime/config 工作区启动该版本。使用前退出旧版，避免相同用户配置的单实例唤起旧窗口。

上述本机 Merqo.exe 也通过相同三状态、鼠标关闭、Escape 关闭及窗口存活检查，记录 artifacts/overlay-close/2026-10-22T06-32-01-625Z/result.json。测试使用隔离合成工作区；未改用户业务数据。
