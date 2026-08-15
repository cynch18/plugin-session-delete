// render-check.mjs — 渲染级演练（本地验证，非 CI）。
// 用真实 React + react-dom/server 渲染补丁版 WorkspaceBrowser，
// 断言三个槽出口全部触发（渲染不崩溃 + renderSlot 透传链完整）。
// 需要本机 npx 缓存树中的 react/react-dom/dsh-client-ui-slots。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const npx = (p) =>
  createRequire(`C:/Users/cynsg/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/${p}/package.json`);

const React = npx("react")("react");
const ReactDOMServer = npx("react-dom")("react-dom/server");
const { SlotCore } = npx("@deepseek-ai/dsh-client-ui-slots")("@deepseek-ai/dsh-client-ui-slots");

const bundlePath = "C:/Users/cynsg/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js";
const src = readFileSync(bundlePath, "utf8");

const factories = [];
globalThis.window = { __ModuleLoader__: { load: (def) => factories.push(def) } };
const fn = new Function("window", "require", "module", "exports", `${src}\n;return undefined;`);
fn(globalThis.window, () => ({ default: {} }), { exports: {} }, {});

const PrimitiveStub = (props) => React.createElement("stub", { "data-stub": true }, props && props.children);
const primitivesProxy = new Proxy({}, { get: () => PrimitiveStub });

const runtimeStub = {
  defineStore: () => () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, actions: {} }),
  useNativeDragAcceptance: () => {},
  indexSubagentDescendants: () => new Map(),
};

const stubRequire = (spec) => {
  if (spec === "react") return React;
  if (spec === "react/jsx-runtime") return npx("react")("react/jsx-runtime");
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesProxy;
  if (spec === "@deepseek-ai/dsh-client-runtime/client") return runtimeStub;
  return { default: {} };
};

const def = factories.find((d) => d.id === "@deepseek-ai/dsh-client-ui-workspace");
const workspaceExports = def.factory(stubRequire);

const core = new SlotCore();
core.register({ name: "root", children: { sidebar: { kind: "single", scope: "root" } }, id: "root-entry" }, () => null);
core.register({ name: "sidebar", children: { "sidebar.workspaces": { kind: "single", scope: "root" } }, id: "sidebar-entry" }, () => null);

let workspaceComponent = null;
const injectFactories = new Map();
const fakeCtx = {
  effect: (f) => { try { f(); } catch (e) { console.error("effect threw:", e?.message); } return () => {}; },
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject: (hole, factory) => injectFactories.set(hole, factory),
    register: (options, component) => {
      if (options.name === "sidebar.workspaces") workspaceComponent = component;
      return core.register(options, component);
    },
    entries: (hole) => core.entries(hole),
    subscribe: (hole, cb) => core.subscribe(hole, cb),
  },
};
workspaceExports.apply(fakeCtx);
injectFactories.get("sidebar.workspaces")();

if (!workspaceComponent) {
  console.error("WorkspaceBrowser component not captured");
  process.exit(1);
}

const now = Date.now();
const summary = {
  id: "session-1", title: "Test Session", updatedAt: now, running: false, blank: false,
  cwd: "D:\\deep seek", runningSubagentCount: 0, completed: false,
};
const fakeHook = (value) => (selector) => (typeof selector === "function" ? selector(value) : value);
const calls = [];
const props = {
  wide: true,
  expandSidebar: () => {},
  useSessions: fakeHook({ phase: "ready", current: "session-1", ids: ["session-1"], byId: { "session-1": summary } }),
  useWorkspaces: fakeHook({ items: [], phase: "ready", archivedSessionIds: [] }),
  useStore: fakeHook({ groupBy: "flat", orderBy: "updated", groupExpansion: {}, sessionOrderByAccount: {}, sessionUpdatedAtByAccount: {} }),
  actions: {
    setGroupBy: () => {}, setOrderBy: () => {}, setGroupExpanded: () => {},
    syncSessionOrderAccount: () => {}, setSessionOrder: () => {}, retainAccountKeys: () => {},
  },
  startSession: () => {}, open: () => {}, renameSession: async () => {}, forkSession: () => {},
  renameWorkspace: async () => {}, deleteWorkspace: async () => {}, insertWorkspaceBefore: async () => {},
  archiveSession: async () => {}, insertSessionBefore: async () => {}, createWorkspace: () => {},
  searchSessions: async () => ({ items: [], hasMore: false }), searchResultLimit: 20,
  useDirectoryFlow: () => false,
  renderSlot: (key, owner) => { calls.push([key, owner]); return null; },
  t: (key) => key,
};

try {
  const html = ReactDOMServer.renderToString(React.createElement(workspaceComponent, props));
  console.log("render OK, html length:", html.length);
  const keys = calls.map(([k]) => k);
  console.log("renderSlot calls:", JSON.stringify(keys));
  const need = ["sidebar.workspaces.headerAction", "sidebar.workspaces.sessionLead", "sidebar.workspaces.sessionMenu"];
  for (const k of need) {
    if (!keys.includes(k)) {
      console.error("MISSING renderSlot call:", k);
      process.exit(1);
    }
  }
  console.log("ALL three slot outlets rendered — prop threading chain complete");
} catch (error) {
  console.error("RENDER THREW:", error && error.stack ? error.stack : error);
  process.exit(1);
}
