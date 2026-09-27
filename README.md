# 🗑 plugin-session-delete

[![Release](https://img.shields.io/github/v/release/cynch18/plugin-session-delete)](https://github.com/cynch18/plugin-session-delete/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/cynch18/plugin-session-delete/test.yml)](https://github.com/cynch18/plugin-session-delete/actions)

> 给 DeepSeek Harness 补上「删除会话」——不是藏在设置里的清单页，而是**会话行「…」菜单里顺手一项**，外加一个全屏批量面板。

## 为什么会有它

DSH 的会话只有三种命运：重命名、分叉、归档。归档只是把会话藏起来，文件还躺在硬盘上；想真正删掉，要么手动去翻 `.dsh` 目录，要么装一个"设置里的会话管理器"——每次都要点开设置、找到面板、再勾选。

删会话这种事，就该发生在**看到会话的地方**。

## 它做什么（0.2.0：零补丁架构）

三个落点**全部是 DSH 官方声明的原生槽**，靠 `ctx.slots.inject()` 注册，本插件不写入任何 Harness 文件：

| 位置 | 原生槽 | 内容 |
|---|---|---|
| 会话行「…」菜单 | `sidebar.workspaces.session.menu.item` | 红色**删除会话**（order 500，排在官方 Archive 400 之后）+ **批量删除会话…**（510） |
| 全局浮层 | `shell.overlay` | 永久删除确认框 + 批量选择面板 |
| 设置页 | `settings.section` | 同一套批量面板 |

批量面板列出**全部**会话（含已归档），带搜索、全选、运行中/当前会话自动锁定、逐条结果回报。

> **升级不会再把你卡住。** 旧版（≤ 0.1.1）需要对 `dsh-client-ui-workspace` 的打包文件做文本手术，锚点强绑定上游 JSX 结构，且目标文件是 npx 缓存里的全局共享副本——上游一换版本就有概率留下半截补丁，配合"自动打补丁 + 自动刷新"的自愈环，表现为白屏或无限刷新。0.2.0 把这些**全部删掉了**：不写文件、不自动刷新、不重打补丁。

## 30 秒装上

```bash
npx @deepseek-ai/dsh plugin --profile web add github:cynch18/plugin-session-delete
```

重启 dsh → 刷新页面。会话行「…」里多出「删除会话」与「批量删除会话…」。

> 备选方式（离线 / 脚本流）：`node scripts/install.mjs`（跨平台）或 Windows 上的 `install.ps1`。两种方式**选其一**即可，重复安装会产生重复条目。

## 怎么用

1. **单删**：会话行「…」→ 红色**删除会话** → 确认框写明"不可恢复"；
2. **批量**：会话行「…」→ **批量删除会话…**（或设置 → 删除会话）→ 勾选 → **删除所选 (n)** → 确认。

删除是**永久**的：日志文件、投影缓存、工作区记账、归档状态一并清掉。但它不越界——子代理、分叉、产出的文件都保留，除非你显式勾选它们。

## 底线

- 运行中的会话服务端直接拒绝（409）；当前打开的会话在界面上禁用；
- API 只信任本机回环 Host（`--host 0.0.0.0` 启动时一律 403），跨站请求与异源 Origin 一并拒绝；
- 删除路径全部走"会话库根目录围栏 + 会话 id 字符集校验"，不接受任何路径拼接输入；
- 已在 DSH **0.1.7-rc.2** 上核对过槽位声明表（`sidebar.workspaces.session.menu.item` 等）。

## 升级之后

不再需要任何补救动作。若你从 0.1.x 升上来，bundle 上可能残留旧补丁标记：
侧边栏底部会出现 ⚠ 徽标，设置页面板里也会提示。摘除：

```bash
node scripts/patch-workspace-menu.mjs strip
```

详见 [docs/legacy-patch.md](docs/legacy-patch.md)。

## 卸载

```bash
# 1. 从 profile 的 cordis.patch.yml 里删掉 plugin-session-delete 条目
# 2. 删除 profiles\web\node_modules\dsh-profile-plugin-session-delete\
# 3. （仅当从 0.1.x 升级而来）node scripts/patch-workspace-menu.mjs strip
```

## License

删除语义参考 [dsh-archived-sessions](https://github.com/Zephyr-vibe/dsh-archived-sessions)（MIT）的实现模式，产品形态自研。

MIT — © 2026 CYNCH18
