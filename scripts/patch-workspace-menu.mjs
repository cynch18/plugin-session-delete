#!/usr/bin/env node
// patch-workspace-menu.mjs — 旧版 sidebar 补丁的**标记摘除器**（legacy recovery only）。
//
// ⚠️ 本脚本不再提供"开槽"能力。
//
// 0.1.x 时代，本插件需要对 @deepseek-ai/dsh-client-ui-workspace 的浏览器打包文件
// 做文本级手术来获得三个 sidebar 槽位。自 DSH 0.1.7 起，官方客户端已经原生声明
// 了这些扩展点，插件改为走 ctx.slots.inject() 注册（见 client.js），**不需要也不
// 允许**再改写 Harness 的文件。
//
// 保留本文件的唯一目的：识别并摘除历史版本可能残留在目标 bundle 上的标记：
//
//   /* dsh-session-delete:region:<name>:begin */ ... /* dsh-session-delete:region:<name>:end */
//
// 与文件版本完全解耦——只按成对标记做外科摘除，不需要任何锚点，所以不会随着
// 上游换版本而失效。之所以要摘：残留标记意味着 bundle 曾被改写，属于陈旧状态，
// 会干扰诊断，也可能在未来某次上游重排中变成真正的语法破坏。
//
// 用法：
//   node patch-workspace-menu.mjs status [--target <path>]   # 只读：有无标记
//   node patch-workspace-menu.mjs verify [--target <path>]   # 只读：详情（含重复标记）
//   node patch-workspace-menu.mjs strip  [--target <path>]   # 摘除全部标记区（原子写）
//   node patch-workspace-menu.mjs apply  [--target <path>]   # 永远拒绝（开槽能力已移除）
//
// 本文件导出纯函数（patchState / stripPatch / checkPatch / readTarget /
// writeTargetAtomic / defaultTarget），供插件 host 半与 test.mjs 复用。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const MARKER_PREFIX = "dsh-session-delete:region:";
const BEGIN_RE = /\/\* dsh-session-delete:region:([A-Za-z0-9_.-]+):begin \*\//g;

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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 扫描内容里出现过的 region 标记名（begin 标记为准，按出现顺序去重）。 */
export function markerRegions(content) {
  if (typeof content !== "string") return [];
  const names = [];
  for (const match of content.matchAll(BEGIN_RE)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * 诊断：目标内容上残留了哪些旧补丁标记、是否有成对性缺陷。
 * 只读，永不写入。
 *
 * @param content - 目标文件全文（null 表示文件不存在）。
 * @returns 结构化诊断；`stale` 为真表示"曾被改写且仍留痕"。
 */
export function patchState(content) {
  if (typeof content !== "string") {
    return { stale: false, regions: [], defects: [], detail: "" };
  }
  const regions = markerRegions(content);
  const defects = [];
  for (const name of regions) {
    const begin = `/* ${MARKER_PREFIX}${name}:begin */`;
    const end = `/* ${MARKER_PREFIX}${name}:end */`;
    const beginCount = countOf(content, begin);
    const endCount = countOf(content, end);
    if (beginCount !== endCount) defects.push({ name, kind: "unbalanced", begin: beginCount, end: endCount });
    else if (beginCount > 1) defects.push({ name, kind: "duplicated", count: beginCount });
  }
  // 有 end 标记却没有对应 begin（例如 begin 被裁掉）也算缺陷。
  for (const match of content.matchAll(/\/\* dsh-session-delete:region:([A-Za-z0-9_.-]+):end \*\//g)) {
    if (!regions.includes(match[1])) defects.push({ name: match[1], kind: "orphan-end" });
  }
  const stale = regions.length > 0;
  return {
    stale,
    regions,
    defects,
    detail: stale
      ? `${regions.length} 个旧标记区（${regions.join(", ")}）` +
        (defects.length > 0 ? `；${defects.length} 处成对性缺陷` : "")
      : "",
  };
}

function countOf(content, needle) {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 兼容旧调用：目标内容是否"看起来被完整打过补丁"（有标记即视为曾改写）。 */
export function checkPatch(content) {
  return patchState(content).stale;
}

/**
 * 纯函数：摘除全部标记区（含标记本身），返回 {content, stripped}。
 * 与文件版本解耦：只依赖成对标记，不需要锚点。未成对时保守处理——
 * 只有成对的标记才摘，孤立标记原样保留并在诊断里报为缺陷。
 */
export function stripPatch(content) {
  if (typeof content !== "string" || content.length === 0) return content;
  let out = content;
  for (const name of markerRegions(content)) {
    const begin = `/* ${MARKER_PREFIX}${name}:begin */`;
    const end = `/* ${MARKER_PREFIX}${name}:end */`;
    const re = new RegExp(escapeRegExp(begin) + "[\\s\\S]*?" + escapeRegExp(end), "g");
    out = out.replace(re, "");
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
      report({ ok: false, stale: false, path: target, error: "target not found" });
      process.exitCode = 1;
      return;
    }
    const state = patchState(content);
    report({ ok: true, stale: state.stale, regions: state.regions, defects: state.defects, path: target });
    return;
  }
  if (command === "verify") {
    const content = readTarget(target);
    if (content === null) {
      report({ ok: false, path: target, error: "target not found" });
      process.exitCode = 1;
      return;
    }
    const state = patchState(content);
    report({
      ok: state.defects.length === 0,
      stale: state.stale,
      regions: state.regions,
      defects: state.defects,
      detail: state.detail,
      path: target,
      note: "开槽能力已移除；本命令只报告旧补丁残留。",
    });
    if (state.defects.length > 0) process.exitCode = 1;
    return;
  }
  if (command === "strip") {
    try {
      const content = readTarget(target);
      if (content === null) throw new Error("target not found");
      const before = patchState(content);
      if (!before.stale) {
        report({ ok: true, stripped: false, already: true, path: target });
        return;
      }
      const next = stripPatch(content);
      writeTargetAtomic(target, next);
      report({ ok: true, stripped: true, regions: before.regions, path: target });
    } catch (error) {
      report({ ok: false, stripped: false, path: target, error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
    return;
  }
  if (command === "apply") {
    report({
      ok: false,
      applied: false,
      path: target,
      error:
        "开槽能力已移除：本插件自 0.2.0 起完全走官方客户端扩展点（ctx.slots.inject），不再改写 Harness 文件。",
    });
    process.exitCode = 1;
    return;
  }
  report({ ok: false, error: `unknown command "${command}" (expected status|verify|strip|apply)` });
  process.exitCode = 1;
}

if (isMain) runCli(process.argv.slice(2));
