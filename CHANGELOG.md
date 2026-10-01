# Changelog

## 0.2.1 (2026-10-01)

**修复：设置导航"删除会话"那一行的图标在实机上渲染成坏图。**

- 真实 DOM 里图标**就是**设置导航按钮的第一个子节点（`button > svg.navIcon + span.navLabel`，
  0.1.7-rc.2 起如此，没有外层包装元素）；而 0.2.0 的 `observeSettingsNavIcon` 按
  "包装元素里的第一个 svg" 去找，把 svg 内部的**第一条 path**（齿轮内圆）当成了齿轮，
  替换成一只无尺寸的嵌套 svg —— 设置页那一行显示成"齿轮残线 + 被裁切的垃圾桶碎片"。
- 现在按真实结构**整只替换**图标节点；替换物改成与官方 `IconTrashOutlineRegular`
  同一 16 格几何（5 条 path 誊写自 `dsh-client-ui-primitives`），并克隆源图标的
  宽高 / class / 描边宽度（导航用 medium 1.3）；另保留一层包装探测，容忍上游再变。
- 卸载还原改为**原位 `replaceWith`**（Map 持有原节点）。旧实现改成"替换物是按钮直接
  子节点"后若继续用 `parent.innerHTML = …`，会把"删除会话"标签一起抹掉。
- 测试夹具改为真实结构，并新增断言：整只替换、16 格视框、无嵌套 svg、原节点与
  其余分区不受影响、幂等、卸载原位还原。旧夹具模拟了不存在的包装层，正是这条
  bug 漏网的原因。

## 0.2.0 (2026-09-27)

**架构重写：不再改写 Harness 文件。** 起因是一次实测——本机 DSH 升到 0.1.7-rc.2 后，
旧版的 15 个补丁锚点有 13 个 missing（`slotDecls` / `sessionLead` / `menuMerge` /
`treeProps` / `headerWidth` 的 CSS 哈希类名等全数漂移），而目标文件是 npx 缓存里的
全局共享副本，配合"页面加载自动 apply + 自动刷新"的自愈环，会退化成白屏 + 无限刷新。

- **改走官方客户端扩展点**：单删与批量入口注册进原生
  `sidebar.workspaces.session.menu.item`（order 500 / 510，官方 Archive 是 400）；
  确认框与批量面板注册进 `shell.overlay`；设置页沿用 `settings.section`。
  批量选择改为浮层面板（原生 `sidebar.session.row.leading` 有"仅 idle、归档行留空、
  Session 作用域会激活并保留每个会话"三条约束，不适合做常驻勾选框）。
- **删除自愈环**：不再 apply-patch、不再 `location.reload()`、不再写任何 Harness 文件。
  host 半去掉 `/apply-patch` 端点，`/status` 变成只读诊断（`stalePatch` / `regions` /
  `defects`）。
- **补丁脚本降级为标记摘除器**：`scripts/patch-workspace-menu.mjs` 只按成对标记做
  外科摘除，**不需要任何锚点**，因此卸载路径与上游版本彻底解耦；`apply` 子命令永久拒绝。
  新增成对性缺陷诊断：`unbalanced` / `duplicated` / `orphan-end`（`duplicated` 正是早期
  "幂等判定为假 → 二次 apply"插出重复区的语法破坏来源）。
- **安装脚本**改为"只读体检 + 注册条目"，不再打补丁；`docs/anchors.md` 重写为
  `docs/legacy-patch.md`；`scripts/render-check.mjs` 换成 `scripts/check-client.mjs`
  （对原生槽组件做 SSR 冒烟）。
- **测试重写**：31 个用例覆盖标记摘除器、host 纯函数与围栏、客户端半契约
  （真跑 `apply` + 真实 SlotCore 断言只注册官方槽、卸载后无残留）、清单契约与
  安装脚本的源码级回归。

### 实机安装后修掉的两个真 bug

装到真机上第一次批量删除就报"找不到该会话的记录（会话不存在）"，逐层排查抓到两处：

1. **`persistence.list()` 返回的是快照，不是 header**——后端返回
   `{ header, revision, sizeBytes }`，代码却读 `meta.id`，永远 `undefined`。
   后果：**任何不在内存里的会话都被误判为不存在**。改为统一拆包（两种形状都兼容）。
2. **id 有两种拼写**——老会话是裸 uuid、新会话是 `session-<uuid>`，而查找只做精确
   字符串比较。改为三级兜底：变体（原样 / 加前缀 / 去前缀）→ 精确 → uuid 尾段。
3. 顺带补齐：**单删入口此前绕过了"运行中 / 当前会话"锁定**（只有批量面板有锁定），
   现在两个菜单项都通过 `inject` face 拿到行状态并自行禁用；新增只读诊断端点
   `POST /session-delete/api/diagnose`，回报服务端实际看到的 id 形态。

### 实机试用后修掉的三处问题

1. **设置页分区没有名字**：`settings.section` 的分区名走
   `resolveSlotLabel(entry.options.label) ?? id`，注册时只给了 `locale` 没给 `label`，
   于是回退成条目 id。补 `label: () => t("nav")`（读取时**无参**调用、缓存随 locale
   代次失效——与官方 settings.section 同款）。
2. **误锁：`retainedBy.mainView > 0` 被当成了"当前会话"**。它是**保留引用计数**，
   凡被主视图打开过的会话都 > 0 且不会归零，结果大量普通会话被锁成灰色、功能等于废掉。
   现在只锁 `running === true`（与服务端 409 同源），删当前会话交给服务端报错兜底。
3. **注册项不得声明 owner 形参的 `inject`**：渲染层对 entry 的 `inject` 只传
   `binding.key` / `actions`（`dsh-client-ui-renderer/lib/client.js:415-421`），声明
   owner 形参会被无参调用而崩。行级数据改为在组件内用 `props.sessionId` 计算。
4. **垃圾桶图标改用官方件**：自带的描边 SVG 换成
   `@deepseek-ai/dsh-client-ui-primitives` 的 `IconTrashOutlineRegular`（与官方 archive
   用的 `IconArchiveOutline20` 同一套），菜单条目与原生项视觉完全一致；同时保留自带
   兜底 SVG——require 失败时自动退回，绝不因依赖缺失而拖垮客户端半。
5. **设置导航那一行的齿轮换成垃圾桶**。`settings.section` 的公开契约**没有 icon
   字段**：设置壳只投影 `id`/`order`/`label`，图标由一段硬编码白名单决定——
   `dsh-client-ui-settings-general/lib/client.js:239-265`
   `/** Nav glyph by section id; unknown ids fall back to the settings gear. */`，
   我们的 id 不在名单里，于是吃默认齿轮。做法与 `dsh-better-sidebar:16092-16133`
   同路：`ctx.effect` 持一个 `MutationObserver`，弹层挂载后按**自己的标签文本**定位
   自己那一行（不按齿轮外观猜，免得把别的分区图标一起端掉），换掉图标并打
   `data-session-delete-nav-icon` 防止自激循环，卸载时还原。新增 DOM 级回归用例。
4. **垃圾桶图标改用官方件**：自带的描边 SVG 换成
   `@deepseek-ai/dsh-client-ui-primitives` 的 `IconTrashOutlineRegular`（与官方 archive
   用的 `IconArchiveOutline20` 同一套），菜单条目与原生项视觉完全一致；同时保留自带
   兜底 SVG——require 失败时自动退回，绝不因依赖缺失而拖垮客户端半。

## 0.1.1 (2026-08-16)

- **修复：删除后的"幽灵会话"** — rc.6 无内存驱逐原语（`disposeAgent`/`persistence.remove` 均缺），
  删除后内存条目残留，而 `detachSession` 已把它踢出工作区，前端把它渲染成"未分组"里的新会话。
  现在删除后将其**加入归档集**（官方"任何地方不渲染"语义），立即隐形；重启后内存从磁盘重建，
  下次任意删除触发清扫时自然收走。顺带清扫历史孤儿归档条目。
  核心推导提取为纯函数 `nextArchivedSet`，新增 7 个单测（斗篷/幂等/清扫/未来兼容/边界）。

## 0.1.0 (2026-08-15)

- 首个正式版：侧边栏原生级批量删除（标题栏按钮 + 行勾选 + 浮动操作条 + "…"菜单单项）。
- 15 区开槽补丁 + 真·自愈（页面加载自动检测丢失并重打，仅失败才提示）。
- 官方删除语义：永久、不级联、运行中 409、当前会话禁删、路径/回环双围栏。
- `dsh plugin add github:cynch18/plugin-session-delete`（dsh.bundle 声明）+ install.mjs 跨平台安装。
- 20 个纯函数单测 + CI。
