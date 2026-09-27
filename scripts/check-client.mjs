#!/usr/bin/env node
// check-client.mjs — 客户端半的 SSR 冒烟演练（本地验证，非 CI）。
//
// 回答一个问题：在真实 React 下，本插件注册进原生槽的每个组件都渲染得出来吗？
//
// 做法：
//   1) 用真实 React + react-dom/server；
//   2) 用真实 SlotCore 复刻官方声明树（root → shell.overlay / settings.section /
//      sidebar.footer.action / sidebar.workspaces → session.menu.item）；
//   3) 按 loader 契约加载 client.js 并 apply；
//   4) 把每个注册组件都用 SSR 渲染一次，断言不抛错且产出 HTML。
//
// 需要本机 npx 缓存树中的 react / react-dom / dsh-client-ui-slots。
// 用法：node scripts/check-client.mjs
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_NPX = "C:/Users/cynsg/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules";
const npx = (p) => createRequire(join(DSH_NPX, p, "package.json"));

let React;
let ReactDOMServer;
let SlotCore;
try {
  React = npx("react")("react");
  ReactDOMServer = npx("react-dom")("react-dom/server");
  SlotCore = npx("@deepseek-ai/dsh-client-ui-slots")("@deepseek-ai/dsh-client-ui-slots").SlotCore;
} catch (error) {
  console.error("无法加载 react / react-dom / dsh-client-ui-slots：", error.message);
  console.error("");
  console.error("说明：Web 客户端本体用的是 preact + 兼容别名，npx 缓存树里通常并不存在");
  console.error("独立的 react / react-dom。因此本脚本只在本机确实装了 React 时才可运行");
  console.error("（可 `npm i -D react react-dom` 后重试），CI 与日常回归请以 node --test 为准。");
  process.exit(1);
}

// ── 1) 加载客户端半 ────────────────────────────────────────────────────────
const source = readFileSync(join(repoRoot, "client.js"), "utf8");
const specs = [];
const fakeWindow = { __ModuleLoader__: { load: (spec) => specs.push(spec) } };
const fakeDocument = {
  createElement: () => ({ dataset: {}, style: {}, remove() {} }),
  head: { appendChild() {} },
};
const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { stalePatch: false } }) });
const moduleObject = { exports: {} };
const loader = new Function(
  "window",
  "document",
  "fetch",
  "module",
  "exports",
  "require",
  `${source}\nreturn module.exports;`,
);
loader(fakeWindow, fakeDocument, fakeFetch, moduleObject, moduleObject.exports, () => React);

const spec = specs[0];
if (spec === undefined) {
  console.error("client.js 没有通过 window.__ModuleLoader__.load 注册");
  process.exit(1);
}
console.log("loader id:", spec.id);

// ── 2) 官方声明树（与 test.mjs 一致）──────────────────────────────────────
const core = new SlotCore();
core.register(
  {
    name: "root",
    children: {
      "shell.overlay": { kind: "list", scope: "root" },
      "settings.section": { kind: "list", scope: "root" },
      "sidebar.footer.action": { kind: "list", scope: "root" },
      "sidebar.workspaces": { kind: "list", scope: "root" },
    },
  },
  () => null,
);
core.register(
  {
    name: "sidebar.workspaces",
    id: "workspace-browser",
    children: {
      "sidebar.workspaces.session.menu.item": { kind: "list", scope: "root" },
      "sidebar.workspaces.session.row.action": { kind: "list", scope: "root" },
    },
  },
  () => null,
);

// ── 3) apply ──────────────────────────────────────────────────────────────
const exported = spec.factory(() => React);
const slots = {
  register: (options, component) => core.register(options, component),
  inject: (key, callback) => {
    const disposers = callback();
    return () => {
      for (const dispose of [...disposers].reverse()) dispose();
    };
  },
};
const ctx = {
  slots,
  sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ current: null }) } },
  effect: (factory) => factory(),
  locale: { register: () => {}, bind: () => (key) => key },
};
exported.apply(ctx);

// ── 4) 逐个组件 SSR ───────────────────────────────────────────────────────
const NOW = Date.now();
const sessionsValue = {
  phase: "ready",
  current: "session-1",
  ids: ["session-1", "session-2"],
  byId: {
    "session-1": { id: "session-1", title: "当前会话", updatedAt: NOW, running: false },
    "session-2": { id: "session-2", title: "另一个会话", updatedAt: NOW - 3600_000, running: true },
  },
};
const workspacesValue = { phase: "ready", items: [], archivedSessionIds: ["session-2"] };
const fakeHook = (value) => (selector) => (typeof selector === "function" ? selector(value) : value);

const propsBySlot = {
  "sidebar.workspaces.session.menu.item": {
    sessionId: "session-2",
    displayTitle: "另一个会话",
    useMenuOpenState: () => [false, () => {}],
  },
  "sidebar.footer.action": { wide: true },
};
const defaultProps = {
  t: (key) => key,
  wide: true,
  useSessions: fakeHook(sessionsValue),
  useWorkspaces: fakeHook(workspacesValue),
};

function collectEntries(nodes, out = []) {
  for (const node of nodes) {
    if (node.type !== "slot") continue;
    const components = core.entriesOfSlot(node.name);
    for (const entry of node.occupants) {
      if (!entry.active) continue;
      const live = components.find((candidate) => candidate.options.id === entry.id);
      if (live !== undefined) out.push({ slot: node.name, id: entry.id, component: live.component });
    }
    collectEntries(node.children, out);
  }
  return out;
}

const rendered = [];
for (const item of collectEntries(core.snapshot())) {
  const props = { ...defaultProps, ...(propsBySlot[item.slot] ?? {}) };
  try {
    const html = ReactDOMServer.renderToString(React.createElement(item.component, props));
    rendered.push({ slot: item.slot, id: item.id, length: html.length });
  } catch (error) {
    console.error(`SSR THREW for ${item.slot} (${item.id}):`);
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

console.log("registered entries:", rendered.length);
for (const item of rendered) console.log(`  ✔ ${item.slot} [${item.id}] → ${item.length} bytes`);
if (rendered.length < 5) {
  console.error("期望至少 5 个注册项（会话菜单 ×2 + overlay + footer + 设置分区）");
  process.exit(1);
}
console.log("ALL native-slot components rendered under real React — OK");
