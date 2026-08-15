// test.mjs — 纯函数单测（node --test），本地全量 + CI 兼容。
// 本地（有真实 Harness 文件时）：覆盖 checkPatch / applyPatchText / stripPatch
// 的字节级往返、幂等、锚点缺失/歧义、SlotCore 集成注册、文本级回归断言。
// CI（无 Harness 文件时）：环境相关用例自动 skip，纯函数用例照常执行。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";import {
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
import { registerPatchEntry } from "./scripts/install.mjs";

const target = defaultTarget();
// 夹具与线上状态解耦：无条件 strip（幂等——未打补丁时原样返回）。
const liveContent = existsSync(target) ? readFileSync(target, "utf8") : null;
const original = liveContent === null ? null : stripPatch(liveContent);
const hasTarget = original !== null;
const skipEnv = hasTarget ? false : "target file unavailable (CI)";

const NPX_SLOTS =
  "C:/Users/cynsg/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js";
const hasNpx = existsSync(NPX_SLOTS);

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

test("target file exists and is readable", { skip: skipEnv }, () => {
  assert.ok(original.length > 100_000, "bundle looks too small to be the real client.js");
});

test("checkPatch: false on original, false on non-string, true on patched", { skip: skipEnv }, () => {
  assert.equal(checkPatch(original), false);
  assert.equal(checkPatch(null), false);
  assert.equal(checkPatch(123), false);
  const { content: patched } = applyPatchText(original);
  assert.equal(checkPatch(patched), true);
});

test("applyPatchText: all region markers present in output", { skip: skipEnv }, () => {
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
  for (const slot of ["headerAction", "sessionLead", "sessionMenu"]) {
    assert.ok(
      content.includes(`"sidebar.workspaces.${slot}": {`),
      `missing slot declaration ${slot}`,
    );
  }
});

test("stripPatch: byte-exact roundtrip strip(apply(x)) === x", { skip: skipEnv }, () => {
  const { content: patched } = applyPatchText(original);
  assert.equal(stripPatch(patched), original);
});

test("applyPatchText: idempotent (second apply reports applied:false, content unchanged)", { skip: skipEnv }, () => {
  const first = applyPatchText(original);
  const second = applyPatchText(first.content);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.content, first.content);
});

test("stripPatch: idempotent (double strip equals single strip)", { skip: skipEnv }, () => {
  const { content: patched } = applyPatchText(original);
  const once = stripPatch(patched);
  assert.equal(stripPatch(once), once);
});

test("stripPatch: no-op on unpatched content", { skip: skipEnv }, () => {
  assert.equal(stripPatch(original), original);
});

test("stripPatch: removes foreign marker-wrapped junk and restores original", { skip: skipEnv }, () => {
  const junk = "/* dsh-session-delete:region:menuRegistry:begin */JUNK/* dsh-session-delete:region:menuRegistry:end */";
  const polluted = original.replace(
    "let react = require(\"react\");",
    `let react = require("react");${junk}`,
  );
  assert.equal(stripPatch(polluted), original);
});

test("applyPatchText: anchor missing → loud error naming the region", { skip: skipEnv }, () => {
  const broken = original.replace(
    "children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {",
    "children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenuX, {",
  );
  assert.throws(() => applyPatchText(broken), /region "headerAction"/);
});

test("applyPatchText: ambiguous anchor → refuses to write", { skip: skipEnv }, () => {
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

test("renderSlot prop threading: all JSX call sites wired (text-level regression)", { skip: skipEnv }, () => {
  const { content: patched } = applyPatchText(original);
  const count = (text) => (patched.match(new RegExp(text, "g")) ?? []).length;
  assert.equal(count("renderSlot,"), 9, "expected 9 occurrences of 'renderSlot,' (2 original destructures + 7 wired)");
  assert.equal(count('renderSlot\\("sidebar\\.workspaces'), 4, "expected 4 renderSlot() call sites");
});

test("headerActions max-width widened to fit the third button (text-level regression)", { skip: skipEnv }, () => {
  const { content: patched } = applyPatchText(original);
  assert.ok(original.includes("max-width:60px"), "original css has 60px cap");
  assert.ok(patched.includes("max-width:96px"), "patched css appends 96px (later declaration wins)");
  assert.ok(patched.includes("max-width:60px"), "original 60px kept for strip roundtrip");
});

// ── CI 安全：不依赖真实文件的合成往返 ────────────────────────────────────
test("stripPatch/checkPatch: synthetic roundtrip without live file (CI-safe)", () => {
  const base =
    "const a = 1;\n" +
    "/* dsh-session-delete:region:slotDecls:begin */X/* dsh-session-delete:region:slotDecls:end */\n" +
    "const b = 2;";
  assert.equal(checkPatch(base), false); // 仅一对标记不算完整补丁
  assert.equal(stripPatch(base), "const a = 1;\n\nconst b = 2;");
  assert.equal(stripPatch(stripPatch(base)), stripPatch(base));
});

// ── host 纯函数 ─────────────────────────────────────────────────────────────

test("isValidSessionId: accepts harness ids (session-<uuid>), bare uuids, safe custom ids; rejects unsafe", () => {
  assert.equal(isValidSessionId("session-ea3e0f52-4c7e-4d10-94df-b4e65be1bcce"), true);
  assert.equal(isValidSessionId("d0bf3c76-b59e-46a7-9912-ed98ded5d861"), true);
  assert.equal(isValidSessionId("D0BF3C76-B59E-46A7-9912-ED98DED5D861"), true);
  assert.equal(isValidSessionId("not-a-uuid"), true);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(123), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId("x".repeat(201)), false);
  assert.equal(isValidSessionId("a/b"), false);
  assert.equal(isValidSessionId("a\\b"), false);
  assert.equal(isValidSessionId(".."), false);
  assert.equal(isValidSessionId("a b"), false);
  assert.equal(isValidSessionId("a:b"), false);
});

test("isInsideSessionsRoot: strict-inside fence", () => {
  // 平台无关：用 join() 生成路径（Windows 反斜杠 / POSIX 正斜杠都正确）。
  const root = join("C:", "Users", "x", ".dsh", "sessions");
  const inside = join(root, "--proj--", "session-abc");
  assert.equal(isInsideSessionsRoot(root, inside), true);
  assert.equal(isInsideSessionsRoot(root, root), false);
  assert.equal(isInsideSessionsRoot(root, join("C:", "Users", "x", ".dsh")), false);
  assert.equal(isInsideSessionsRoot(root, join("C:", "Users", "x", ".dsh", "other")), false);
  assert.equal(isInsideSessionsRoot(root, ""), false);
  assert.equal(isInsideSessionsRoot(root, null), false);
  assert.equal(isInsideSessionsRoot(root, join(root, "..", "sessions2", "s")), false);
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

// ── 安装器纯函数 ──────────────────────────────────────────────────────────
test("registerPatchEntry: generic anchor, idempotent, honest fallback", () => {
  const base =
    "# comment\n- insert:\n    - id: some-plugin\n      name: x\n      disabled: false\n\n- id: other\n  disabled: true\n";
  const first = registerPatchEntry(base);
  assert.equal(first.changed, true);
  assert.ok(first.content.includes("    - id: plugin-session-delete\n"));
  assert.ok(first.content.indexOf("plugin-session-delete") < first.content.indexOf("some-plugin"), "inserted right after - insert:");
  const second = registerPatchEntry(first.content);
  assert.equal(second.changed, false, "idempotent");
  const noInsert = registerPatchEntry("- id: other\n  disabled: true\n");
  assert.equal(noInsert.changed, false);
  assert.ok(noInsert.error.includes("add manually"), "honest fallback message");
});

// ── SlotCore 集成测试：补丁声明的 3 个槽必须在注册后的 entry.children 里 ──
test(
  "slot declarations land INSIDE the workspace entry's children (SlotCore integration)",
  { skip: !(hasTarget && hasNpx) ? "requires live target + local npx cache (CI skips)" : false },
  () => {
    const coreRequire = createRequire(NPX_SLOTS);
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
  },
);
