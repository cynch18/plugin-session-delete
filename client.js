// dsh-profile-plugin-session-delete — client half (patch-free).
//
// Everything here lands in slots the stock client declares on its own:
//   sidebar.workspaces.session.menu.item — 「…」菜单里的红色「删除会话」
//   sidebar.workspaces.session.row.action — 行尾悬停按钮（可关，默认关）
//   shell.overlay                        — 批量选择面板 + 永久删除确认框
//   sidebar.footer.action                — 仅在检测到"陈旧补丁标记"时出现的只读诊断徽标
//   settings.section                     — 完整批量面板（与 overlay 同一组件）
//
// 本文件不写入任何 Harness 文件，也不具备自动重新加载页面的能力。
// host 交互只有两个：POST /session-delete/api/delete 与 GET /session-delete/api/status（只读）。
// 旧版依赖的三个自建槽（headerAction / sessionLead / sessionMenu）已全部弃用。
window.__ModuleLoader__.load({
  id: "dsh-profile-plugin-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const e = React.createElement;
    const NS = "sessionDelete";
    const inject = ["slots", "sessions", "workspaces", "locale"];

    // ── 会话可删性判定（单删与批量共用同一套规则）───────────────────────────
    /**
     * 会话是否不可删。返回锁定原因（i18n key）或 null。
     *
     * 只锁一种情况：**会话正在运行**（行数据自带的 `running`，与服务端 409 同源）。
     *
     * 刻意不锁"当前打开的会话"：
     *   - `retainedBy.mainView` 是**保留引用计数**，凡被主视图打开过的会话都 > 0 且
     *     不会归零，用它判"当前"会把大量普通会话误锁成灰色（0.2.0 实机踩过）；
     *   - `list.current` 只是 `byId` 的快照字段，与"当前显示哪一个"并不等价。
     * 删当前会话由服务端兜底拒绝（delete 会返回明确错误），错误信息比一个永远点不动
     * 的灰按钮更有用。
     */
    function isSessionLocked(node) {
      if (node === undefined || node === null) return null;
      if (node.running === true) return "runningLocked";
      return null;
    }

    // ── 垃圾桶图标 ─────────────────────────────────────────────────────────
    //
    // 优先用 Harness 自带的官方图标（`IconTrashOutlineRegular`，与 archive 用的
    // `IconArchiveOutline20` 同一套描边风格、同一套尺寸/描边语义），这样它和菜单里
    // 其它原生条目长得完全一致。
    //
    // 但 require 失败绝不能拖垮客户端半（0.2.0 已经因为"依赖不存在的东西"崩过两次），
    // 所以这里做了兜底：官方图标拿不到就退回自带的等效描边 SVG，功能不受影响。
    const primitives = (() => {
      try {
        return require("@deepseek-ai/dsh-client-ui-primitives");
      } catch {
        return null;
      }
    })();
    const OfficialTrashIcon =
      primitives !== null && typeof primitives.IconTrashOutlineRegular === "function"
        ? primitives.IconTrashOutlineRegular
        : null;

    /** 自带兜底：与官方描边风格一致的垃圾桶。 */
    function FallbackTrashIcon(props) {
      const size = props && props.size !== undefined ? props.size : 16;
      return e(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        e("path", { d: "M3 6h18" }),
        e("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }),
        e("path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
        e("path", { d: "M10 11v6" }),
        e("path", { d: "M14 11v6" }),
      );
    }

    const TrashIcon = OfficialTrashIcon ?? FallbackTrashIcon;

    // ── 模块级服务句柄 ─────────────────────────────────────────────────────
    let sessionsService = null;

    // ── 简单 store 工具 ────────────────────────────────────────────────────
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        get: () => snapshot,
        set: (next) => {
          snapshot = next;
          for (const fn of [...listeners]) fn();
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    }
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    // ── 弹层状态：null | { kind: "confirm"|"batch", ... } ─────────────────
    const dialogStore = createStore(null);
    function openConfirm(payload) {
      dialogStore.set({ kind: "confirm", ids: payload.ids, title: payload.title, busy: false, error: null });
    }
    function openBatch() {
      dialogStore.set({ kind: "batch" });
    }
    function closeDialog() {
      const cur = dialogStore.get();
      if (cur && cur.busy === true) return;
      dialogStore.set(null);
    }

    // ── 诊断状态（只读：host 报告目标 bundle 上是否残留旧补丁标记）────────
    const diagStore = createStore({ state: "unknown", message: "" });

    // ── toast ─────────────────────────────────────────────────────────────
    const toastStore = createStore(null);
    let toastTimer = null;
    function showToast(message, ms = 4000) {
      toastStore.set({ message });
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastStore.set(null), ms);
    }

    // ── API ────────────────────────────────────────────────────────────────
    async function apiJson(path, method = "POST", payload) {
      const init = { method, headers: { "content-type": "application/json" } };
      if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(payload ?? {});
      const res = await fetch(path, init);
      try {
        return await res.json();
      } catch {
        return { ok: false, error: { code: "bad-response", message: "HTTP " + res.status } };
      }
    }
    function apiDelete(sessionId) {
      return apiJson("/session-delete/api/delete", "POST", { sessionId });
    }
    function apiStatus() {
      return apiJson("/session-delete/api/status", "GET");
    }

    // ── 诊断：只报告，不修复 ───────────────────────────────────────────────
    let diagStarted = false;
    function startDiagnostics() {
      if (diagStarted) return;
      diagStarted = true;
      apiStatus()
        .then((s) => {
          if (!s || !s.ok) {
            diagStore.set({ state: "unknown", message: "" });
            return;
          }
          const value = s.value ?? {};
          if (value.stalePatch === true) {
            diagStore.set({
              state: "stale",
              message: value.staleDetail ?? "",
            });
            return;
          }
          diagStore.set({ state: "clean", message: "" });
        })
        .catch(() => diagStore.set({ state: "unknown", message: "" }));
    }

    // ── 删除执行（每 20 个一批串行，逐条回报）──────────────────────────────
    async function runDelete(sessionIds) {
      const results = [];
      for (let i = 0; i < sessionIds.length; i += 20) {
        const chunk = sessionIds.slice(i, i + 20);
        for (const id of chunk) {
          try {
            const res = await apiDelete(id);
            if (res && res.ok) results.push({ sessionId: id, ok: true });
            else
              results.push({
                sessionId: id,
                ok: false,
                error: res && res.error ? res.error.message || res.error.code : "request failed",
              });
          } catch (error) {
            results.push({ sessionId: id, ok: false, error: error && error.message ? error.message : String(error) });
          }
        }
      }
      return results;
    }
    async function refreshSessions() {
      try {
        if (sessionsService && typeof sessionsService.refresh === "function") await sessionsService.refresh();
      } catch {
        // 刷新失败不阻塞结果呈现
      }
    }
    async function afterDelete(ids) {
      await refreshSessions();
      try {
        const snap = sessionsService && sessionsService.list ? sessionsService.list.getSnapshot() : null;
        if (snap && typeof snap.current === "string" && ids.indexOf(snap.current) !== -1) {
          if (typeof sessionsService.clear === "function") sessionsService.clear();
        }
      } catch {
        // 防御性清理失败忽略
      }
    }
    /** 统一的删除 + 结果呈现；返回 { ok, fail }。 */
    async function deleteAndReport(ids, t) {
      const results = await runDelete(ids);
      await afterDelete(ids);
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      const firstFail = results.find((r) => !r.ok);
      if (fail > 0) showToast(t("deletePartial", { ok, fail }) + (firstFail && firstFail.error ? "：" + firstFail.error : ""));
      else showToast(t("deleteDone", { ok }));
      return { ok, fail };
    }

    // ── 列表读取（所有会话，含已归档）──────────────────────────────────────
    function listRows(list) {
      const byId = (list && list.byId) || {};
      return Object.values(byId)
        .filter((s) => s && s.id)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }

    // ── 相对时间 ───────────────────────────────────────────────────────────
    function relativeTime(ts, now, t) {
      if (!ts) return "";
      const diff = now - ts;
      if (diff < 60 * 1000) return t("timeNow");
      if (diff < 60 * 60 * 1000) return t("timeMinutes", { n: Math.floor(diff / 60000) });
      if (diff < 24 * 60 * 60 * 1000) return t("timeHours", { n: Math.floor(diff / 3600000) });
      if (diff < 30 * 24 * 60 * 60 * 1000) return t("timeDays", { n: Math.floor(diff / 86400000) });
      return t("timeDate", { d: new Date(ts).toLocaleDateString() });
    }

    // ── 确认弹窗 ───────────────────────────────────────────────────────────
    function ConfirmModal(props) {
      const { t, n, title, busy, error, onCancel, onConfirm } = props;
      return e(
        "div",
        {
          className: "sd-overlay",
          onClick: (ev) => {
            if (ev.target === ev.currentTarget && !busy) onCancel();
          },
        },
        e(
          "div",
          { className: "sd-modal", role: "dialog", "aria-modal": "true" },
          e("div", { className: "sd-modal-title" }, title || t("confirmTitle")),
          e("div", { className: "sd-modal-desc" }, t("confirmDesc", { n })),
          error ? e("div", { className: "sd-modal-error", role: "alert" }, error) : null,
          e(
            "div",
            { className: "sd-modal-actions" },
            e("button", { type: "button", className: "sd-btn", disabled: busy, onClick: onCancel }, t("cancel")),
            e(
              "button",
              { type: "button", className: "sd-btn sd-btn-danger", disabled: busy, onClick: onConfirm },
              busy ? t("deleting") : t("confirmDelete"),
            ),
          ),
        ),
      );
    }

    // ── 批量面板（overlay 与设置页共用）────────────────────────────────────
    function BatchPanel(props) {
      const { t, useSessions, useWorkspaces, showHeader } = props;
      const list = useSessions((s) => s);
      const archived = useWorkspaces((s) => s.archivedSessionIds) ?? [];
      const diag = useStore(diagStore);
      const [query, setQuery] = React.useState("");
      const [selected, setSelected] = React.useState(new Set());
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [result, setResult] = React.useState(null);

      const q = query.trim().toLowerCase();
      const rows = React.useMemo(() => {
        return listRows(list).filter((s) => {
          if (q === "") return true;
          return (
            String(s.title ?? "").toLowerCase().indexOf(q) !== -1 || s.id.toLowerCase().indexOf(q) !== -1
          );
        });
      }, [list, q]);

      const toggle = (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });

      const selectAll = () =>
        setSelected(new Set(rows.filter((s) => isSessionLocked(s) === null).map((s) => s.id)));

      const doDelete = async () => {
        dialogStore.set(null);
        setBusy(true);
        setError(null);
        setResult(null);
        try {
          const ids = [...selected];
          const outcome = await deleteAndReport(ids, t);
          setResult(outcome);
          setSelected(new Set());
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
        setBusy(false);
      };

      return e(
        "div",
        { className: "sd-panel" },
        showHeader ? e("div", { className: "sd-modal-title" }, t("nav")) : null,
        e("div", { className: "sd-panel-head" }, t("panelDesc")),
        diag.state === "stale" ? e("div", { className: "sd-notice sd-notice-error", role: "status" }, t("stalePatch")) : null,
        e("input", {
          className: "sd-search",
          type: "text",
          placeholder: t("search"),
          value: query,
          onChange: (ev) => setQuery(ev.target.value),
        }),
        rows.length === 0
          ? e("p", { className: "sd-empty" }, q === "" ? t("empty") : t("emptySearch"))
          : e(
              "div",
              { className: "sd-list" },
              rows.map((s) => {
                const locked = isSessionLocked(s);
                const checked = selected.has(s.id);
                return e(
                  "div",
                  {
                    key: s.id,
                    className: "sd-prow" + (checked ? " sd-prow-on" : "") + (locked !== null ? " sd-prow-locked" : ""),
                  },
                  e(
                    "button",
                    {
                      type: "button",
                      className: "sd-lead" + (checked ? " sd-lead-on" : ""),
                      disabled: locked !== null,
                      title: locked !== null ? t(locked) : t("toggleCheck"),
                      onClick: () => toggle(s.id),
                    },
                    checked ? "✓" : "",
                  ),
                  e("span", { className: "sd-ptitle" }, s.title || s.id),
                  s.id === list.current ? e("span", { className: "sd-badge" }, t("currentBadge")) : null,
                  s.running ? e("span", { className: "sd-badge" }, t("runningBadge")) : null,
                  archived.indexOf(s.id) !== -1 ? e("span", { className: "sd-badge" }, t("archivedBadge")) : null,
                  e("span", { className: "sd-ptime" }, relativeTime(s.updatedAt, Date.now(), t)),
                );
              }),
            ),
        e(
          "div",
          { className: "sd-pbar" },
          e("button", { type: "button", className: "sd-btn", disabled: busy, onClick: selectAll }, t("selectAll")),
          e("button", { type: "button", className: "sd-btn", disabled: busy, onClick: () => setSelected(new Set()) }, t("clearSel")),
          e(
            "button",
            {
              type: "button",
              className: "sd-btn sd-btn-danger",
              disabled: busy || selected.size === 0,
              onClick: () => {
                setError(null);
                openConfirm({ ids: [...selected] });
              },
            },
            t("deleteSelected", { n: selected.size }),
          ),
        ),
        error ? e("div", { className: "sd-notice sd-notice-error", role: "alert" }, t("deleteFailed", { msg: error })) : null,
        result
          ? e(
              "div",
              { className: "sd-notice", role: "status" },
              result.fail > 0 ? t("deletePartial", { ok: result.ok, fail: result.fail }) : t("deleteDone", { ok: result.ok }),
            )
          : null,
      );
    }

    // ── overlay 宿主：确认框 + 批量面板 ────────────────────────────────────
    function OverlayHost(props) {
      const { t, useSessions, useWorkspaces } = props;
      const dialog = useStore(dialogStore);
      const toast = useStore(toastStore);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        if (dialog === null) {
          setError(null);
          setBusy(false);
        }
      }, [dialog]);

      if (dialog === null) {
        return toast ? e("div", { className: "sd-toast", role: "status" }, toast.message) : null;
      }

      if (dialog.kind === "confirm") {
        const doDelete = async () => {
          setBusy(true);
          setError(null);
          try {
            await deleteAndReport(dialog.ids, t);
            dialogStore.set(null);
          } catch (err) {
            setError(err && err.message ? err.message : String(err));
          }
          setBusy(false);
        };
        return [
          e(ConfirmModal, {
            key: "confirm",
            t,
            n: dialog.ids.length,
            title: dialog.title,
            busy,
            error,
            onCancel: () => {
              if (!busy) dialogStore.set(null);
            },
            onConfirm: doDelete,
          }),
          toast ? e("div", { key: "toast", className: "sd-toast", role: "status" }, toast.message) : null,
        ];
      }

      // kind === "batch"
      return [
        e(
          "div",
          {
            key: "batch",
            className: "sd-overlay",
            onClick: (ev) => {
              if (ev.target === ev.currentTarget) closeDialog();
            },
          },
          e(
            "div",
            { className: "sd-modal sd-modal-wide", role: "dialog", "aria-modal": "true" },
            e(
              "div",
              { className: "sd-modal-head" },
              e("div", { className: "sd-modal-title" }, t("nav")),
              e("button", { type: "button", className: "sd-close", onClick: closeDialog, "aria-label": t("cancel") }, "✕"),
            ),
            e(BatchPanel, { t, useSessions, useWorkspaces, showHeader: false }),
          ),
        ),
        toast ? e("div", { key: "toast", className: "sd-toast", role: "status" }, toast.message) : null,
      ];
    }

    // ── 「…」菜单：红色「删除会话」─────────────────────────────────────────
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const list = sessionsService?.list?.getSnapshot?.() ?? {};
      const node = sessionId === undefined ? undefined : list.byId?.[sessionId];
      const reason = isSessionLocked(node);
      const disabled = reason !== null;
      return e(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "sd-menuitem" + (disabled ? " sd-menuitem-locked" : ""),
          disabled,
          title: disabled ? t(reason ?? "runningLocked") : undefined,
          onClick: () => {
            setMenuOpen(false);
            openConfirm({ ids: [sessionId], title: t("confirmOne", { title: displayTitle || sessionId }) });
          },
        },
        e("span", { className: "sd-menuitem-icon" }, e(TrashIcon, { size: 16 })),
        e("span", { className: "sd-menuitem-label" }, t("menuDelete")),
      );
    }

    // ── 「…」菜单：批量删除入口（每个会话行都有，打开同一个全局面板）───────
    function BatchDeleteMenuItem(props) {
      const { useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return e(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "sd-menuitem sd-menuitem-plain",
          onClick: () => {
            setMenuOpen(false);
            openBatch();
          },
        },
        e("span", { className: "sd-menuitem-icon" }, e(TrashIcon, { size: 16 })),
        e("span", { className: "sd-menuitem-label" }, t("menuBatch")),
      );
    }

    // ── 行尾悬停按钮（默认不注册；交给 preferRowButton 配置打开）───────────
    function DeleteSessionRowButton(props) {
      const { sessionId, displayTitle, t } = props;
      return e(
        "button",
        {
          type: "button",
          className: "sd-hbtn sd-hbtn-danger",
          title: t("menuDelete"),
          "aria-label": t("menuDelete"),
          onClick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openConfirm({ ids: [sessionId], title: t("confirmOne", { title: displayTitle || sessionId }) });
          },
        },
        e(TrashIcon, { size: 16 }),
      );
    }

    // ── 只读诊断徽标：仅在 bundle 上残留旧补丁标记时出现 ───────────────────
    function StalePatchBadge(props) {
      const { t, wide } = props;
      const diag = useStore(diagStore);
      if (diag.state !== "stale") return null;
      return e(
        "button",
        {
          type: "button",
          className: "sd-foot",
          title: t("stalePatchHint"),
          onClick: () => showToast(t("stalePatchHint")),
        },
        "⚠",
        wide ? e("span", { className: "sd-hbtn-label" }, " " + t("stalePatch")) : null,
      );
    }

    // ── 设置页分区 ────────────────────────────────────────────────────────
    function SessionDeleteSettings(props) {
      return e(BatchPanel, { t: props.t, useSessions: props.useSessions, useWorkspaces: props.useWorkspaces, showHeader: true });
    }

    // ── 双语字典（键集严格一致）───────────────────────────────────────────
    const zh = {
      nav: "删除会话",
      menuDelete: "删除会话",
      menuBatch: "批量删除会话…",
      search: "搜索会话…",
      empty: "暂无会话",
      emptySearch: "无匹配会话",
      selectAll: "全选",
      clearSel: "清空",
      deleteSelected: "删除所选 ({n})",
      toggleCheck: "勾选 / 取消勾选",
      runningLocked: "运行中的会话不可删除",
      confirmTitle: "永久删除会话",
      confirmOne: "永久删除「{title}」？",
      confirmDesc: "将永久删除 {n} 个会话：记录文件与归档状态一并清除，不可恢复。确定继续？",
      confirmDelete: "永久删除",
      cancel: "取消",
      deleting: "正在删除…",
      deleteDone: "删除完成：{ok} 个成功。",
      deletePartial: "删除完成：{ok} 个成功，{fail} 个失败。",
      deleteFailed: "删除失败：{msg}",
      currentBadge: "当前",
      runningBadge: "运行中",
      archivedBadge: "已归档",
      panelDesc: "勾选后批量删除本机会话记录（含已归档）。运行中与当前打开的会话不可删除。",
      stalePatch: "检测到旧版补丁残留",
      stalePatchHint: "此 bundle 上仍有旧版 sidebar 补丁的标记。它不再被使用，可运行 `node scripts/patch-workspace-menu.mjs strip` 摘除。",
      timeNow: "刚刚",
      timeMinutes: "{n}分钟前",
      timeHours: "{n}小时前",
      timeDays: "{n}天前",
      timeDate: "{d}",
    };
    const en = {
      nav: "Delete sessions",
      menuDelete: "Delete session",
      menuBatch: "Delete sessions…",
      search: "Search sessions…",
      empty: "No sessions yet",
      emptySearch: "No matching sessions",
      selectAll: "Select all",
      clearSel: "Clear",
      deleteSelected: "Delete selected ({n})",
      toggleCheck: "Toggle selection",
      runningLocked: "Running sessions cannot be deleted",
      confirmTitle: "Delete sessions permanently",
      confirmOne: "Permanently delete “{title}”?",
      confirmDesc: "This permanently deletes {n} session(s): record files and archive state are removed and cannot be recovered. Continue?",
      confirmDelete: "Delete permanently",
      cancel: "Cancel",
      deleting: "Deleting…",
      deleteDone: "Deleted: {ok} succeeded.",
      deletePartial: "Deleted: {ok} succeeded, {fail} failed.",
      deleteFailed: "Delete failed: {msg}",
      currentBadge: "Current",
      runningBadge: "Running",
      archivedBadge: "Archived",
      panelDesc: "Check to batch-delete local session records (archived included). Running and currently-open sessions cannot be deleted.",
      stalePatch: "Old patch markers detected",
      stalePatchHint: "This bundle still carries markers from the old sidebar patch. They are unused now; remove them with `node scripts/patch-workspace-menu.mjs strip`.",
      timeNow: "now",
      timeMinutes: "{n}min ago",
      timeHours: "{n}h ago",
      timeDays: "{n}d ago",
      timeDate: "{d}",
    };

    // ── 样式 ───────────────────────────────────────────────────────────────
    const CSS = [
      ".sd-hbtn{box-sizing:border-box;position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;flex:none;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out)}",
      ".sd-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".sd-hbtn-danger:hover{color:var(--dsw-alias-state-error-primary)}",
      ".sd-menuitem{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:var(--dsw-alias-state-error-primary);padding:6px 10px;font-size:13px;line-height:18px;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm)}",
      ".sd-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-menuitem-plain{color:inherit}",
      ".sd-menuitem-locked{color:var(--dsw-alias-label-tertiary);opacity:.55;cursor:not-allowed}",
      ".sd-menuitem-locked:hover{background:transparent}",
      ".sd-menuitem-icon{display:inline-flex;align-items:center;flex:none}",
      ".sd-menuitem-label{flex:1;min-width:0}",
      ".sd-foot{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:26px;border:1px solid #f5a524;border-radius:8px;background:transparent;color:#f5a524;padding:0 8px;font-size:12px;line-height:18px;cursor:pointer}",
      ".sd-overlay{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}",
      ".sd-modal{box-sizing:border-box;width:min(420px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.25)}",
      ".sd-modal-wide{width:min(560px,calc(100vw - 48px))}",
      ".sd-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".sd-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:20px;padding:2px 6px;border-radius:6px}",
      ".sd-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-modal-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
      ".sd-modal-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:19px}",
      ".sd-modal-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".sd-modal-actions{display:flex;justify-content:flex-end;gap:8px}",
      ".sd-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 12px;font-size:13px;line-height:18px;cursor:pointer}",
      ".sd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".sd-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".sd-toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1300;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);box-shadow:0 4px 16px rgba(0,0,0,.18)}",
      ".sd-panel{display:flex;flex-direction:column;gap:10px;padding:8px 4px}",
      ".sd-panel-head{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".sd-notice{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sd-notice-error{color:var(--dsw-alias-state-error-primary)}",
      ".sd-search{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 10px;font-size:13px;line-height:18px;outline:none;width:100%}",
      ".sd-search:focus{border-color:var(--dsw-accent-strong)}",
      ".sd-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px;margin:0}",
      ".sd-list{display:flex;flex-direction:column;gap:2px;max-height:min(52vh,440px);overflow:auto}",
      ".sd-prow{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:32px;border-radius:8px;padding:0 8px;color:var(--dsw-alias-label-primary)}",
      ".sd-prow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-prow-on{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-prow-locked{opacity:.55}",
      ".sd-ptitle{flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:13px;line-height:18px}",
      ".sd-ptime{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;flex:none}",
      ".sd-badge{color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;flex:none}",
      ".sd-pbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sd-lead{box-sizing:border-box;width:16px;height:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:transparent;font-size:11px;line-height:14px;padding:0;margin:0;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center}",
      ".sd-lead:hover{border-color:var(--dsw-accent-strong)}",
      ".sd-lead:disabled{opacity:.4;cursor:not-allowed}",
      ".sd-lead-on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted)}",
      ".sd-hbtn-label{white-space:nowrap}",
    ].join("\n");

    // ── apply ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-profile-plugin-session-delete";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-delete: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: dictionaries");
      sessionsService = ctx.sessions;

      // 只读诊断：绝不写入、绝不刷新。
      startDiagnostics();

      // 单删 + 批量入口：原生会话菜单（官方 pin/rename/fork/archive 的同款落点）。
      // 渲染协议（dsh 0.1.7-rc.2 实测）：注册项 inject 是零参工厂，渲染层无参调用、
      // 返回值并入组件 props；行级数据（sessionId/displayTitle）由 renderSlot 的
      // owner 参数给出。因此锁定状态在组件内部按 props.sessionId 计算
      // （与官方 PinSessionMenuItem 的 usePinState(props) 同款模式）。
      ctx.slots.inject("sidebar.workspaces.session.menu.item", () => {
        const disposers = [];
        disposers.push(
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-delete",
              order: 500,
              locale: NS,
            },
            DeleteSessionMenuItem,
          ),
        );
        disposers.push(
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-delete-batch",
              order: 510,
              locale: NS,
            },
            BatchDeleteMenuItem,
          ),
        );
        return disposers;
      });

      // 批量面板 + 确认框：原生全局浮层。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "session-delete", order: 100, locale: NS }, OverlayHost),
      );

      // 诊断徽标（只读；bundle 干净时不渲染任何东西）。
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "session-delete-stale", order: 10, locale: NS }, StalePatchBadge),
      );

      // 设置页分区（与 overlay 同一面板）。
      //
      // `label` 必须给：设置页的分区名走 `resolveSlotLabel(entry.options.label) ?? id`，
      // 缺省时回退显示条目 id（用户看到的就是没名字/一串 id）。它会在读取时被**无参**
      // 调用（`dsh-client-ui-slots/lib/index.js:27`），且缓存按 locale 代次失效，
      // 所以这里绑定本插件命名空间的翻译函数（与官方 settings.section 同款）。
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "session-delete", order: 26, label: () => t("nav"), locale: NS },
          SessionDeleteSettings,
        ),
      );

      // 设置导航那一行左边是齿轮，不是垃圾桶——修掉它。
      //
      // 原因：`settings.section` 的公开契约**没有 icon 字段**，设置壳只投影
      // `id`/`order`/`label`，图标由一个硬编码白名单按分区 id 决定：
      //   dsh-client-ui-settings-general/lib/client.js:239-265
      //     /** Nav glyph by section id; unknown ids fall back to the settings gear. */
      // 我们的 id 不在名单里 → 吃默认齿轮。所以只能等它渲染出来后按 DOM 换掉
      // （dsh-better-sidebar 也是这么做的，见其 client.js:16092-16133）。
      //
      // 安全约定：
      //   1) 只认**我们自己的标签文本**，不认齿轮的样子——否则会把别人分区的图标
      //      一起端掉；
      //   2) 替换后打 `data-session-delete-nav-icon`，避免 MutationObserver 自激循环；
      //   3) 用 ctx.effect 持有 observer，插件卸载时自动断开。
      ctx.effect(() => observeSettingsNavIcon(() => t("nav")), "session-delete: settings nav icon");
    }

    /** 把设置导航里我们自己那一行的齿轮换成垃圾桶（幂等、可卸载）。 */
    function observeSettingsNavIcon(resolveLabel) {
      // 运行环境必须真的有这三样才动 DOM：单元测试用的极简 document 替身没有
      // querySelectorAll，真实浏览器三者都在。缺了就安静跳过，绝不抛错。
      if (
        typeof MutationObserver !== "function" ||
        typeof document === "undefined" ||
        typeof document.querySelectorAll !== "function" ||
        typeof document.createElementNS !== "function"
      ) {
        return () => {};
      }
      const MARK = "data-session-delete-nav-icon";
      const ORIGINAL = "data-session-delete-nav-original";
      let disposed = false;
      const sync = () => {
        if (disposed) return;
        const label = (resolveLabel() ?? "").trim();
        if (label === "") return;
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
          for (const span of dialog.querySelectorAll("nav span")) {
            if ((span.textContent ?? "").trim() !== label) continue;
            const button = span.parentElement;
            if (button === null || button === undefined) continue;
            if (button.querySelector(`[${MARK}]`) !== null) continue;
            const wrapper = button.firstElementChild;
            if (wrapper === null || wrapper === undefined) continue;
            const gear = wrapper.firstElementChild;
            if (gear === null || gear === undefined) continue;
            const replacement = buildTrashSvg(gear);
            if (replacement === null) continue;
            replacement.setAttribute(MARK, "");
            replacement.setAttribute(ORIGINAL, gear.outerHTML ?? "");
            gear.replaceWith(replacement);
          }
        }
      };
      sync();
      if (disposed) return () => {};
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => {
        disposed = true;
        observer.disconnect();
        // 卸载时还原成原图标，避免留下无人认领的 DOM 改动。
        for (const node of document.querySelectorAll(`[${MARK}]`)) {
          const original = node.getAttribute(ORIGINAL);
          if (original === null || node.parentElement === null) continue;
          node.parentElement.innerHTML = original;
        }
      };
    }

    /** 克隆齿轮 SVG 的几何属性，画一颗同尺寸的官方风格垃圾桶（不引入新依赖）。 */
    function buildTrashSvg(source) {
      if (source === null || source === undefined || typeof document === "undefined") return null;
      const NS_SVG = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS_SVG, "svg");
      for (const attr of ["width", "height", "viewBox"]) {
        const value = source.getAttribute?.(attr);
        if (typeof value === "string" && value !== "") svg.setAttribute(attr, value);
      }
      const className = source.getAttribute?.("class");
      if (typeof className === "string" && className !== "") svg.setAttribute("class", className);
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.6");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      for (const d of [
        "M3 6h18",
        "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
        "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
        "M10 11v6",
        "M14 11v6",
      ]) {
        const path = document.createElementNS(NS_SVG, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
      }
      return svg;
    }

    exports.apply = apply;
    exports.inject = inject;
    // 仅供测试：菜单组件（组件内部按 props.sessionId 计算行级锁定）。
    exports.__menu = { DeleteSessionMenuItem, BatchDeleteMenuItem };
    exports.openBatch = openBatch;
    exports.openConfirm = openConfirm;
    return module.exports;
  },
});
