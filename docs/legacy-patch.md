# 旧版补丁：残留诊断与摘除

**0.2.0 起，本插件不再改写任何 Harness 文件。** 本页只服务一件事：识别并清理
0.1.x 时代可能残留在客户端 bundle 上的补丁标记。

## 为什么不再需要它

0.1.x 时代，本插件靠对 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 做
文本级手术，人为开出三个 sidebar 槽位（`headerAction` / `sessionLead` /
`sessionMenu`）。这套做法的代价与版本强绑定：

- 锚点是**精确文本**（含 tab 缩进和 CSS 哈希类名），上游每改一次 JSX 结构就会漂移；
- 目标文件是 **npx 缓存里的全局共享副本**（`~/.dsh/profiles/node_modules/@deepseek-ai/*`
  全是指向 `_npx/<hash>` 的 Junction），一次改写影响所有 profile；
- 早期版本还有"页面加载自动 apply + 自动刷新"的自愈环，在单侧补丁状态下会变成
  **白屏 + 无限刷新**。

0.1.7 起官方客户端已原生声明所需扩展点（见
`@deepseek-ai/dsh-client-ui-workspace/README.zh.md`「打包客户端插件」一节），
本插件改为纯 `ctx.slots.inject()` 贡献：**不打补丁、不自动刷新、不写文件**。

## 目标文件

```
$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js
```

（Junction → npx 缓存目录中的真实文件。补丁必须穿链写入，**不要**把目标物化为
真实目录：`dsh-app-boot.ensureSymlink` 对真实目录直接抛错，Harness 无法启动。）

## 标记形态

每个插入区由成对标记包裹，摘除只认这对标记，不需要任何锚点：

```
/* dsh-session-delete:region:<name>:begin */ … /* dsh-session-delete:region:<name>:end */
```

`<name>` 取自旧版 regions 表：`menuRegistry`、`slotDecls`、`headerAction`、
`nodeItemProps`、`menuMerge`、`menuSelect`、`sessionLead`、`treeProps`、`treeItem`、
`flatProps`、`flatItem`、`flatCall`、`treeCall`、`headerWidth`、`menuHost`。

## 命令

```bash
node scripts/patch-workspace-menu.mjs status   # 只读：有无残留
node scripts/patch-workspace-menu.mjs verify   # 只读：详情（含成对性缺陷）
node scripts/patch-workspace-menu.mjs strip    # 摘除全部标记区（原子写）
node scripts/patch-workspace-menu.mjs apply    # 永久拒绝：开槽能力已移除
```

`verify` 报告三种缺陷，任一出现都建议立刻 `strip`：

| 缺陷 | 含义 | 风险 |
|---|---|---|
| `unbalanced` | begin 与 end 数量不等 | 说明改写过半失败；摘除时只处理成对标记，孤立标记原样保留 |
| `duplicated` | 同一 region 出现多对标记 | 早期"幂等判定为假 → 二次 apply"会插出重复区，是**语法破坏**的直接来源 |
| `orphan-end` | 只有 end 没有 begin | 精确 strip 曾经切掉过边界 |

## 运行时表现

客户端里还有一处只读诊断：`GET /session-delete/api/status` 会返回
`stalePatch` / `regions` / `defects`。检测到残留时，侧边栏底部出现 ⚠ 徽标，
设置页分区里也会提示——**只提示，不修复**。

## 回归防线

- `test.mjs`：标记扫描、成对摘除、孤立标记保守处理、重复标记识别，
  以及"host 导入面无写入能力""client 源码不含自动刷新"的源码级断言；
- `scripts/check-client.mjs`：真实 React SSR 渲染每个注册组件（本机装了
  React 时才能跑，CI 不依赖）。
