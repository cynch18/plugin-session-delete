# 🗑 plugin-session-delete

[![Release](https://img.shields.io/github/v/release/cynch18/plugin-session-delete)](https://github.com/cynch18/plugin-session-delete/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/cynch18/plugin-session-delete/test.yml)](https://github.com/cynch18/plugin-session-delete/actions)

> 给 DeepSeek Harness 补上「删除会话」——不是藏在设置里的清单页，而是**侧边栏里顺手一勾**。

## 为什么会有它

DSH 的会话只有三种命运：重命名、分叉、归档。归档只是把会话藏起来，文件还躺在硬盘上；想真正删掉，要么手动去翻 `.dsh` 目录，要么装一个"设置里的会话管理器"——每次都要点开设置、找到面板、再勾选。

删会话这种事，就该发生在**看到会话的地方**。所以有了这个插件：不改变你的使用习惯，只是在标题栏加一个 🗑，让删除变成顺手的事。

## 30 秒装上

```bash
npx @deepseek-ai/dsh plugin --profile web add github:cynch18/plugin-session-delete
```

重启 dsh → 刷新页面。工作区标题栏（搜索框那一行）左侧多出一个 **🗑**。

**不需要跑任何补丁脚本**：侧边栏补丁会在页面首次加载时自动检测、自动补上、自动刷新——自愈机制兼职安装器。已在全新 profile 上实测全链路：安装 → 重启 → 插件进入 boot 图 → 补丁就位，全程只有上面这一条命令。

> 备选方式（离线 / 脚本流）：`node scripts/install.mjs`（跨平台，拷贝 + 打补丁 + 注册一步到位）或 Windows 上的 `install.ps1`。两种方式**选其一**即可，重复安装会产生重复条目。

## 怎么用

1. 点 **🗑** 进入选择模式——每个会话行左边出现勾选框；
2. 勾上想删的（可以全选，运行中和当前会话会自动排除）；
3. 点左下角**删除所选 (n)** → 确认 → 完事。

单个删除也留着老习惯：会话行「…」菜单里多了一项红色的**删除会话**。

删除是**永久**的：日志文件、投影缓存、工作区记账、归档状态一并清掉，且有确认弹窗明说"不可恢复"。但它不越界——子代理、分叉、产出的文件都保留，除非你显式勾选它们。

## 升级之后，什么都没发生

这个插件需要给侧边栏"开三个槽"（一次小补丁）。你可能担心：DSH 一升级，补丁不就没了？

对，补丁会被覆盖。**但你不会知道这件事。** 页面加载时插件自己发现、自己重打、自己刷新——你看到的始终是那个 🗑。只有自动修复也失败时（权限不足、文件被占用、新版结构大改），侧边栏底部才会冒出一个 ⚠ 提醒你。这就是它和"设置面板型"插件的分野：那些插件卖"零补丁的稳"，这个卖"手速 + 永远不用操心"。

## 底线

- 补丁万一失效，**设置 → 删除会话** 面板依然完整可用，还能看到并删除已归档的会话；
- 运行中的会话服务端直接拒绝（409），当前会话界面上禁用；
- API 只信任本机回环请求；`--host 0.0.0.0` 启动时自动 403；
- 已在 DSH **0.1.0-rc.6** 实测通过（含"模拟升级 → 自动修复"演练）。

## 卸载

```powershell
# 1. 删掉 cordis.patch.yml 里的 plugin-session-delete 条目
node scripts\patch-workspace-menu.mjs strip   # 2. 摘除补丁（按标记精确移除，升级过会自动跳过）
# 3. 删除 profiles\web\node_modules\dsh-profile-plugin-session-delete\
```

## 许可

删除语义的实现模式参考了 [dsh-archived-sessions](https://github.com/Zephyr-vibe/dsh-archived-sessions)（MIT）。升级后补丁锚点漂移的排查手册见 [docs/anchors.md](docs/anchors.md)。

MIT — © 2026 CYNCH18
