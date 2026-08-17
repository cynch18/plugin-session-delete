// dsh-profile-plugin-session-delete — host half.
//
// 提供 /session-delete/api/{delete,status,apply-patch}：
//   delete      永久删除单个会话（官方 API 组合：detachSession + requireState/setState
//               + locate/rm；路径围栏 + 回环围栏 + 运行中 409）
//   status      补丁状态自检（patched + fileHash + 逐区锚点报告）
//   apply-patch 自动重打补丁（幂等；锚点不匹配明确报错；原子写）
//
// 删除语义参考 Zephyr-vibe/dsh-archived-sessions（MIT）的实现模式，产品形态自研。
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  applyPatchText,
  checkPatch,
  defaultTarget,
  readTarget,
  regionStatus,
  writeTargetAtomic,
} from "./scripts/patch-workspace-menu.mjs";

export const name = "plugin-session-delete";
export const inject = ["webServer", "sessions", "sessionPersistence", "workspaceRegistry", "agents"];

// ── 会话存储布局 ───────────────────────────────────────────────────────────
/** DSH 家目录（与官方 resolveDshHome 语义一致：DSH_HOME / ~ 前缀展开 / 默认 ~/.dsh）。 */
export function dshHome() {
  const raw = process.env.DSH_HOME;
  const configured = raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
  let base = configured ?? join(homedir(), ".dsh");
  if (base === "~") base = homedir();
  else if (base.startsWith("~/") || base.startsWith("~\\")) base = join(homedir(), base.slice(2));
  else if (base.startsWith("~")) base = join(homedir(), base.slice(1));
  return resolve(base);
}

/** 会话记录根目录 `{DSH_HOME}/sessions`。 */
export function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/**
 * 路径围栏：dir 必须严格位于 root 之内（root 本身与越界一律拒绝）。
 * 防止异常/受损后端把递归 rm 指向会话库之外的任何位置。
 */
export function isInsideSessionsRoot(root, dir) {
  if (typeof root !== "string" || typeof dir !== "string") return false;
  if (dir === "" || dir === ".") return false;
  const rel = relative(root, dir);
  if (rel === "" || rel === ".") return false;
  if (isAbsolute(rel)) return false;
  if (rel.split(sep).includes("..")) return false;
  return true;
}

/**
 * 会话 id 校验：安全字符集（ASCII 字母数字与 `_ ~ -`）+ 限长。
 * 本 Harness 的 id 格式为 `session-<uuid>`（dsh-host-apiproxy 铸造），
 * 同时兼容裸 UUID 与自定义安全 id；排除路径分隔符/空白/控制字符，
 * 防止其进入 locate/dirname 等路径拼接路径。
 */
export function isValidSessionId(id) {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 200) return false;
  return /^[A-Za-z0-9_~-]{1,200}$/.test(id);
}

/** 定位会话 header（live 优先，其次 persistence.list()）。 */
async function findSessionMeta(ctx, sessionId) {
  const live = ctx.get("sessions")?.get(sessionId);
  if (live !== undefined) return live.header;
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && typeof persistence.list === "function") {
    for (const meta of await persistence.list()) {
      if (meta.id === sessionId) return meta;
    }
  }
  return undefined;
}

// ── 浏览器信任围栏（仅本机回环）───────────────────────────────────────────
function header(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isTrustedApiRequest(req) {
  const host = header(req.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(req.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value });
}

function sendFail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req) {
  const contentType = header(req.headers, "content-type");
  // JSON content-type 强制 = CORS 预检拦截 = 跨站脚本无法直接提交（CSRF 防线）。
  if (contentType !== undefined && !/^application\/json\b/i.test(contentType.trim())) {
    const error = new Error("content-type must be application/json");
    error.status = 415;
    error.code = "unsupported-media-type";
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.status = 413;
      error.code = "body-too-large";
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid JSON body");
    error.status = 400;
    error.code = "bad-json";
    throw error;
  }
}

function httpError(error, fallback) {
  return {
    status: typeof error?.status === "number" ? error.status : fallback,
    code: typeof error?.code === "string" ? error.code : "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

// ── registry 状态变更串行队列（与官方 archiveSession 队列并存的已知窗口）──
let mutationTail = Promise.resolve();
function enqueueMutation(operation) {
  const result = mutationTail.then(() => operation());
  mutationTail = result.then(() => {}, () => {});
  return result;
}

// ── 删除后的归档集推导（纯函数，供单测）────────────────────────────────────
/**
 * rc.6 幽灵会话修复的核心推导：
 * - 清扫孤儿：仅保留"内存或磁盘仍存在"的归档 id（历史残渣顺带收走）；
 * - 幽灵斗篷：被删会话若仍存在于内存（rc.6 无驱逐原语），加入归档集 =
 *   官方"任何地方不渲染"语义，未分组桶不再出现幽灵；重启后内存重建、
 *   existing 不再含它，下次删除触发清扫时自然收走。
 * @param {string[]} currentArchived 现归档集
 * @param {string} sessionId 本次删除的会话 id
 * @param {Set<string>|Iterable<string>} existingIds 内存 ∪ 磁盘仍存在的会话 id
 * @returns {string[]} 下一状态归档集
 */
export function nextArchivedSet(currentArchived, sessionId, existingIds) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds ?? []);
  const kept = (currentArchived ?? []).filter((id) => existing.has(id));
  if (existing.has(sessionId) && !kept.includes(sessionId)) kept.push(sessionId);
  return kept;
}

// ── 删除单个会话 ───────────────────────────────────────────────────────────
/**
 * 只删自己、不级联：detach 工作区记账 → 清归档集（顺带清理孤儿条目）→
 * 物理删除会话记录目录（路径围栏内）。运行中检查由调用方先行。
 */
async function deleteSessionSingle(ctx, sessionId) {
  const registry = ctx.get("workspaceRegistry");
  const persistence = ctx.get("sessionPersistence");
  const sessions = ctx.get("sessions");
  const meta = await findSessionMeta(ctx, sessionId);
  if (meta === undefined) {
    const error = new Error("找不到该会话的记录（会话不存在）");
    error.status = 404;
    error.code = "session-not-found";
    throw error;
  }
  // 1) 工作区记账：best-effort，单个 workspace 失败不阻塞整体删除。
  for (const ws of registry?.list() ?? []) {
    if (!ws.sessionIds.includes(sessionId)) continue;
    try {
      await ws.detachSession(sessionId);
    } catch (error) {
      console.error(`[plugin-session-delete] detachSession failed for workspace "${ws.path}":`, error);
    }
  }
  // 2) 物理删除：persistence.remove（新版）→ locate + 围栏 rm（当前版本）。
  // 先删文件再清理归档集：真删除后 existing 不含该 id → nextArchivedSet 清扫分支
  // 会把它从归档集收走；仅当会话仍残留内存（dispose 失败）时才走"隐形斗篷"隐藏。
  let fileRemoved = false;
  if (persistence !== undefined && typeof persistence.remove === "function") {
    await persistence.remove(sessionId);
    fileRemoved = true;
  } else if (persistence !== undefined && typeof persistence.locate === "function") {
    const location = persistence.locate(meta);
    if (location === undefined || typeof location.path !== "string") {
      console.warn(`[plugin-session-delete] persistence.locate returned no path for ${sessionId}; file not removed`);
    } else {
      const dir = dirname(location.path);
      const root = sessionsRoot();
      if (!isInsideSessionsRoot(root, dir)) {
        const error = new Error("拒绝删除：会话记录目录不在会话根目录内");
        error.status = 403;
        error.code = "outside-sessions-root";
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
      fileRemoved = true;
      // 顺手清理变空的 project 目录（best-effort，失败忽略）。
      try {
        const project = dirname(dir);
        if (isInsideSessionsRoot(root, project)) {
          const entries = await readdir(project);
          if (entries.length === 0) await rm(project, { recursive: false, force: true });
        }
      } catch {
        // ignore
      }
    }
  }
  // 3) 归档集：串行队列内读-改-写。existing = 内存 + 磁盘；刚删除的会话若已从两者
  // 消失 → 清扫（移出归档集）；若仍残留内存（dispose 失败）→ 斗篷（保留在归档集隐藏）。
  if (registry !== undefined && typeof registry.requireState === "function" && typeof registry.setState === "function") {
    await enqueueMutation(async () => {
      const state = registry.requireState();
      const existing = new Set();
      for (const session of sessions?.list() ?? []) existing.add(session.id);
      if (persistence !== undefined && typeof persistence.list === "function") {
        for (const h of await persistence.list()) existing.add(h.id);
      }
      const archivedSessionIds = nextArchivedSet(state.archivedSessionIds, sessionId, existing);
      await registry.setState({ ...state, archivedSessionIds });
    });
  }
  return fileRemoved ? { sessionId } : { sessionId, fileRemoved: false };
}

/** 永久删除一个会话：运行中 409 拦截 → flush + disposeAgent 探测 → 单删。 */
async function deleteSession(ctx, sessionId) {
  const agents = ctx.get("agents");
  const agent = agents?.get(sessionId);
  if (agent !== undefined && agent.status === "running") {
    const error = new Error("会话正在运行，无法删除；请先停止该会话");
    error.status = 409;
    error.code = "session-busy";
    throw error;
  }
  if (agent !== undefined) {
    try {
      const sessions = ctx.get("sessions");
      const session = sessions?.get(sessionId);
      if (session !== undefined && typeof sessions.flush === "function") {
        await sessions.flush(session);
      }
    } catch {
      // flush 失败不阻塞：物理删除仍然生效
    }
    const loop = ctx.get("agentLoop");
    if (loop !== undefined && typeof loop.disposeAgent === "function") {
      try {
        await loop.disposeAgent(sessionId);
      } catch {
        // dispose 失败不阻塞
      }
    } else {
      // rc.6 无 agentLoop.disposeAgent 公开原语：改用与 harness 自身 teardown
      // 完全相同的 store 原语（agent-loop 的 dispose() 内部就是 detachAgent +
      // detachSession）。先 detach agent 触发 agent/disposed，再 detach session
      // 触发 session/disposed → apiproxy 广播 host/session-removed → 客户端即时移除。
      // 仅对非运行（已 409 拦截）、非 announcing/appending 的会话执行；失败静默，
      // 兜底仍由 nextArchivedSet 的"隐形斗篷"隐藏残留内存幽灵。
      try {
        const agentStore = ctx.get("agents");
        const agentEntry = agentStore?.store?.get(sessionId);
        if (agentEntry !== undefined && !agentEntry.announcing && typeof agentStore.detachEntered === "function") {
          agentStore.detachEntered(agentEntry);
        }
      } catch {
        // best-effort
      }
      try {
        const sessionStore = ctx.get("sessions");
        const sessionEntry = sessionStore?.store?.get(sessionId);
        if (sessionEntry !== undefined && !sessionEntry.announcing && !sessionEntry.appending && typeof sessionStore.detachEntered === "function") {
          sessionStore.detachEntered(sessionEntry);
        }
      } catch {
        // best-effort
      }
    }
  }
  await deleteSessionSingle(ctx, sessionId);
  return { sessionId };
}

// ── 补丁状态 ───────────────────────────────────────────────────────────────
function patchStatus() {
  const path = defaultTarget();
  const content = readTarget(path);
  if (content === null) {
    return { patched: false, path, error: "target not found" };
  }
  return {
    patched: checkPatch(content),
    path,
    fileHash: createHash("sha256").update(content).digest("hex"),
    regions: regionStatus(content),
  };
}

// ── 路由 ───────────────────────────────────────────────────────────────────
const API_METHODS = new Set(["delete", "status", "apply-patch"]);
let applyInFlight = false;

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/session-delete/api",
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req)) {
        sendFail(res, 403, "forbidden", "forbidden");
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const method = pathname.startsWith("/session-delete/api/") ? pathname.slice("/session-delete/api/".length) : undefined;
      if (method === undefined || method.includes("/") || method === "") {
        sendFail(res, 404, "not-found", "unknown session-delete API method");
        return;
      }
      if (!API_METHODS.has(method)) {
        sendFail(res, 404, "not-found", `unknown session-delete API method "${method}"`);
        return;
      }
      if (method === "status" && (req.method === "GET" || req.method === "HEAD")) {
        sendOk(res, patchStatus());
        return;
      }
      if (req.method !== "POST") {
        sendFail(res, 405, "method-error", "method not allowed");
        return;
      }
      try {
        if (method === "status") {
          sendOk(res, patchStatus());
          return;
        }
        if (method === "apply-patch") {
          if (applyInFlight) {
            sendFail(res, 409, "busy", "another patch operation is in progress");
            return;
          }
          applyInFlight = true;
          try {
            const path = defaultTarget();
            const content = readTarget(path);
            if (content === null) throw Object.assign(new Error("patch target not found"), { status: 404, code: "target-not-found" });
            const { content: next, applied } = applyPatchText(content);
            if (!applied) {
              sendOk(res, { applied: false, already: true, path });
              return;
            }
            writeTargetAtomic(path, next);
            sendOk(res, { applied: true, path });
          } catch (error) {
            const { status, code, message } = httpError(error, 500);
            sendFail(res, status, code, message);
          } finally {
            applyInFlight = false;
          }
          return;
        }
        const payload = await readJsonBody(req);
        const sessionId = payload.sessionId;
        if (!isValidSessionId(sessionId)) {
          sendFail(res, 400, "bad-request", "sessionId must be a UUID-shaped string");
          return;
        }
        if (method === "delete") {
          sendOk(res, await deleteSession(ctx, sessionId));
          return;
        }
        sendFail(res, 404, "not-found", `unknown session-delete API method "${method}"`);
      } catch (error) {
        const { status, code, message } = httpError(error, 500);
        sendFail(res, status, code, message);
      }
    },
  }), "plugin-session-delete: /session-delete/api routes");
}
