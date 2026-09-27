// test.mjs — node --test 套件（0.2.x：无补丁架构）。
//
// 覆盖四层：
//   1) legacy 标记摘除器（纯函数，合成夹具，与任何 Harness 版本解耦）
//   2) host 半纯函数（sessionId 校验、回环围栏、导入面无写入能力）
//   3) 客户端半契约（真跑 apply：只注册官方原生槽；require 面最小；
//      注册行为经真实 SlotCore 断言；无 apply-patch / 无自动刷新）
//   4) 清单契约（package.json dsh.client 双面包声明）
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  checkPatch,
  defaultTarget,
  markerRegions,
  patchState,
  stripPatch,
} from "./scripts/patch-workspace-menu.mjs";
import {
  findSessionMeta,
  isInsideSessionsRoot,
  isValidSessionId,
  isTrustedApiRequest,
  sessionIdVariants,
  sessionUuidTail,
} from "./index.js";
import { registerPatchEntry } from "./scripts/install.mjs";

const repoRoot = resolveRepoRoot();
const target = defaultTarget();

function resolveRepoRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

// 官方槽位键（对 @deepseek-ai/* 各包 lib/client.js 的声明表实测枚举所得）。
// 我方**实际注册**的落点，以及 ui-sidebar 声明的 sidebar.footer.action。
const REGISTERED_SLOTS = {
  "sidebar.workspaces.session.menu.item": "list",
  "shell.overlay": "list",
  "sidebar.footer.action": "list",
  "settings.section": "list",
};
/** 刻意不注册的槽：行尾悬停按钮默认关闭（避免每行多一个误触入口）。 */
const UNUSED_SLOTS = ["sidebar.workspaces.session.row.action"];

/**
 * 用真实 SlotCore 复刻官方客户端的声明树（只保留结构，不含组件）：
 * root → shell.overlay / settings.section / sidebar.footer.action / sidebar.workspaces
 * sidebar.workspaces → session.menu.item / session.row.action
 * 这样 `slots.register` 面对的就是和线上一致的"父项 children 表已声明"前提。
 */
function declareOfficialTree(core) {
  const root = core.register(
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
  const browser = core.register(
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
  return [root, browser];
}

const NPX_ROOT = "C:/Users/cynsg/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules";
const SLOTS_ENTRY = `${NPX_ROOT}/@deepseek-ai/dsh-client-ui-slots/lib/index.js`;
const hasNpxSlots = existsSync(SLOTS_ENTRY);
/** 真实 SlotCore 只在本机 DSH 安装树上可用；CI 上依赖它的用例整体跳过。 */
const skipSlotCore = hasNpxSlots ? false : "dsh-client-ui-slots unavailable (CI)";

// ── 1) legacy 标记摘除器 ────────────────────────────────────────────────────

const BEGIN = (name) => `/* dsh-session-delete:region:${name}:begin */`;
const END = (name) => `/* dsh-session-delete:region:${name}:end */`;

test("markerRegions: 按出现顺序去重列出 region 名", () => {
  const text = `a${BEGIN("b")}x${END("b")}b${BEGIN("a")}y${END("a")}c${BEGIN("a")}z${END("a")}`;
  assert.deepEqual(markerRegions(text), ["b", "a"]);
  assert.deepEqual(markerRegions("plain text"), []);
  assert.deepEqual(markerRegions(null), []);
});

test("stripPatch: 成对标记整体摘除，逐字节还原", () => {
  const base = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  const polluted = base.replace("const b = 2;", `${BEGIN("slotDecls")}INJECTED${END("slotDecls")}const b = 2;`);
  assert.equal(stripPatch(polluted), base);
  assert.equal(stripPatch(stripPatch(polluted)), base);
  assert.equal(stripPatch(base), base, "无标记时 no-op");
  assert.equal(stripPatch(null), null);
});

test("stripPatch: 跨行插入区整体摘除（标记内的内容一个字都不留）", () => {
  const base = "A\nB\n";
  const junk = `${BEGIN("menuMerge")}\n\tline1,\n\tline2\n${END("menuMerge")}`;
  const out = stripPatch("A\n" + junk + "\nB\n");
  assert.equal(out.includes("line1"), false);
  assert.equal(out.includes("menuMerge"), false);
  assert.equal(out, "A\n\nB\n", "摘除的是标记区本身，不吞标记外的换行");
  assert.equal(stripPatch(out), out, "幂等");
});

test("stripPatch: 孤立标记保守保留（不猜边界），并在诊断里报为缺陷", () => {
  const orphan = `X${BEGIN("menuHost")}Y`;
  assert.equal(stripPatch(orphan), orphan, "只有 begin 没有 end：绝不吞掉后续内容");
  const state = patchState(orphan);
  assert.equal(state.stale, true);
  assert.deepEqual(state.regions, ["menuHost"]);
  assert.equal(state.defects.length, 1);
  assert.equal(state.defects[0].kind, "unbalanced");
});

test("patchState: 干净内容 / 非字符串 / 重复标记", () => {
  assert.deepEqual(patchState("clean").stale, false);
  assert.deepEqual(patchState(null).stale, false);
  assert.equal(checkPatch("clean"), false);

  const doubled = `${BEGIN("treeItem")}a${END("treeItem")}${BEGIN("treeItem")}b${END("treeItem")}`;
  const state = patchState(doubled);
  assert.equal(state.stale, true);
  assert.equal(state.defects.length, 1);
  assert.equal(state.defects[0].kind, "duplicated");
  assert.equal(state.defects[0].count, 2);
  assert.equal(checkPatch(doubled), true);
  assert.equal(stripPatch(doubled), "", "重复标记也全部摘除");
});

test("patchState: 只有 end 标记 → orphan-end 缺陷", () => {
  const state = patchState(`x${END("headerWidth")}y`);
  assert.equal(state.stale, false, "没有 begin 不算曾改写");
  assert.equal(state.defects.length, 1);
  assert.equal(state.defects[0].kind, "orphan-end");
});

test("defaultTarget: 落在 profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js", () => {
  const normalized = target.replace(/\\/g, "/");
  assert.ok(
    normalized.endsWith(
      join("profiles", "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js").replace(/\\/g, "/"),
    ),
    `unexpected target: ${target}`,
  );
});

// 环境相关：只有真实 bundle 存在时才跑（CI 上跳过）。
const liveContent = existsSync(target) ? readFileSync(target, "utf8") : null;
const skipLive = liveContent === null ? "client bundle unavailable (CI)" : false;

test("真实 bundle：诊断能给出确定答案（当前机器应为 clean）", { skip: skipLive }, () => {
  const state = patchState(liveContent);
  assert.equal(typeof state.stale, "boolean");
  assert.ok(Array.isArray(state.regions));
  if (state.stale) {
    assert.ok(state.regions.length > 0, "stale 必须能说出是哪些 region");
  }
});

// ── 2) host 半纯函数与导入面 ───────────────────────────────────────────────

test("sessionIdVariants: 两种拼写、去重、垃圾输入安全", () => {
  const id = "ea3e0f52-4c7e-4d10-94df-b4e65be1bcce";
  assert.deepEqual(sessionIdVariants(`session-${id}`), [`session-${id}`, id]);
  assert.deepEqual(sessionIdVariants(id), [id, `session-${id}`]);
  assert.deepEqual(sessionIdVariants(""), [""]);
  assert.deepEqual(sessionIdVariants(null), [null]);
  assert.equal(new Set(sessionIdVariants("session-session-x")).size, 2);
});

test("isValidSessionId: 接受 harness id / 裸 uuid / 安全自定义 id；拒绝危险输入", () => {
  assert.equal(isValidSessionId("session-ea3e0f52-4c7e-4d10-94df-b4e65be1bcce"), true);
  assert.equal(isValidSessionId("d0bf3c76-b59e-46a7-9912-ed98ded5d861"), true);
  assert.equal(isValidSessionId("D0BF3C76-B59E-46A7-9912-ED98DED5D861"), true);
  assert.equal(isValidSessionId("not-a-uuid"), true);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(123), false);
});

test("isInsideSessionsRoot: 路径围栏挡住上跳与绝对路径越界", () => {
  const root = process.platform === "win32" ? "C:\\home\\.dsh\\sessions" : "/home/.dsh/sessions";
  assert.equal(isInsideSessionsRoot(root, join(root, "session-abc")), true);
  assert.equal(isInsideSessionsRoot(root, join(root, "session-abc", "sub")), true);
  assert.equal(isInsideSessionsRoot(root, join(root, "..", "elsewhere")), false);
  assert.equal(isInsideSessionsRoot(root, root), false, "根本身不算内部条目");
  assert.equal(isInsideSessionsRoot(root, "."), false);
  assert.equal(isInsideSessionsRoot(null, root), false);
});

test("isTrustedApiRequest: 只信回环 Host，且拒绝跨站与异源 Origin", () => {
  const req = (host, extra = {}) => ({ headers: { host, ...extra } });
  assert.equal(isTrustedApiRequest(req("127.0.0.1:3080")), true);
  assert.equal(isTrustedApiRequest(req("localhost:3080")), true);
  assert.equal(isTrustedApiRequest(req("[::1]:3080")), true);
  assert.equal(isTrustedApiRequest(req("127.0.0.1:3080", { "sec-fetch-site": "cross-site" })), false);
  assert.equal(isTrustedApiRequest(req("127.0.0.1:3080", { origin: "http://evil.example" })), false);
  assert.equal(isTrustedApiRequest(req("127.0.0.1:3080", { origin: "http://127.0.0.1:3080" })), true);
  assert.equal(isTrustedApiRequest(req("192.168.1.9:3080")), false, "--host 0.0.0.0 场景：非回环一律拒绝");
  assert.equal(isTrustedApiRequest(req(undefined)), false);
  assert.equal(isTrustedApiRequest(req("not a host")), false);
});

test("host 导入面：不引入任何写入 / 打补丁能力", () => {
  const source = readFileSync(join(repoRoot, "index.js"), "utf8");
  for (const forbidden of ["applyPatchText", "writeTargetAtomic", "regionStatus"]) {
    assert.equal(source.includes(forbidden), false, `index.js 不应再引用 ${forbidden}`);
  }
  assert.equal(source.includes("/apply-patch"), false, "不应再提供 apply-patch 端点");
  assert.ok(source.includes('new Set(["delete", "status", "diagnose"])'), "API 应暴露 delete / status / diagnose");
});

test("sessionUuidTail: 两种拼写都能取到 uuid 尾段", () => {
  const uuid = "067f262c-7829-4f0c-9196-b47ab228ac67";
  assert.equal(sessionUuidTail(uuid), uuid);
  assert.equal(sessionUuidTail(`session-${uuid}`), uuid);
  assert.equal(sessionUuidTail(uuid.toUpperCase()), uuid, "大小写不敏感");
  assert.equal(sessionUuidTail("not-an-id"), undefined);
  assert.equal(sessionUuidTail(null), undefined);
});

test("findSessionMeta: 兼容 persistence.list() 的快照形状（id 在 .header.id）", async () => {
  const uuid = "067f262c-7829-4f0c-9196-b47ab228ac67";
  const prefixed = `session-${uuid}`;
  const header = { id: uuid, cwd: "D:\\deep seek" };
  // 真实后端返回 { header, revision, sizeBytes }（jsonl 后端 list() 的快照形状）
  const snapshot = { header, revision: "abc:1", sizeBytes: 1234 };
  const ctx = {
    get: (name) =>
      name === "sessions" ? { get: () => undefined } : name === "sessionPersistence" ? { list: async () => [snapshot] } : undefined,
  };
  assert.deepEqual(await findSessionMeta(ctx, prefixed), header, "应从快照里拆出 header 并按尾段命中");
  assert.deepEqual(await findSessionMeta(ctx, uuid), header, "原样拼写命中");
  // 裸 header 数组（另一种可能的形状）也必须继续工作
  const flat = { get: (name) => (name === "sessions" ? { get: () => undefined } : { list: async () => [header] }) };
  assert.deepEqual(await findSessionMeta(flat, prefixed), header);
});

test("findSessionMeta: id 拼写漂移不再表现为「会话不存在」", async () => {
  const uuid = "067f262c-7829-4f0c-9196-b47ab228ac67";
  const prefixed = `session-${uuid}`;
  const meta = { id: uuid, cwd: "D:\\deep seek" };

  // 场景 A：磁盘持有裸 uuid（老会话），客户端发 session- 前缀（界面显示形式）
  const ctxA = {
    get: (name) =>
      name === "sessions" ? { get: () => undefined } : name === "sessionPersistence" ? { list: async () => [meta] } : undefined,
  };
  assert.deepEqual(await findSessionMeta(ctxA, prefixed), meta, "应通过 uuid 尾段兜底命中");
  assert.deepEqual(await findSessionMeta(ctxA, uuid), meta, "原样拼写也要命中");

  // 场景 B：会话只活在内存里（未落盘），持有带前缀的 id
  const liveOnly = { get: (id) => (id === prefixed ? { header: { id: prefixed } } : undefined) };
  const ctxB = { get: (name) => (name === "sessions" ? liveOnly : undefined) };
  assert.deepEqual(await findSessionMeta(ctxB, uuid), { id: prefixed }, "反向漂移也要靠变体命中");

  // 场景 C：真的不存在 → undefined（不误报、不误删）
  const ctxC = {
    get: (name) => (name === "sessions" ? { get: () => undefined } : { list: async () => [] }),
  };
  assert.equal(await findSessionMeta(ctxC, prefixed), undefined);
});

// ── 3) 客户端半契约 ────────────────────────────────────────────────────────

/**
 * 最小 DOM 替身，专门用来验证"设置导航换图标"：
 * 不引第三方依赖（本机没装 jsdom），只实现那段代码真正用到的 API。
 * 结构复刻 dsh-client-ui-settings-general 渲染出的设置弹层：
 *   body > div[role=dialog] > nav > button > [span.navIcon > svg], span.navLabel
 */
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.parentElement = null;
    this.textContent = "";
    this.dataset = {};
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
  removeAttribute(key) { delete this.attrs[key]; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { this.removed = true; }
  get firstElementChild() { return this.children[0] ?? null; }
  get outerHTML() {
    const attrs = Object.entries(this.attrs).map(([key, value]) => ` ${key}="${value}"`).join("");
    return `<${this.tagName}${attrs}>${this.children.map((child) => child.outerHTML).join("")}</${this.tagName}>`;
  }
  replaceWith(next) {
    const list = this.parentElement.children;
    const index = list.indexOf(this);
    if (index !== -1) list[index] = next;
    next.parentElement = this.parentElement;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const [ancestor, target] = selector.includes(" ") ? selector.split(" ") : [null, selector];
    const matches = (node, simple) => {
      const attr = /^\[([^\]]+)\]$/.exec(simple);
      if (attr !== null) return Object.prototype.hasOwnProperty.call(node.attrs, attr[1]);
      return node.tagName === simple;
    };
    const hasAncestor = (node, name) => {
      let parent = node.parentElement;
      while (parent !== null) {
        if (matches(parent, name)) return true;
        parent = parent.parentElement;
      }
      return false;
    };
    const out = [];
    const stack = [...this.children];
    while (stack.length > 0) {
      const node = stack.shift();
      if ((ancestor === null || hasAncestor(node, ancestor)) && matches(node, target)) out.push(node);
      stack.push(...node.children);
    }
    return out;
  }
}

/** 造一个设置弹层：两行导航（我们那一行 + 别的分区一行）。 */
function buildSettingsDom(ourLabel) {
  const observers = [];
  const body = new FakeEl("body");
  const dialog = new FakeEl("div");
  dialog.setAttribute("role", "dialog");
  const nav = new FakeEl("nav");
  dialog.appendChild(nav);
  body.appendChild(dialog);

  const makeRow = (labelText) => {
    const button = new FakeEl("button");
    nav.appendChild(button);
    const iconWrap = new FakeEl("span");
    iconWrap.setAttribute("class", "navIcon");
    const gear = new FakeEl("svg");
    gear.setAttribute("width", "16");
    gear.setAttribute("height", "16");
    gear.setAttribute("viewBox", "0 0 24 24");
    gear.setAttribute("class", "gearClass");
    gear.appendChild(new FakeEl("path"));
    iconWrap.appendChild(gear);
    button.appendChild(iconWrap);
    const label = new FakeEl("span");
    label.setAttribute("class", "navLabel");
    label.textContent = labelText;
    button.appendChild(label);
    return { button, gear };
  };

  const ours = makeRow(ourLabel);
  const other = makeRow("外观");

  const documentStub = {
    body,
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
    head: { appendChild() {} },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return [dialog];
      return body.querySelectorAll(selector);
    },
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  return {
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    observerCount: () => observers.length,
    button: ours.button,
    otherGear: other.gear,
  };
}

/** 组装一个最小但真实的 client 运行环境：假 loader + React + 文档 + fetch。
 *  注意 loader 契约是 `factory(require)`，导出面以 **返回值** 为准（模块自身还会
 *  写 `module.exports`，但那是给 loader 用的第二通道，不能依赖）。 */
function loadClientModule({ React, document, fetchImpl, primitivesAvailable, MutationObserver } = {}) {
  const source = readFileSync(join(repoRoot, "client.js"), "utf8");
  const loaded = [];
  const requires = [];
  const globalWindow = {
    __ModuleLoader__: {
      load: (spec) => {
        loaded.push(spec);
      },
    },
  };
  const shim = {
    window: globalWindow,
    document: document ?? { createElement: () => ({ dataset: {}, remove() {}, style: {} }), head: { appendChild() {} } },
    fetch: fetchImpl ?? (() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) })),
  };
  const moduleObject = { exports: {} };
  const fakeRequire = (spec) => {
    requires.push(spec);
    if (spec === "react") return React;
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
      if (primitivesAvailable === false) throw new Error("simulated missing primitives");
      return { IconTrashOutlineRegular: (props) => ({ type: "OfficialTrashIcon", props }) };
    }
    throw new Error(`unexpected require("${spec}")`);
  };
  const factory = new Function(
    "window",
    "document",
    "fetch",
    "module",
    "exports",
    "require",
    `${source}\nreturn module.exports;`,
  );
  // MutationObserver 在模块里是自由变量（不像 document 那样作为形参注入），
  // 所以测试要临时挂到 globalThis 上，并在返回前还原。
  const previousObserver = globalThis.MutationObserver;
  if (MutationObserver !== undefined) globalThis.MutationObserver = MutationObserver;
  let result;
  try {
    factory(shim.window, shim.document, shim.fetch, moduleObject, moduleObject.exports, fakeRequire);
    const spec = loaded[0];
    assert.ok(spec !== undefined, "client.js 未通过 window.__ModuleLoader__.load 注册");
    result = spec.factory(fakeRequire);
  } finally {
    if (MutationObserver !== undefined) {
      if (previousObserver === undefined) delete globalThis.MutationObserver;
      else globalThis.MutationObserver = previousObserver;
    }
  }
  return { spec: loaded[0], result, requires };
}

/** 造一个够用的 React 替身：hook 返回稳定值并登记调用，createElement 直接返回描述对象。 */
function fakeReact() {
  const store = { effects: [], states: [] };
  return {
    store,
    // 与真实 React 对齐：createElement(type, props, ...children) —— 子节点是变参，
    // 忽略变参会让图标这类多子节点组件在遍历里消失。
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      store.subscribe = subscribe;
      return getSnapshot();
    },
    useState: (initial) => {
      const value = typeof initial === "function" ? initial() : initial;
      store.states.push(value);
      return [value, () => {}];
    },
    useEffect: (fn) => {
      store.effects.push(fn);
    },
    useMemo: (fn) => fn(),
  };
}

/**
 * 组装 apply 用的 fake ctx（真实 SlotCore + 假 sessions/locale），返回 ctx 与观测点。
 * 客户端契约测试与"设置导航换图标"测试共用，避免夹具漂移。
 *
 * SlotCore 只存在于本机 DSH 安装树里，CI 上没有（`SLOTS_ENTRY` 是绝对路径）。
 * 所以这里必须能优雅降级：拿不到真实 SlotCore 时用记录型替身，
 * 让不依赖注册语义的用例（如换图标）在 CI 上照常跑。
 */
function makeApplyContext() {
  const core = loadSlotCore();
  const officialDisposers = core === null ? [] : declareOfficialTree(core);
  const registered = [];
  const slots = {
    register: (options, component) => {
      registered.push({ options, component });
      return core === null ? () => {} : core.register(options, component);
    },
    inject: (key, callback) => {
      const disposers = callback();
      return () => {
        for (const dispose of [...disposers].reverse()) dispose();
      };
    },
  };
  const locales = [];
  const ctx = {
    slots,
    sessions: {
      list: {
        getSnapshot: () => ({
          current: "session-current",
          byId: {
            // 关键夹具：`retainedBy.mainView > 0` 表示"被主视图打开过"（保留引用
            // 计数，不会归零），**不等于**"当前会话"。0.2.0 曾用它判当前会话，
            // 结果凡打开过的会话全被锁成灰色 → 功能等于废掉。这条夹具就是防回归。
            "session-current": { id: "session-current", running: false, retainedBy: { mainView: 1 } },
            "session-other": { id: "session-other", running: false, retainedBy: { mainView: 0 } },
            "session-busy": { id: "session-busy", running: true, retainedBy: { mainView: 0 } },
          },
        }),
      },
    },
    effect: (factory) => factory(),
    locale: {
      register: (ns, dicts) => locales.push({ ns, dicts }),
      // bind(ns) 需要真的能解析出文案（设置页分区名会走这条路径）；
      // register 在 apply 里先于此处被调用，所以能查到刚注册的字典。
      bind: (ns) => (key) => locales.find((entry) => entry.ns === ns)?.dicts?.zh?.[key] ?? key,
    },
  };
  return { ctx, core, locales, officialDisposers, registered };
}

/** 本机 DSH 安装树里是否存在 SlotCore（CI 上没有）。 */
function loadSlotCore() {
  if (!existsSync(SLOTS_ENTRY)) return null;
  try {
    const { SlotCore } = createRequire(import.meta.url)(SLOTS_ENTRY);
    return typeof SlotCore === "function" ? new SlotCore() : null;
  } catch {
    return null;
  }
}

test("client: 只注册官方原生槽（不依赖 SlotCore，CI 上也跑）", () => {
  const React = fakeReact();
  const { result } = loadClientModule({ React });
  const { ctx, registered } = makeApplyContext();
  result.apply(ctx);
  const slots = [...new Set(registered.map((entry) => entry.options.name))].sort();
  assert.deepEqual(slots, [
    "settings.section",
    "shell.overlay",
    "sidebar.footer.action",
    "sidebar.workspaces.session.menu.item",
  ]);
  for (const entry of registered) {
    assert.ok(typeof entry.options.id === "string" && entry.options.id.length > 0, "每个注册项都需要 id");
    assert.equal(typeof entry.component, "function", "每个注册项都需要组件");
  }
});

test("client: 只注册官方原生槽，且每个注册项都带 id/order/locale", { skip: skipSlotCore }, () => {
  const React = fakeReact();
  const { spec, result } = loadClientModule({ React });
  assert.equal(spec.id, "dsh-profile-plugin-session-delete", "loader id 必须与包名一致");
  assert.equal(typeof spec.factory, "function");
  assert.deepEqual(result.inject, ["slots", "sessions", "workspaces", "locale"]);

  // 真实 SlotCore：先声明官方槽树（模拟官方客户端包），再跑我们的 apply。
  const { ctx, core, locales, officialDisposers } = makeApplyContext();
  result.apply(ctx);

  const snapshot = core.snapshot();
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type !== "slot") continue;
      for (const occupant of node.occupants) flat.push({ slot: node.name, ...occupant });
      walk(node.children);
    }
  };
  walk(snapshot);

  for (const [slot, kind] of Object.entries(REGISTERED_SLOTS)) {
    const mine = flat.filter((entry) => entry.slot === slot);
    assert.ok(mine.length > 0, `expected at least one registration into ${slot}`);
    assert.equal(core.spec(slot).kind, kind);
    for (const entry of mine) {
      assert.ok(typeof entry.id === "string" && entry.id.length > 0, `${slot} entry needs an id`);
    }
  }
  for (const slot of UNUSED_SLOTS) {
    assert.equal(
      flat.some((entry) => entry.slot === slot),
      false,
      `${slot} 默认不应注册（避免每行多一个误触入口）`,
    );
  }

  // 单删与批量入口都在会话菜单，且 order 排在官方 archive(400) 之后。
  const menu = flat.filter((entry) => entry.slot === "sidebar.workspaces.session.menu.item");
  const ids = menu.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["session-delete", "session-delete-batch"]);
  for (const entry of menu) assert.ok(entry.order > 400, `order ${entry.order} should follow archive (400)`);

  // 渲染协议实测（dsh 0.1.7-rc.2）：注册项 inject 是零参工厂（渲染层无参调用、
  // 返回值并入组件 props），owner 行级数据（sessionId/displayTitle）由 renderSlot
  // 直接作为组件 props 传入。owner 参数型 inject 会被无参调用而崩溃
  // （"Cannot read properties of undefined (reading 'sessionId')"）。
  // 因此锁定状态必须在组件内部用 props.sessionId 计算（官方 PinSessionMenuItem
  // 的 usePinState(props) 即此模式），注册项不得声明 inject face。
  const menuEntries = core.entriesOfSlot("sidebar.workspaces.session.menu.item");
  assert.equal(menuEntries.length, 2);
  for (const entry of menuEntries) {
    assert.equal(entry.inject, undefined, `${entry.options.id} 不得声明 inject face（零参调用协议）`);
  }
  const mods = result.__menu ?? {};
  const menuOpen = () => [false, () => {}];
  const t = (key) => key;
  const rowEl = (sessionId) => mods.DeleteSessionMenuItem({ sessionId, displayTitle: "x", useMenuOpenState: menuOpen, t });
  assert.equal(rowEl("session-other").props.disabled, false, "既非当前也不在运行的会话不该被锁");
  // 回归防线：被主视图打开过（retainedBy.mainView > 0）**不是**锁定理由。
  assert.equal(rowEl("session-current").props.disabled, false, "打开过但已停止的会话必须可删");
  assert.equal(rowEl("session-current").props.title, undefined, "可删项不该带锁定提示");
  assert.equal(rowEl("session-busy").props.disabled, true, "运行中的会话必须锁定");
  assert.equal(rowEl("session-busy").props.title, "runningLocked");
  assert.equal(rowEl(undefined).props.disabled, false, "拿不到行数据时不得误锁");
  const batchEl = mods.BatchDeleteMenuItem({ useMenuOpenState: menuOpen, t });
  assert.equal(batchEl.props.disabled, undefined, "批量入口是全局面板入口，不做行级禁用");

  // 设置页分区必须有 label：设置页按 `resolveSlotLabel(entry.options.label) ?? id`
  // 取分区名，缺省会回退成条目 id（用户看到的就是"没名字"）。读取时无参调用。
  const sectionEntries = core.entriesOfSlot("settings.section");
  assert.equal(sectionEntries.length, 1);
  assert.equal(typeof sectionEntries[0].options.label, "function", "settings.section 必须声明 label（否则分区无名）");
  assert.equal(sectionEntries[0].options.label(), "删除会话", "label 必须解析出本地化分区名");

  // 删除动作是红色危险样式，且不再依赖任何自建菜单注册表。
  assert.equal(locales.length, 1);
  assert.equal(locales[0].ns, "sessionDelete");
  assert.deepEqual(Object.keys(locales[0].dicts.zh).sort(), Object.keys(locales[0].dicts.en).sort());

  // 卸载语义：官方声明折叠后，我方贡献必须能被完整清空。
  for (const dispose of officialDisposers) dispose();
  const after = core.snapshot();
  const left = [];
  const collect = (nodes) => {
    for (const node of nodes) {
      if (node.type !== "slot") continue;
      for (const occupant of node.occupants) left.push({ slot: node.name, id: occupant.id });
      collect(node.children);
    }
  };
  collect(after);
  assert.equal(left.length, 0, "官方槽树折叠后不应残留任何贡献");
});

test("client: require 面锁死（react + 官方 primitives 的垃圾桶图标）", () => {
  const React = fakeReact();
  const { spec, requires } = loadClientModule({ React });
  assert.equal(typeof spec.factory, "function");
  assert.deepEqual(
    requires,
    ["react", "@deepseek-ai/dsh-client-ui-primitives"],
    "只允许 react（平台种子）与 primitives（取官方 IconTrashOutlineRegular）",
  );
});

test("client: 拿不到官方图标时退回自带垃圾桶，绝不因 require 失败而崩", () => {
  const React = fakeReact();
  // primitivesAvailable: false → fakeRequire 抛错，模拟模块表里没有该包
  const { result } = loadClientModule({ React, primitivesAvailable: false });
  const mods = result.__menu;
  const el = mods.DeleteSessionMenuItem({
    sessionId: "someone",
    displayTitle: "x",
    useMenuOpenState: () => [false, () => {}],
    t: (key) => key,
  });
  // 图标槽位仍要渲染出图标节点：这里是**未渲染的元素树**，自带图标是函数组件
  // （type 即该函数），官方图标则是我的 stub 组件。
  const types = [];
  const visit = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object") return;
    if (node.type !== undefined) types.push(node.type);
    visit(node.children);
  };
  visit(el);
  assert.ok(
    types.some((type) => typeof type === "function" && type.name === "FallbackTrashIcon"),
    `拿不到官方图标时必须退回自带垃圾桶，实际节点: ${types.map((t) => (typeof t === "string" ? t : t?.name)).join(",")}`,
  );
  assert.equal(types.includes("OfficialTrashIcon"), false, "官方图标不可用时不得出现官方图标节点");
});

test("client: 设置导航那一行会被换成垃圾桶图标（且不碰别人）", () => {  // 契约事实（dsh-client-ui-settings-general/lib/client.js:239-265）：
  //   /** Nav glyph by section id; unknown ids fall back to the settings gear. */
  // 分区图标来自**硬编码白名单**，注册项没有 icon 字段，我们的 id 会吃默认齿轮。
  // 所以客户端必须自己在设置弹层挂载后，按标签文本找到自己那一行再换图标。
  // 之前这条路径**没有测试覆盖**（极简 document 替身会让它整体跳过）。
  const dom = buildSettingsDom("删除会话");
  const React = fakeReact();
  // MutationObserver 在模块里是自由变量（不是注入形参），测试临时挂到 globalThis
  // 并在断言前后还原；否则模块会拿到 Node 的真实实现而什么都不做。
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = dom.MutationObserver;
  try {
    const { result } = loadClientModule({ React, document: dom.document, MutationObserver: dom.MutationObserver });
    result.apply(makeApplyContext().ctx);
  } finally {
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
  const replaced = dom.button.firstElementChild.firstElementChild;
  assert.equal(replaced.tagName, "svg", "齿轮必须被换成一个 svg");
  assert.ok(replaced.getAttribute("data-session-delete-nav-icon") !== null, "替换物必须打标记（防自激循环）");
  assert.equal(replaced.getAttribute("width"), "16", "保留原尺寸");
  assert.equal(replaced.getAttribute("viewBox"), "0 0 24 24", "保留原视框");
  assert.equal(replaced.children.length, 5, "垃圾桶由 5 条 path 组成");
  assert.equal(replaced.getAttribute("stroke"), "currentColor", "跟随主题文字色");
  assert.equal(
    dom.otherGear.getAttribute("data-session-delete-nav-icon"),
    null,
    "别的分区（外观）的图标绝不能被改",
  );
  assert.ok(dom.observerCount() >= 1, "必须挂 MutationObserver 才能等到弹层挂载");
});

test("client: 源码里不存在任何打补丁 / 自动刷新 / apply-patch 的痕迹", () => {
  const source = readFileSync(join(repoRoot, "client.js"), "utf8");
  for (const forbidden of ["apply-patch", "applyPatchText", "location.reload", "setTimeout(() => window"]) {
    assert.equal(source.includes(forbidden), false, `client.js 不应再包含 ${forbidden}`);
  }
  assert.equal(source.includes("sidebar.workspaces.headerAction"), false, "该槽已不存在于 0.1.7");
  assert.equal(source.includes("sidebar.workspaces.sessionLead"), false, "该槽已不存在于 0.1.7");
  assert.equal(source.includes("sidebar.workspaces.sessionMenu"), false, "自建菜单槽已废弃");
});

// ── 4) 清单契约 ────────────────────────────────────────────────────────────

test("package.json: 双面包声明完整（dsh.client + exports['./client']）", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots"));
  assert.equal(pkg.exports["./client"], "./client.js");
  assert.equal(pkg.exports["."], "./index.js");
  assert.ok(pkg.keywords.includes("dsh-plugin"));
});

test("install.mjs registerPatchEntry: 幂等插入 cordis.patch.yml 顶层 insert 列表", () => {
  const yml = ["# profile patch", "- insert:", "    - id: existing", "      name: other"].join("\n");
  const first = registerPatchEntry(yml);
  assert.equal(first.changed, true);
  assert.ok(first.content.includes("- id: plugin-session-delete"));
  const second = registerPatchEntry(first.content);
  assert.equal(second.changed, false, "第二次必须 no-op");
  assert.equal(second.content, first.content);
});

test("install.mjs registerPatchEntry: 没有顶层 insert 列表时给出可见错误而不是猜", () => {
  const result = registerPatchEntry("# only comments\n");
  assert.equal(result.changed, false);
  assert.match(result.error, /no top-level "- insert:" list/);
});

test("安装脚本不再调用开槽 apply（源码级回归）", () => {
  for (const file of ["scripts/install.mjs", "scripts/install.ps1"]) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    assert.equal(/\bapplyPatchText\b/.test(source), false, `${file} 不应再调用 applyPatchText`);
    assert.equal(/\bpatchCli\s+apply\b/.test(source), false, `${file} 不应再调用 apply`);
  }
});

test("patch CLI: apply 子命令永久拒绝（开槽能力已移除）", () => {
  const source = readFileSync(join(repoRoot, "scripts/patch-workspace-menu.mjs"), "utf8");
  assert.ok(source.includes("开槽能力已移除"), "apply 必须明确拒绝并说明原因");
  assert.equal(source.includes("applyPatchText"), false);
});
