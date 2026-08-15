#!/usr/bin/env node
// patch-workspace-menu.mjs — dsh-session-delete 的 Harness 开槽补丁（CLI 薄壳）。
//
// 对 @deepseek-ai/dsh-client-ui-workspace 的浏览器客户端打包文件做文本级手术，
// 新增 3 个通用空白 slot（无任何删除语义）：
//   sidebar.workspaces.headerAction — 标题栏动作区
//   sidebar.workspaces.sessionLead   — 会话行首（状态点左侧）
//   sidebar.workspaces.sessionMenu   — 会话行「…」菜单条目
//
// 用法：
//   node patch-workspace-menu.mjs status [--target <path>]
//   node patch-workspace-menu.mjs apply  [--target <path>]
//   node patch-workspace-menu.mjs strip  [--target <path>]
//
// 设计要点：
//   - 幂等：apply 前先 check；已打则 no-op。
//   - 锚点不匹配：明确报错（列出失败的 region），绝不写坏文件。
//   - 每个插入区用成对标记包裹，strip 按标记外科式摘除 → 与文件版本解耦。
//   - 原子写：同目录 tmp + rename。
//
// 本文件同时导出纯函数（checkPatch / applyPatchText / stripPatch / defaultTarget），
// 供插件 host 半（/status、/apply-patch）与 test.mjs 复用。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// ── 目标文件定位 ──────────────────────────────────────────────────────────
export function dshHome() {
  const raw = process.env.DSH_HOME;
  const configured = raw !== void 0 && raw.trim().length > 0 ? raw.trim() : void 0;
  let base = configured ?? join(homedir(), ".dsh");
  if (base === "~") base = homedir();
  else if (base.startsWith("~/") || base.startsWith("~\\")) base = join(homedir(), base.slice(2));
  else if (base.startsWith("~")) base = join(homedir(), base.slice(1));
  return resolve(base);
}

export function defaultTarget() {
  return join(
    dshHome(),
    "profiles", "node_modules",
    "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js",
  );
}

// ── 补丁区（region）定义 ──────────────────────────────────────────────────
// 每个 region：begin/end 标记 + [anchor, replacement]（成对，按顺序应用）。
// anchor 必须精确匹配（含缩进），replacement 把「新增内容」完整包在标记之间，
// 使 strip 后逐字节还原原文。
const R = (name) => ({
  begin: `/* dsh-session-delete:region:${name}:begin */`,
  end: `/* dsh-session-delete:region:${name}:end */`,
});

const regions = [
  {
    // R1 模块级注册表：菜单条目描述符 + 动作的发布/订阅通道。
    name: "menuRegistry",
    anchor: [
      "\t\tlet react = require(\"react\");",
      "\t\tlet _deepseek_ai_dsh_client_ui_primitives = require(\"@deepseek-ai/dsh-client-ui-primitives\");",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\tlet react = require(\"react\");",
      `\t\tlet _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");${begin}`,
      "\t\tconst dshSessionMenuRegistry = { contributions: new Map(), extras: [], listeners: new Set() };",
      "\t\tconst dshRegisterSessionMenu = (entryId, item, action) => {",
      "\t\t\tif (item === null || action === null) dshSessionMenuRegistry.contributions.delete(entryId);",
      "\t\t\telse dshSessionMenuRegistry.contributions.set(entryId, { item, action });",
      "\t\t\tdshSessionMenuRegistry.extras = [...dshSessionMenuRegistry.contributions.entries()].map(([id, contribution]) => ({ ...contribution.item, id: `sessionMenu:${id}` }));",
      "\t\t\tfor (const fn of [...dshSessionMenuRegistry.listeners]) fn();",
      "\t\t};",
      "\t\tconst dshSubscribeSessionMenu = (fn) => {",
      "\t\t\tdshSessionMenuRegistry.listeners.add(fn);",
      "\t\t\treturn () => {",
      "\t\t\t\tdshSessionMenuRegistry.listeners.delete(fn);",
      "\t\t\t};",
      "\t\t};",
      "\t\tconst dshSessionMenuExtrasSnapshot = () => dshSessionMenuRegistry.extras;",
      end,
    ].join("\n"),
  },
  {
    // R2 在 sidebar.workspaces 的 children 里声明 3 个 list 槽。
    // 关键：新键必须插在 children 对象「内部」（directoryFlow 的 } 与 children 的 } 之间），
    // 否则会变成 register 顶层杂项键被选项白名单丢弃（已由 SlotCore 集成测试覆盖）。
    name: "slotDecls",
    anchor: [
      "\t\t\t\tchildren: { \"sidebar.workspaces.directoryFlow\": {",
      "\t\t\t\t\tkind: \"single\",",
      "\t\t\t\t\tscope: \"root\"",
      "\t\t\t\t} },",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\tchildren: { \"sidebar.workspaces.directoryFlow\": {",
      "\t\t\t\t\tkind: \"single\",",
      "\t\t\t\t\tscope: \"root\"",
      `\t\t\t\t}${begin}, "sidebar.workspaces.headerAction": {`,
      "\t\t\t\t\tkind: \"list\",",
      "\t\t\t\t\tscope: \"root\"",
      "\t\t\t\t}, \"sidebar.workspaces.sessionLead\": {",
      "\t\t\t\t\tkind: \"list\",",
      "\t\t\t\t\tscope: \"root\"",
      "\t\t\t\t}, \"sidebar.workspaces.sessionMenu\": {",
      "\t\t\t\t\tkind: \"list\",",
      "\t\t\t\t\tscope: \"root\"",
      `\t\t\t\t}${end} },`,
    ].join("\n"),
  },
  {
    // R3 标题栏动作槽（headerActions 最前）。
    name: "headerAction",
    anchor: "\t\t\t\t\t\t\tchildren: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {",
    build: ({ begin, end }) =>
      "\t\t\t\t\t\t\tchildren: [" +
      begin +
      "renderSlot(\"sidebar.workspaces.headerAction\", { wide }), " +
      end +
      "wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {",
  },
  {
    // R4 SessionNodeItem 解构增加 renderSlot。
    name: "nodeItemProps",
    anchor:
      "\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {",
    build: ({ begin, end }) =>
      "\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, " +
      begin + "renderSlot, " + end + "t }) {",
  },
  {
    // R5 「…」菜单合并 slot 条目。
    name: "menuMerge",
    anchor: [
      "\t\t\t\t{",
      "\t\t\t\t\tid: \"archive\",",
      "\t\t\t\t\tlabel: t(\"menu.archiveSession\"),",
      "\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })",
      "\t\t\t\t}",
      "\t\t\t];",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t{",
      "\t\t\t\t\tid: \"archive\",",
      "\t\t\t\t\tlabel: t(\"menu.archiveSession\"),",
      "\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })",
      `\t\t\t\t}${begin}`,
      "\t\t\t, ...(0, react.useSyncExternalStore)(dshSubscribeSessionMenu, dshSessionMenuExtrasSnapshot, dshSessionMenuExtrasSnapshot).map((item) => ({",
      "\t\t\t\tid: item.id,",
      "\t\t\t\tlabel: item.label,",
      "\t\t\t\t...item.icon !== void 0 ? { icon: item.icon } : {},",
      "\t\t\t\t...item.danger === true ? { danger: true } : {},",
      "\t\t\t\t...item.disabled !== void 0 ? { disabled: typeof item.disabled === \"function\" ? item.disabled(node) : item.disabled === true } : {}",
      `\t\t\t}))${end}`,
      "\t\t\t];",
    ].join("\n"),
  },
  {
    // R6 onSelect 分发 sessionMenu: 前缀。
    name: "menuSelect",
    anchor: [
      "\t\t\t\t\t\t\t\tonSelect: (id) => {",
      "\t\t\t\t\t\t\t\t\tsetMenuOpen(false);",
      "\t\t\t\t\t\t\t\t\tif (id === \"rename\") onRename(node.id, row.title);",
      "\t\t\t\t\t\t\t\t\tif (id === \"fork\") onFork(node.id);",
      "\t\t\t\t\t\t\t\t\tif (id === \"archive\") onArchive(node.id);",
      "\t\t\t\t\t\t\t\t},",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t\t\t\t\tonSelect: (id) => {",
      "\t\t\t\t\t\t\t\t\tsetMenuOpen(false);",
      "\t\t\t\t\t\t\t\t\tif (id === \"rename\") onRename(node.id, row.title);",
      "\t\t\t\t\t\t\t\t\tif (id === \"fork\") onFork(node.id);",
      `\t\t\t\t\t\t\t\t\tif (id === "archive") onArchive(node.id);${begin}`,
      "\t\t\t\t\t\t\t\t\tif (id.startsWith(\"sessionMenu:\")) {",
      "\t\t\t\t\t\t\t\t\t\tconst dshContribution = dshSessionMenuRegistry.contributions.get(id.slice(12));",
      "\t\t\t\t\t\t\t\t\t\tif (dshContribution !== void 0) dshContribution.action(node);",
      "\t\t\t\t\t\t\t\t\t}",
      end,
      "\t\t\t\t\t\t\t\t},",
    ].join("\n"),
  },
  {
    // R7 会话行首槽（状态点前）。
    name: "sessionLead",
    anchor: [
      "\t\t\t\t\tchildren: [",
      "\t\t\t\t\t\t(!flat || showStatus) && (0, react_jsx_runtime.jsx)(\"span\", {",
      "\t\t\t\t\t\t\tclassName: Rows_module_css_default.slot,",
      "\t\t\t\t\t\t\tchildren: showStatus && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })",
      "\t\t\t\t\t\t}),",
    ].join("\n"),
    build: ({ begin, end }) => [
      `\t\t\t\t\tchildren: [${begin}renderSlot("sidebar.workspaces.sessionLead", { node, t }), ${end}`,
      "\t\t\t\t\t\t(!flat || showStatus) && (0, react_jsx_runtime.jsx)(\"span\", {",
      "\t\t\t\t\t\t\tclassName: Rows_module_css_default.slot,",
      "\t\t\t\t\t\t\tchildren: showStatus && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })",
      "\t\t\t\t\t\t}),",
    ].join("\n"),
  },
  {
    // R8 SessionTree 解构增加 renderSlot。
    name: "treeProps",
    anchor:
      "\t\tfunction SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {",
    build: ({ begin, end }) =>
      "\t\tfunction SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, " +
      begin + "renderSlot, " + end + "t }) {",
  },
  {
    // R9 SessionTree 的 SessionNodeItem 传 renderSlot。
    name: "treeItem",
    anchor: [
      "\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {",
      "\t\t\t\t\t\t\t\t\t\t\tnode,",
      "\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,",
      "\t\t\t\t\t\t\t\t\t\t\tnow,",
      "\t\t\t\t\t\t\t\t\t\t\tonOpen: open,",
      "\t\t\t\t\t\t\t\t\t\t\tonRename: onSessionRename,",
      "\t\t\t\t\t\t\t\t\t\t\tonFork: forkSession,",
      "\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {",
      "\t\t\t\t\t\t\t\t\t\t\tnode,",
      "\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,",
      "\t\t\t\t\t\t\t\t\t\t\tnow,",
      "\t\t\t\t\t\t\t\t\t\t\tonOpen: open,",
      "\t\t\t\t\t\t\t\t\t\t\tonRename: onSessionRename,",
      "\t\t\t\t\t\t\t\t\t\t\tonFork: forkSession,",
      `\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,${begin}renderSlot,${end}`,
    ].join("\n"),
  },
  {
    // R10 FlatList 解构增加 renderSlot。
    name: "flatProps",
    anchor:
      "\t\tfunction FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {",
    build: ({ begin, end }) =>
      "\t\tfunction FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, " +
      begin + "renderSlot, " + end + "t }) {",
  },
  {
    // R11 FlatList 的 SessionNodeItem 传 renderSlot。
    name: "flatItem",
    anchor: [
      "\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {",
      "\t\t\t\t\t\t\tnode,",
      "\t\t\t\t\t\t\tcurrentId: list.current,",
      "\t\t\t\t\t\t\tnow,",
      "\t\t\t\t\t\t\tonOpen: open,",
      "\t\t\t\t\t\t\tonRename: onSessionRename,",
      "\t\t\t\t\t\t\tonFork: forkSession,",
      "\t\t\t\t\t\t\tonArchive: onSessionArchive,",
      "\t\t\t\t\t\t\tflat: true,",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {",
      "\t\t\t\t\t\t\tnode,",
      "\t\t\t\t\t\t\tcurrentId: list.current,",
      "\t\t\t\t\t\t\tnow,",
      "\t\t\t\t\t\t\tonOpen: open,",
      "\t\t\t\t\t\t\tonRename: onSessionRename,",
      "\t\t\t\t\t\t\tonFork: forkSession,",
      `\t\t\t\t\t\t\tonArchive: onSessionArchive,${begin}renderSlot,${end}`,
      "\t\t\t\t\t\t\tflat: true,",
    ].join("\n"),
  },
  {
    // R12 WorkspaceBrowser → FlatList 的 JSX 调用传 renderSlot（prop 透传链起点）。
    name: "flatCall",
    anchor: [
      "\t\t\t\t\t\t}) : groupBy === \"flat\" ? (0, react_jsx_runtime.jsx)(FlatList, {",
      "\t\t\t\t\t\t\tuseSessions,",
      "\t\t\t\t\t\t\topen,",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t\t\t}) : groupBy === \"flat\" ? (0, react_jsx_runtime.jsx)(FlatList, {",
      `\t\t\t\t\t\t\tuseSessions,${begin}renderSlot,${end}`,
      "\t\t\t\t\t\t\topen,",
    ].join("\n"),
  },
  {
    // R13 WorkspaceBrowser → SessionTree 的 JSX 调用传 renderSlot（prop 透传链起点）。
    name: "treeCall",
    anchor: [
      "\t\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)(SessionTree, {",
      "\t\t\t\t\t\t\tuseSessions,",
      "\t\t\t\t\t\t\tonSessionRename,",
    ].join("\n"),
    build: ({ begin, end }) => [
      "\t\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)(SessionTree, {",
      `\t\t\t\t\t\t\tuseSessions,${begin}renderSlot,${end}`,
      "\t\t\t\t\t\t\tonSessionRename,",
    ].join("\n"),
  },
  {
    // R14 标题栏动作容器 max-width：原生 60px 恰好容纳 2 个 28px 按钮 + 4px 间距；
    // 第 3 个按钮（我们的删除按钮）需要 92px，否则 overflow:hidden 裁掉末尾的添加工作区。
    // 保留 60px 原文 + 追加 96px（CSS 后者生效），保证 strip 字节级还原。
    name: "headerWidth",
    anchor: ".qDHVXG_headerActions{opacity:1;visibility:visible;max-width:60px;",
    build: ({ begin, end }) =>
      `.qDHVXG_headerActions{opacity:1;visibility:visible;max-width:60px;${begin}max-width:96px;${end}`,
  },
  {
    // R15 WorkspaceBrowser 根部隐藏容器：挂载 sessionMenu 注册组件。
    name: "menuHost",
    anchor: [
      "\t\t\t\t\t})",
      "\t\t\t\t]",
      "\t\t\t});",
      "\t\t}",
      "\t\t//#endregion",
    ].join("\n"),
    build: ({ begin, end }) => [
      `\t\t\t\t\t})${begin},`,
      `\t\t\t\t\trenderSlot("sidebar.workspaces.sessionMenu", { registerSessionMenu: dshRegisterSessionMenu })${end}`,
      "\t\t\t\t]",
      "\t\t\t});",
      "\t\t}",
      "\t\t//#endregion",
    ].join("\n"),
  },
];

const MARKERS = regions.map(({ name }) => R(name));

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 补丁是否已生效：全部 region 标记存在。 */
export function checkPatch(content) {
  if (typeof content !== "string") return false;
  return MARKERS.every(({ begin, end }) => content.includes(begin) && content.includes(end));
}

/** 逐区报告锚点状态（ok / missing / ambiguous）——升级后漂移排查用。 */
export function regionStatus(content) {
  if (typeof content !== "string") return [{ name: "(content)", status: "missing" }];
  return regions.map(({ name, anchor }) => {
    const first = content.indexOf(anchor);
    if (first === -1) return { name, status: "missing" };
    if (content.indexOf(anchor, first + anchor.length) !== -1) return { name, status: "ambiguous" };
    return { name, status: "ok" };
  });
}

/** 纯函数：对 content 应用补丁，返回 {content, applied}；锚点缺失/重复时抛错。 */
export function applyPatchText(content) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("patch target content is empty");
  }
  if (checkPatch(content)) return { content, applied: false };
  let out = content;
  for (const region of regions) {
    const { begin, end } = R(region.name);
    const anchor = region.anchor;
    const first = out.indexOf(anchor);
    if (first === -1) {
      throw new Error(`patch anchor not found in region "${region.name}"; the bundle layout may have changed — refusing to write`);
    }
    if (out.indexOf(anchor, first + anchor.length) !== -1) {
      throw new Error(`patch anchor is ambiguous in region "${region.name}"; refusing to write`);
    }
    out = out.replace(anchor, region.build({ begin, end }));
  }
  if (!checkPatch(out)) {
    throw new Error("patch verification failed after applying all regions");
  }
  return { content: out, applied: true };
}

/** 纯函数：按标记摘除全部插入区（版本解耦的逆操作）；无标记 = no-op。 */
export function stripPatch(content) {
  if (typeof content !== "string") return content;
  let out = content;
  for (const { begin, end } of MARKERS) {
    out = out.replace(new RegExp(escapeRegExp(begin) + "[\\s\\S]*?" + escapeRegExp(end), "g"), "");
  }
  return out;
}

/** 读取目标文件。 */
export function readTarget(target = defaultTarget()) {
  if (!existsSync(target)) return null;
  return readFileSync(target, "utf8");
}

/** 原子写：同目录 tmp + rename。 */
export function writeTargetAtomic(target, content) {
  const tmp = join(dirname(target), `.dsh-session-delete-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, target);
  } catch (error) {
    try {
      writeFileSync(tmp, "", "utf8");
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
// 仅在作为主模块执行时运行；被 import（host 半 / test.mjs）时零副作用。
import { pathToFileURL } from "node:url";

const isMain = process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href;

function parseArgs(argv) {
  const command = argv[0];
  let target;
  const targetIndex = argv.indexOf("--target");
  if (targetIndex !== -1 && argv[targetIndex + 1] !== void 0) target = resolve(argv[targetIndex + 1]);
  return { command, target: target ?? defaultTarget() };
}

function report(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function runCli(argv) {
  const { command, target } = parseArgs(argv);
  if (command === "status") {
  const content = readTarget(target);
  if (content === null) {
    report({ patched: false, path: target, error: "target not found" });
    process.exitCode = 1;
  } else {
    report({ patched: checkPatch(content), path: target });
  }
} else if (command === "apply") {
  try {
    const content = readTarget(target);
    if (content === null) throw new Error("target not found");
    const { content: next, applied } = applyPatchText(content);
    if (!applied) {
      report({ ok: true, applied: false, already: true, path: target });
    } else {
      writeTargetAtomic(target, next);
      report({ ok: true, applied: true, path: target });
    }
  } catch (error) {
    report({ ok: false, applied: false, path: target, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else if (command === "strip") {
  try {
    const content = readTarget(target);
    if (content === null) throw new Error("target not found");
    const next = stripPatch(content);
    if (next === content) {
      report({ ok: true, stripped: false, already: true, path: target });
    } else {
      writeTargetAtomic(target, next);
      report({ ok: true, stripped: true, path: target });
    }
  } catch (error) {
    report({ ok: false, stripped: false, path: target, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else if (command === "verify") {
  try {
    const content = readTarget(target);
    if (content === null) throw new Error("target not found");
    const regionsReport = regionStatus(content);
    const bad = regionsReport.filter((region) => region.status !== "ok");
    report({
      ok: bad.length === 0,
      patched: checkPatch(content),
      path: target,
      regions: regionsReport,
      ...(bad.length > 0 ? { failures: bad } : {}),
    });
    if (bad.length > 0) process.exitCode = 1;
  } catch (error) {
    report({ ok: false, path: target, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} else {
  report({ ok: false, error: `unknown command "${command}" (expected status|apply|strip|verify)` });
  process.exitCode = 1;
}
}

if (isMain) runCli(process.argv.slice(2));
