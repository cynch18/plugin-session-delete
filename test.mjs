// test.mjs — patch-workspace-menu 纯函数单测（node --test）。
// 覆盖：checkPatch / applyPatchText（幂等、锚点缺失、锚点歧义、空输入）/
// stripPatch（字节级往返、幂等、no-op、部分标记清理）/ defaultTarget。
// 用真实目标文件内容做往返验证（只读，不写盘）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  checkPatch,
  applyPatchText,
  stripPatch,
  defaultTarget,
} from "./scripts/patch-workspace-menu.mjs";
import {
  isValidSessionId,
  isInsideSessionsRoot,
  isTrustedApiRequest,
} from "./index.js";

const target = defaultTarget();
// 夹具与线上状态解耦：无条件 strip（幂等——未打补丁时原样返回），
// 线上无论处于 0/12/14 区任意混合态，测试基准都是纯净原始内容。
const liveContent = existsSync(target) ? readFileSync(target, "utf8") : null;
const original = liveContent === null ? null : stripPatch(liveContent);

const REGION_NAMES = [
  "menuRegistry",
  "slotDecls",
  "headerAction",
  "nodeItemProps",
  "menuMerge",
  "menuSelect",
  "sessionLead",
  "treeProps",
  "treeItem",
  "flatProps",
  "flatItem",
  "flatCall",
  "treeCall",
  "headerWidth",
  "menuHost",
];

test("target file exists and is readable", () => {
  assert.ok(original !== null, `target not found: ${target}`);
  assert.ok(original.length > 100_000, "bundle looks too small to be the real client.js");
});

test("checkPatch: false on original, false on non-string, true on patched", () => {
  assert.equal(checkPatch(original), false);
  assert.equal(checkPatch(null), false);
  assert.equal(checkPatch(123), false);
  const { content: patched } = applyPatchText(original);
  assert.equal(checkPatch(patched), true);
});

test("applyPatchText: all region markers present in output", () => {
  const { content, applied } = applyPatchText(original);
  assert.equal(applied, true);
  for (const name of REGION_NAMES) {
    assert.ok(
      content.includes(`/* dsh-session-delete:region:${name}:begin */`),
      `missing begin marker for ${name}`,
    );
    assert.ok(
      content.includes(`/* dsh-session-delete:region:${name}:end */`),
      `missing end marker for ${name}`,
    );
  }
  // 三个槽声明必须出现
  for (const slot of ["headerAction", "sessionLead", "sessionMenu"]) {
    assert.ok(
      content.includes(`"sidebar.workspaces.${slot}": {`),
      `missing slot declaration ${slot}`,
    );
  }
});

test("stripPatch: byte-exact roundtrip strip(apply(x)) === x", () => {
  const { content: patched } = applyPatchText(original);
  assert.equal(stripPatch(patched), original);
});

test("applyPatchText: idempotent (second apply reports applied:false, content unchanged)", () => {
  const first = applyPatchText(original);
  const second = applyPatchText(first.content);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.content, first.content);
});

test("stripPatch: idempotent (double strip equals single strip)", () => {
  const { content: patched } = applyPatchText(original);
  const once = stripPatch(patched);
  assert.equal(stripPatch(once), once);
});

test("stripPatch: no-op on unpatched content", () => {
  assert.equal(stripPatch(original), original);
});

test("stripPatch: removes foreign marker-wrapped junk and restores original", () => {
  const junk = "/* dsh-session-delete:region:menuRegistry:begin */JUNK/* dsh-session-delete:region:menuRegistry:end */";
  const polluted = original.replace(
    "let react = require(\"react\");",
    `let react = require("react");${junk}`,
  );
  assert.equal(stripPatch(polluted), original);
});

test("applyPatchText: anchor missing → loud error naming the region", () => {
  // 破坏 headerAction 锚点（ViewOptionsMenu 行）。
  const broken = original.replace(
    "children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {",
    "children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenuX, {",
  );
  assert.throws(() => applyPatchText(broken), /region "headerAction"/);
});

test("applyPatchText: ambiguous anchor → refuses to write", () => {
  // 复制一份 SessionNodeItem 解构行，制造歧义。
  const line =
    "\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {";
  const doubled = original.replace(line, `${line}\n${line}`);
  assert.throws(() => applyPatchText(doubled), /ambiguous.*region "nodeItemProps"/);
});

test("applyPatchText: empty/non-string input rejects", () => {
  assert.throws(() => applyPatchText(""), /empty/);
  assert.throws(() => applyPatchText(null), /empty/);
});

test("defaultTarget: resolves under profiles\\node_modules\\@deepseek-ai\\dsh-client-ui-workspace", () => {
  const normalized = target.replace(/\\/g, "/");
  assert.ok(
    normalized.endsWith(
      join("profiles", "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js").replace(/\\/g, "/"),
    ),
    `unexpected target: ${target}`,
  );
});

test("renderSlot prop threading: all JSX call sites wired (text-level regression)", () => {
  const { content: patched } = applyPatchText(original);
  const count = (text) => (patched.match(new RegExp(text, "g")) ?? []).length;
  // 原始文件有 2 处 "renderSlot,"（WorkspacePicker / WorkspaceBrowser 解构）；
  // 补丁后应新增 7 处：nodeItemProps/treeProps/flatProps 解构 + treeItem/flatItem/flatCall/treeCall 传参。
  assert.equal(count("renderSlot,"), 9, "expected 9 occurrences of 'renderSlot,' (2 original destructures + 7 wired)");
  // renderSlot( 调用点：原 directoryFlow 1 处 + 补丁 headerAction/sessionLead/sessionMenu 3 处。
  assert.equal(count('renderSlot\\("sidebar\\.workspaces'), 4, "expected 4 renderSlot() call sites");
});

test("headerActions max-width widened to fit the third button (text-level regression)", () => {
  const { content: patched } = applyPatchText(original);
  assert.ok(original.includes("max-width:60px"), "original css has 60px cap");
  assert.ok(patched.includes("max-width:96px"), "patched css appends 96px (later declaration wins)");
  assert.ok(patched.includes("max-width:60px"), "original 60px kept for strip roundtrip");
});

// ── host 纯函数 ─────────────────────────────────────────────────────────────

test("isValidSessionId: accepts UUID-shaped ids, rejects garbage", () => {
  assert.equal(isValidSessionId("d0bf3c76-b59e-46a7-9912-ed98ded5d861"), true);
  assert.equal(isValidSessionId("D0BF3C76-B59E-46A7-9912-ED98DED5D861"), true);
  assert.equal(isValidSessionId("not-a-uuid"), false);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(123), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId("x".repeat(201)), false);
});

test("isInsideSessionsRoot: strict-inside fence", () => {
  const root = "C:\\Users\\x\\.dsh\\sessions";
  assert.equal(isInsideSessionsRoot(root, root + "\\--proj--\\session-abc"), true);
  assert.equal(isInsideSessionsRoot(root, root), false);
  assert.equal(isInsideSessionsRoot(root, "C:\\Users\\x\\.dsh"), false);
  assert.equal(isInsideSessionsRoot(root, "C:\\Users\\x\\.dsh\\other"), false);
  assert.equal(isInsideSessionsRoot(root, ""), false);
  assert.equal(isInsideSessionsRoot(root, null), false);
  assert.equal(isInsideSessionsRoot(root, root + "\\..\\sessions2\\s"), false);
});

test("isTrustedApiRequest: loopback + same-origin fence", () => {
  const req = (headers) => ({ headers });
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080" })), true);
  assert.equal(isTrustedApiRequest(req({ host: "localhost:3080" })), true);
  assert.equal(isTrustedApiRequest(req({ host: "[::1]:3080" })), true);
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })), true);
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isTrustedApiRequest(req({ host: "192.168.1.5:3080" })), false);
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080", origin: "http://evil.example" })), false);
  assert.equal(isTrustedApiRequest(req({})), false);
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:3080", origin: "not-a-url" })), false);
});

// ── SlotCore 集成测试：补丁声明的 3 个槽必须在注册后的 entry.children 里 ──
// （回归防线：语法/strip 往返都抓不到的「插入位置语义错误」——新键被插到
//  children 对象闭合括号之外时，会被 SlotCore 选项白名单丢弃，浏览器渲染报
//  "slot is not declared by this entry's children"。）
test("slot declarations land INSIDE the workspace entry's children (SlotCore integration)", () => {
  const coreRequire = createRequire(
    "C:/Users/cynsg/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js",
  );
  const { SlotCore } = coreRequire("@deepseek-ai/dsh-client-ui-slots");

  const { content: patched } = applyPatchText(original);
  const factories = [];
  globalThis.window = {
    __ModuleLoader__: { load: (def) => factories.push(def) },
  };
  const fn = new Function("window", "require", "module", "exports", `${patched}\n;return undefined;`);
  fn(globalThis.window, () => ({ default: {} }), { exports: {} }, {});
  const def = factories.find((d) => d.id === "@deepseek-ai/dsh-client-ui-workspace");
  assert.ok(def, "workspace factory captured");

  const stubRequire = () => ({
    defineStore: () => () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, actions: {} }),
    default: {},
  });
  const workspaceExports = def.factory(stubRequire);

  const core = new SlotCore();
  core.register({ name: "root", children: { sidebar: { kind: "single", scope: "root" } }, id: "root-entry" }, () => null);
  core.register(
    { name: "sidebar", children: { "sidebar.workspaces": { kind: "single", scope: "root" } }, id: "sidebar-entry" },
    () => null,
  );

  const injectFactories = new Map();
  const fakeCtx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: { register() {}, bind: () => (key) => key },
    slots: {
      inject: (hole, factory) => injectFactories.set(hole, factory),
      register: (options, component) => core.register(options, component),
      entries: (hole) => core.entries(hole),
      subscribe: (hole, cb) => core.subscribe(hole, cb),
    },
  };
  workspaceExports.apply(fakeCtx);
  injectFactories.get("sidebar.workspaces")();

  const winners = core.entriesOfSlot("sidebar.workspaces");
  assert.equal(winners.length, 1, "workspace entry registered");
  const keys = winners[0].children ? Object.keys(winners[0].children) : [];
  assert.deepEqual(
    keys.sort(),
    [
      "sidebar.workspaces.directoryFlow",
      "sidebar.workspaces.headerAction",
      "sidebar.workspaces.sessionLead",
      "sidebar.workspaces.sessionMenu",
    ].sort(),
    "entry.children must carry all four slots",
  );
  for (const slot of ["headerAction", "sessionLead", "sessionMenu"]) {
    assert.ok(core.spec(`sidebar.workspaces.${slot}`), `${slot} spec declared`);
  }
});
