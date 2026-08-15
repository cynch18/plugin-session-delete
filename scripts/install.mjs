// install.mjs — 跨平台一键安装（Windows / macOS / Linux）。
// 步骤：复制包文件 → 打补丁（幂等）→ cordis.patch.yml 注册条目（幂等，通用锚点）。
// 用法：node scripts/install.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyPatchText,
  checkPatch,
  defaultTarget,
  dshHome,
  readTarget,
  writeTargetAtomic,
} from "./patch-workspace-menu.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_ID = "plugin-session-delete";
const PACKAGE_NAME = "dsh-profile-plugin-session-delete";

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 幂等：cordis.patch.yml 注册条目（通用锚点：插在顶层 `- insert:` 之后）。 */
export function registerPatchEntry(content, { entryId = ENTRY_ID, packageName = PACKAGE_NAME } = {}) {
  if (typeof content !== "string" || content.length === 0) return { content, changed: false, error: "empty patch content" };
  if (new RegExp(`^\\s*- id:\\s*${entryId}\\s*$`, "m").test(content)) return { content, changed: false };
  const eol = eolOf(content);
  const insertMatch = /^(- insert:[^\r\n]*)$/m.exec(content);
  if (!insertMatch) {
    return {
      content,
      changed: false,
      error: `no top-level "- insert:" list in cordis.patch.yml; add manually:\n    - id: ${entryId}${eol}      name: ${packageName}${eol}      disabled: false`,
    };
  }
  const block = [
    `    - id: ${entryId}`,
    `      name: ${packageName}`,
    `      disabled: false`,
  ].join(eol);
  const next = content.replace(/^(- insert:[^\r\n]*)$/m, `$1${eol}${block}`);
  return { content: next, changed: true };
}

function main() {
  const home = dshHome();
  const profile = join(home, "profiles", "web");
  const pkgDir = join(profile, "node_modules", PACKAGE_NAME);
  const patchYml = join(profile, "cordis.patch.yml");

  console.log("== plugin-session-delete install ==");
  console.log(`  DSH_HOME : ${home}`);
  console.log(`  pkg dir  : ${pkgDir}`);

  if (!existsSync(profile)) {
    console.error(`profile dir not found: ${profile}`);
    process.exit(1);
  }

  // 1) 复制包文件
  mkdirSync(join(pkgDir, "scripts"), { recursive: true });
  for (const name of ["package.json", "index.js", "client.js", "README.md", "LICENSE"]) {
    const src = join(repoRoot, name);
    if (existsSync(src)) copyFileSync(src, join(pkgDir, name));
  }
  for (const name of ["patch-workspace-menu.mjs", "install.mjs", "install.ps1"]) {
    const src = join(repoRoot, "scripts", name);
    if (existsSync(src)) copyFileSync(src, join(pkgDir, "scripts", name));
  }
  console.log("  copied package files");

  // 2) 打补丁（幂等；锚点不匹配会明确报错，不写坏文件）
  const target = defaultTarget();
  const content = readTarget(target);
  if (content === null) {
    console.error(`  patch target not found: ${target}`);
    process.exit(1);
  }
  if (checkPatch(content)) {
    console.log("  patch: already applied");
  } else {
    const { content: next, applied } = applyPatchText(content);
    if (!applied) {
      console.error("  patch apply produced no change");
      process.exit(1);
    }
    writeTargetAtomic(target, next);
    console.log("  patch: applied");
  }

  // 3) cordis.patch.yml 注册条目
  if (!existsSync(patchYml)) {
    console.error(`cordis.patch.yml not found: ${patchYml}`);
    process.exit(1);
  }
  const yml = readFileSync(patchYml, "utf8");
  const result = registerPatchEntry(yml);
  if (result.changed) {
    writeFileSync(patchYml, result.content, "utf8");
    console.log("  cordis.patch.yml: entry added");
  } else if (result.error) {
    console.warn(`  cordis.patch.yml: ${result.error}`);
  } else {
    console.log("  cordis.patch.yml: entry already present");
  }

  console.log("== done ==");
  console.log("  1) 重启 dsh（host 半加载需要重启）；");
  console.log("  2) 刷新页面，标题栏应出现 🗑 删除按钮。");
}

// 仅在作为主模块执行时运行；被 import（test.mjs）时零副作用。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
