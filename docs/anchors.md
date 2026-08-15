# 补丁锚点清单（patch anchors）

目标文件：`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
（Junction → npx 缓存目录中的真实文件；浏览器经 `createRequire(profiles/web)` 解析加载该副本。）

已实证版本：**DSH 0.1.0-rc.6**（2026-08-14 构建）。
诊断工具：`node scripts/patch-workspace-menu.mjs verify`（逐区报告 ok / missing / ambiguous）。

升级后若 `verify` 报 missing，按本清单对照新版源码找到等价位置，修改
`scripts/patch-workspace-menu.mjs` 中对应 region 的 `anchor`（与 build 成对修改），
重跑单测（`node --test test.mjs`，含字节级往返 `strip(apply(x)) === x`）后再 `apply`。

## Region 与锚点

| region | 作用 | 锚点（rc.6 精确文本，缩进为 tab） |
|---|---|---|
| menuRegistry | 模块级菜单注册表（`dshSessionMenuRegistry` / `dshRegisterSessionMenu` / `dshSubscribeSessionMenu` / `dshSessionMenuExtrasSnapshot`） | 工厂头部两条 require 行：`let react = require("react");` + `let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");` |
| slotDecls | 在 `sidebar.workspaces` 的 `children` 声明 3 个 list 槽 | `children: { "sidebar.workspaces.directoryFlow": {\n\t\t\t\t\tkind: "single",\n\t\t\t\t\tscope: "root"\n\t\t\t\t} },`（`apply` 内注册调用） |
| headerAction | 标题栏动作槽渲染（`headerActions` 最前） | `children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {`（7 个 tab 缩进） |
| nodeItemProps | `SessionNodeItem` 解构增加 `renderSlot` | `function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {`（2 个 tab） |
| menuMerge | 「…」菜单合并 slot 条目（`sessionMenuItems` 末尾） | archive 条目块（4 个 tab 起）+ `\t\t\t];` |
| menuSelect | `onSelect` 分发 `sessionMenu:` 前缀动作 | `onSelect: (id) => {` 块（8 个 tab 起，含三条 if + `},`） |
| sessionLead | 会话行首勾选框槽渲染（状态点前） | `children: [` + `(!flat || showStatus) && ... span ... SessionStatusDots ... }),`（5 个 tab 起） |
| treeProps | `SessionTree` 解构增加 `renderSlot` | `function SessionTree({ useSessions, startSession, ... setSessionOrder, t }) {`（2 个 tab） |
| treeItem | `SessionTree` 的 `SessionNodeItem` 传 `renderSlot` | `return (0, react_jsx_runtime.jsx)(SessionNodeItem, {` 块（10 个 tab 起，`onArchive: onSessionArchive,` 结尾） |
| flatProps | `FlatList` 解构增加 `renderSlot` | `function FlatList({ useSessions, open, ... setSessionOrder, t }) {`（2 个 tab） |
| flatItem | `FlatList` 的 `SessionNodeItem` 传 `renderSlot` | `return (0, react_jsx_runtime.jsx)(SessionNodeItem, {` 块（6 个 tab 起，`onArchive: onSessionArchive,` + `flat: true,`） |
| flatCall | `WorkspaceBrowser → FlatList` JSX 调用传 `renderSlot`（透传链起点） | `}) : groupBy === "flat" ? (0, react_jsx_runtime.jsx)(FlatList, {` + `useSessions,` + `open,`（6/7 个 tab） |
| treeCall | `WorkspaceBrowser → SessionTree` JSX 调用传 `renderSlot`（透传链起点） | `}) : (0, react_jsx_runtime.jsx)(SessionTree, {` + `useSessions,` + `onSessionRename,`（6/7 个 tab） |
| headerWidth | 标题栏动作容器放宽到容纳第 3 个按钮 | CSS 内联字符串：`.qDHVXG_headerActions{opacity:1;visibility:visible;max-width:60px;`（60px 保留 + 追加 96px，CSS 后者生效） |
| menuHost | `WorkspaceBrowser` 根部隐藏容器挂载 sessionMenu 注册组件 | 根 children 末尾：`})` + `]` + `});` + `}` + `//#endregion`（5 个 tab 起） |

## 机制要点

- 每个 region 的插入内容完整包裹在 `/* dsh-session-delete:region:<name>:begin */` 与 `:end */` 之间，
  `stripPatch` 按标记外科式摘除，与文件版本解耦（单测保证字节级往返）。
- `checkPatch` = 全部 15 对标记存在；`applyPatchText` 逐区校验锚点唯一命中后替换，
  任一锚点缺失/歧义即整体拒绝写入（绝不写坏文件）。
- 回归防线（test.mjs，18 用例）：字节级往返 `strip(apply(x)) === x`；SlotCore 集成测试
  （真实 slot 核心注册后断言 entry.children 含全部 4 槽）；`renderSlot,` 出现次数断言
  （9 处 = 2 原始解构 + 7 处透传接线）；headerWidth 文本断言。
- 渲染级演练（`scripts/render-check.mjs`，本地验证用）：真实 React SSR 渲染补丁版
  WorkspaceBrowser，断言三个槽出口全部触发——拦住"透传链缺口/渲染崩溃"类问题。
- 写入用同目录 tmp + rename 原子替换；client-modules 按请求读文件且 `cache-control: no-cache`，
  重载页面即取新内容。
- **不要**把目标物化为真实目录：`dsh-app-boot.ensureSymlink` 对真实目录直接抛错，Harness 无法启动。
  补丁必须穿链写入（Windows 文件 I/O 自动解析 junction）。
