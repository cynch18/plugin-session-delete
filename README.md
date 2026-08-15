# plugin-session-delete

一个 DSH Web 插件：在**侧边栏原生交互**中批量删除会话——标题栏删除按钮 + 行首勾选框，路径最短、手速最快。补丁丢失时**自动检测、自动修复、用户无感**。

A DSH web plugin: batch-delete sessions **natively in the sidebar** — a delete button in the header row plus per-row checkboxes. If the slot patch is lost, the plugin **detects and repairs it silently** — the user never notices.

## 功能 Features

- 工作区标题栏（搜索/视图选项所在行）左侧新增 **🗑 删除按钮**；点击进入**选择模式**
- 每个会话行左侧出现**勾选框**：多选、全选（自动排除运行中与当前会话）、标题栏实时徽标计数
- 底部浮动操作条：全选 / 清空 / **删除所选 (n)** → 确认弹窗 → 批量删除（20 个一批串行、逐条回报）
- 会话行「…」菜单新增**「删除会话」**单项（红色危险样式；运行中/当前会话禁用）
- 删除语义：永久删除（记录文件 + 工作区记账 + 归档集一并清除）；**不级联**（子代理/分叉保留）；运行中会话服务端拒绝（409）
- **真·自愈**：页面加载自动检测补丁 → 丢失则自动重打 → 成功无感刷新；自动修复失败才在侧边栏底部显示 ⚠ 徽标 + 设置面板横幅（手动重试）
- 设置 → **删除会话**面板（兜底入口，补丁失效时功能完整可用）：搜索 + 勾选列表 + 批量删除，可看到并删除已归档会话
- zh / en 双语；API 仅信任本机回环请求

## 安装 Install

### 方式一：脚本（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

### 方式二：手动

1. 复制本包到 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-profile-plugin-session-delete\`；
2. 打补丁：`node scripts\patch-workspace-menu.mjs apply`；
3. 在 `profiles\web\cordis.patch.yml` 的 `- insert:` 列表追加：

```yaml
    - id: plugin-session-delete
      name: dsh-profile-plugin-session-delete
      disabled: false
```

4. **重启 dsh**（host 半加载需要重启；client 半刷新页面即可）；
5. 刷新页面 → 标题栏出现 🗑 按钮。

## 升级后 DSH upgrade

无需任何操作。升级会覆盖补丁文件，但页面加载时插件会**自动检测 → 自动重打 → 无感刷新**。若自动修复失败（权限/文件占用/新版代码结构大变），侧边栏底部出现 ⚠ 按钮，点击重试；或手动运行：

```powershell
node scripts\patch-workspace-menu.mjs verify   # 逐区诊断锚点
node scripts\patch-workspace-menu.mjs apply    # 重打（幂等）
```

## 卸载 Uninstall

1. 删除 `cordis.patch.yml` 中的 `plugin-session-delete` 条目；
2. 运行 `node scripts\patch-workspace-menu.mjs strip`（按标记外科式摘除补丁，与版本解耦；升级过则自动跳过）；
3. 删除 `profiles\web\node_modules\dsh-profile-plugin-session-delete\` 目录。

## 限制 Limitations

- 运行中 / 当前打开的会话不可删除（先停止或切换）；本机进程可经回环 API 删除当前会话（与官方行为一致）
- 选择模式下点击行本身仍会打开会话（行点击属 Harness 代码）——请点左侧勾选框
- 以 `--host 0.0.0.0` 启动时 API 整体 403 不可用（仅信任回环）
- 已实证版本：DSH 0.1.0-rc.6；升级后锚点漂移的诊断见 `docs\anchors.md`

## 致谢 Attribution

删除语义与安全围栏的实现模式参考 [Zephyr-vibe/dsh-archived-sessions](https://github.com/Zephyr-vibe/dsh-archived-sessions)（MIT），产品形态（侧边栏交互 + 自愈）为独立设计。

## License

MIT — © 2026 CYNCH18
