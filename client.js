// dsh-profile-plugin-session-delete — client half.
//
// 侧边栏原生级批量删除：
//   sidebar.workspaces.headerAction — 标题栏删除按钮（进入选择模式 + 浮动操作条）
//   sidebar.workspaces.sessionLead   — 选择模式下的行首勾选框
//   sidebar.workspaces.sessionMenu   — 「…」菜单「删除会话」单项（危险样式）
//   sidebar.footer.action            — 补丁修复失败时的警告徽标（stock 槽，兜底入口）
//   settings.section                 — 精简「删除会话」面板（补丁失效时的完整兜底）
//
// 真·自愈：页面加载自动 GET /status → 缺失则 POST /apply-patch → 成功无感刷新；
// 失败才提示手动重试（footer 徽标 + 面板横幅）。
window.__ModuleLoader__.load({
  id: "dsh-profile-plugin-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const e = React.createElement;
    const NS = "sessionDelete";
    const inject = ["slots", "sessions", "workspaces", "locale"];

    // ── 线性垃圾桶图标（与 Harness 原生图标同风格：描边 + currentColor）──
    function TrashIcon(props) {
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

    // ── 模块级服务句柄 ─────────────────────────────────────────────────────
    let sessionsService = null;

    // ── 选择状态 store ─────────────────────────────────────────────────────
    const selectionStore = { mode: "off", selected: new Set(), listeners: new Set() };
    let selectionSnapshot = { mode: "off", ids: [], count: 0 };
    function notifySelection() {
      for (const fn of [...selectionStore.listeners]) fn();
    }
    function commitSelection() {
      selectionSnapshot = { mode: selectionStore.mode, ids: [...selectionStore.selected], count: selectionStore.selected.size };
      notifySelection();
    }
    function subscribeSelection(fn) {
      selectionStore.listeners.add(fn);
      return () => selectionStore.listeners.delete(fn);
    }
    function getSelectionSnapshot() {
      return selectionSnapshot;
    }
    function setSelectMode(on) {
      selectionStore.mode = on ? "selecting" : "off";
      if (!on) selectionStore.selected.clear();
      commitSelection();
    }
    function toggleSession(id) {
      if (selectionStore.mode !== "selecting") return;
      if (selectionStore.selected.has(id)) selectionStore.selected.delete(id);
      else selectionStore.selected.add(id);
      commitSelection();
    }
    function selectIds(ids) {
      selectionStore.selected = new Set(ids);
      commitSelection();
    }

    // ── 自愈状态 store ─────────────────────────────────────────────────────
    const healStore = { listeners: new Set() };
    let healSnapshot = { state: "unknown", message: "" };
    function notifyHeal() {
      for (const fn of [...healStore.listeners]) fn();
    }
    function subscribeHeal(fn) {
      healStore.listeners.add(fn);
      return () => healStore.listeners.delete(fn);
    }
    function getHealSnapshot() {
      return healSnapshot;
    }
    function setHeal(state, message) {
      healSnapshot = { state, message };
      notifyHeal();
    }

    // ── 轻量 toast ─────────────────────────────────────────────────────────
    const toastStore = { listeners: new Set() };
    let toastSnapshot = null;
    function notifyToast() {
      for (const fn of [...toastStore.listeners]) fn();
    }
    function subscribeToast(fn) {
      toastStore.listeners.add(fn);
      return () => toastStore.listeners.delete(fn);
    }
    function getToastSnapshot() {
      return toastSnapshot;
    }
    let toastTimer = null;
    function showToast(message, ms = 4000) {
      toastSnapshot = { message };
      notifyToast();
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastSnapshot = null;
        notifyToast();
      }, ms);
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
    function apiStatus() {
      return apiJson("/session-delete/api/status", "GET");
    }
    function apiApplyPatch() {
      return apiJson("/session-delete/api/apply-patch", "POST");
    }
    function apiDelete(sessionId) {
      return apiJson("/session-delete/api/delete", "POST", { sessionId });
    }

    // ── 真·自愈（页面加载，模块级 once）────────────────────────────────────
    let selfHealStarted = false;
    function runApplyPatch() {
      setHeal("repairing", "");
      apiApplyPatch()
        .then((a) => {
          if (a && a.ok) {
            // 补丁已落盘；刷新页面取新 bundle（一次性——重载后 /status 为 true，无环）。
            setTimeout(() => window.location.reload(), 500);
          } else {
            setHeal("failed", a && a.error && a.error.message ? a.error.message : "apply-patch failed");
          }
        })
        .catch((error) => setHeal("failed", error && error.message ? error.message : "apply-patch failed"));
    }
    function startSelfHeal() {
      if (selfHealStarted) return;
      selfHealStarted = true;
      apiStatus()
        .then((s) => {
          if (!s || !s.ok) {
            setHeal("unknown", "");
            return;
          }
          if (s.value && s.value.patched === true) {
            setHeal("ok", "");
            return;
          }
          runApplyPatch();
        })
        .catch(() => setHeal("unknown", ""));
    }

    // ── 删除执行（20/批串行，逐条回报）────────────────────────────────────
    async function runDelete(sessionIds) {
      const results = [];
      for (let i = 0; i < sessionIds.length; i += 20) {
        const chunk = sessionIds.slice(i, i + 20);
        for (const id of chunk) {
          try {
            const res = await apiDelete(id);
            if (res && res.ok) results.push({ sessionId: id, ok: true });
            else results.push({ sessionId: id, ok: false, error: res && res.error ? res.error.message || res.error.code : "request failed" });
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

    // ── 确认弹窗（共用）────────────────────────────────────────────────────
    function ConfirmModal(props) {
      const { t, n, busy, error, onCancel, onConfirm } = props;
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
          e("div", { className: "sd-modal-title" }, t("confirmTitle")),
          e("div", { className: "sd-modal-desc" }, t("confirmDesc", { n })),
          error ? e("div", { className: "sd-modal-error", role: "alert" }, error) : null,
          e(
            "div",
            { className: "sd-modal-actions" },
            e(
              "button",
              { type: "button", className: "sd-btn", disabled: busy, onClick: onCancel },
              t("cancel"),
            ),
            e(
              "button",
              { type: "button", className: "sd-btn sd-btn-danger", disabled: busy, onClick: onConfirm },
              busy ? t("deleting") : t("confirmDelete"),
            ),
          ),
        ),
      );
    }

    // ── 标题栏按钮 + 浮动操作条 ────────────────────────────────────────────
    function HeaderAction(props) {
      const { t, wide, useSessions, useWorkspaces } = props;
      const sel = React.useSyncExternalStore(subscribeSelection, getSelectionSnapshot);
      const toast = React.useSyncExternalStore(subscribeToast, getToastSnapshot);
      const list = useSessions((s) => s);
      const archived = useWorkspaces((s) => s.archivedSessionIds) ?? [];
      const [confirm, setConfirm] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const doDelete = async () => {
        const ids = confirm.ids;
        setConfirm(null);
        setBusy(true);
        setError(null);
        try {
          const results = await runDelete(ids);
          await afterDelete(ids);
          const ok = results.filter((r) => r.ok).length;
          const fail = results.length - ok;
          const firstFail = results.find((r) => !r.ok);
          if (fail > 0) showToast(t("deletePartial", { ok, fail }) + (firstFail && firstFail.error ? "：" + firstFail.error : ""));
          else showToast(t("deleteDone", { ok }));
          setSelectMode(false);
        } catch (error) {
          setError(error && error.message ? error.message : String(error));
        }
        setBusy(false);
      };

      const bar =
        sel.mode === "selecting"
          ? e(
              "div",
              { className: "sd-bar", role: "toolbar" },
              e(
                "button",
                {
                  type: "button",
                  className: "sd-barbtn",
                  onClick: () => {
                    const selectable = Object.values(list.byId ?? {}).filter(
                      (s) => s && s.running !== true && s.id !== list.current && archived.indexOf(s.id) === -1,
                    );
                    selectIds(selectable.map((s) => s.id));
                  },
                },
                t("selectAll"),
              ),
              e(
                "button",
                { type: "button", className: "sd-barbtn", onClick: () => selectIds([]) },
                t("clearSel"),
              ),
              e(
                "button",
                {
                  type: "button",
                  className: "sd-barbtn sd-barbtn-danger",
                  disabled: sel.count === 0 || busy,
                  onClick: () => {
                    setError(null);
                    setConfirm({ ids: sel.ids });
                  },
                },
                t("deleteSelected", { n: sel.count }),
              ),
            )
          : null;

      return [
        e(
          "button",
          {
            key: "btn",
            type: "button",
            className: "sd-hbtn" + (sel.mode === "selecting" ? " sd-hbtn-on" : ""),
            title: sel.mode === "selecting" ? t("clearSel") : t("menuDelete"),
            onClick: () => setSelectMode(sel.mode !== "selecting"),
          },
          e(TrashIcon, { size: 16 }),
          sel.mode === "selecting" ? e("span", { className: "sd-dot" }) : null,
        ),
        bar,
        confirm
          ? e(
              ConfirmModal,
              {
                key: "confirm",
                t,
                n: confirm.ids.length,
                busy,
                error,
                onCancel: () => {
                  if (!busy) {
                    setConfirm(null);
                    setError(null);
                  }
                },
                onConfirm: doDelete,
              },
            )
          : null,
        toast ? e("div", { key: "toast", className: "sd-toast", role: "status" }, toast.message) : null,
      ];
    }

    // ── 行首勾选框 ─────────────────────────────────────────────────────────
    function LeadCheck(props) {
      const { node, t, useSessions } = props;
      const sel = React.useSyncExternalStore(subscribeSelection, getSelectionSnapshot);
      const current = useSessions((s) => s.current);
      if (sel.mode !== "selecting") return null;
      const disabled = node.running === true || node.id === current;
      const on = sel.ids.indexOf(node.id) !== -1;
      return e(
        "button",
        {
          type: "button",
          className: "sd-lead" + (on ? " sd-lead-on" : ""),
          disabled,
          title: disabled ? (node.running ? t("runningLocked") : t("currentLocked")) : t("toggleCheck"),
          onClick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggleSession(node.id);
          },
        },
        on ? "✓" : "",
      );
    }

    // ── 「…」菜单单项 ──────────────────────────────────────────────────────
    function MenuAction(props) {
      const { t, registerSessionMenu, useSessions } = props;
      const current = useSessions((s) => s.current);
      const [target, setTarget] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        if (typeof registerSessionMenu !== "function") return;
        registerSessionMenu(
          "delete",
          {
            id: "delete",
            label: t("menuDelete"),
            icon: e(TrashIcon, { size: 16 }),
            danger: true,
            disabled: (node) => node.running === true || node.id === current,
          },
          (node) => {
            setTarget(node);
            setError(null);
          },
        );
        return () => registerSessionMenu("delete", null, null);
      }, [registerSessionMenu, current]);
      if (target === null) return null;
      const doDelete = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          const results = await runDelete([target.id]);
          await afterDelete([target.id]);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) {
            setError(failed[0].error || "delete failed");
            setBusy(false);
            return;
          }
          setBusy(false);
          setTarget(null);
        } catch (error) {
          setBusy(false);
          setError(error && error.message ? error.message : String(error));
        }
      };
      return e(ConfirmModal, {
        t,
        n: 1,
        busy,
        error,
        onCancel: () => {
          if (!busy) {
            setTarget(null);
            setError(null);
          }
        },
        onConfirm: doDelete,
      });
    }

    // ── footer 徽标（补丁修复失败时的可见入口，stock 槽）──────────────────
    function FooterBadge(props) {
      const heal = React.useSyncExternalStore(subscribeHeal, getHealSnapshot);
      const { t, wide } = props;
      if (heal.state !== "failed" && heal.state !== "missing") return null;
      return e(
        "button",
        {
          type: "button",
          className: "sd-foot",
          title: t("patchRetry"),
          onClick: () => runApplyPatch(),
        },
        "⚠",
        wide ? e("span", { className: "sd-hbtn-label" }, " " + t("patchRetry")) : null,
      );
    }

    // ── 精简「删除会话」设置面板（兜底）────────────────────────────────────
    function SessionDeletePanel(props) {
      const { t, useSessions, useWorkspaces } = props;
      const heal = React.useSyncExternalStore(subscribeHeal, getHealSnapshot);
      const list = useSessions((s) => s);
      const archived = useWorkspaces((s) => s.archivedSessionIds) ?? [];
      const [query, setQuery] = React.useState("");
      const [selected, setSelected] = React.useState(new Set());
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [confirmOpen, setConfirmOpen] = React.useState(false);
      const [result, setResult] = React.useState(null);

      const byId = list.byId ?? {};
      const q = query.trim().toLowerCase();
      const rows = React.useMemo(() => {
        return Object.values(byId)
          .filter((s) => s && s.id)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .filter((s) => {
            if (q === "") return true;
            return String(s.title ?? "").toLowerCase().indexOf(q) !== -1 || s.id.toLowerCase().indexOf(q) !== -1;
          });
      }, [byId, q]);
      const isLocked = (s) => s.running === true || s.id === list.current;
      const toggle = (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      const doDelete = async () => {
        setConfirmOpen(false);
        setBusy(true);
        setError(null);
        setResult(null);
        try {
          const ids = [...selected];
          const results = await runDelete(ids);
          await afterDelete(ids);
          const ok = results.filter((r) => r.ok).length;
          const fail = results.length - ok;
          setResult({ ok, fail });
          setSelected(new Set());
        } catch (error) {
          setError(error && error.message ? error.message : String(error));
        }
        setBusy(false);
      };

      return e(
        "div",
        { className: "sd-panel" },
        e("div", { className: "sd-panel-head" }, t("panelDesc")),
        heal.state === "failed"
          ? e(
              "div",
              { className: "sd-notice sd-notice-error", role: "status" },
              t("patchFailed", { msg: heal.message }),
              e(
                "button",
                { type: "button", className: "sd-btn", onClick: () => runApplyPatch() },
                t("patchRetry"),
              ),
            )
          : null,
        heal.state === "missing"
          ? e("div", { className: "sd-notice", role: "status" }, t("patchRepairing"))
          : null,
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
                const locked = isLocked(s);
                const checked = selected.has(s.id);
                return e(
                  "div",
                  {
                    key: s.id,
                    className: "sd-prow" + (checked ? " sd-prow-on" : "") + (locked ? " sd-prow-locked" : ""),
                  },
                  e(
                    "button",
                    {
                      type: "button",
                      className: "sd-lead" + (checked ? " sd-lead-on" : ""),
                      disabled: locked,
                      title: locked ? (s.running ? t("runningLocked") : t("currentLocked")) : t("toggleCheck"),
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
          e(
            "button",
            { type: "button", className: "sd-btn", disabled: busy, onClick: () => setSelected(new Set(rows.filter((s) => !isLocked(s)).map((s) => s.id))) },
            t("selectAll"),
          ),
          e(
            "button",
            { type: "button", className: "sd-btn", disabled: busy, onClick: () => setSelected(new Set()) },
            t("clearSel"),
          ),
          e(
            "button",
            {
              type: "button",
              className: "sd-btn sd-btn-danger",
              disabled: busy || selected.size === 0,
              onClick: () => {
                setError(null);
                setConfirmOpen(true);
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
        confirmOpen
          ? e(ConfirmModal, {
              t,
              n: selected.size,
              busy,
              onCancel: () => {
                if (!busy) setConfirmOpen(false);
              },
              onConfirm: doDelete,
            })
          : null,
      );
    }

    // ── 双语字典（键集严格一致）───────────────────────────────────────────
    const zh = {
      nav: "删除会话",
      menuDelete: "删除会话",
      search: "搜索会话…",
      empty: "暂无会话",
      emptySearch: "无匹配会话",
      patchRepairing: "快捷入口补丁缺失，正在自动修复…",
      patchFailed: "补丁自动修复失败：{msg}",
      patchRetry: "重试修复",
      selectAll: "全选",
      clearSel: "清空",
      deleteSelected: "删除所选 ({n})",
      toggleCheck: "勾选 / 取消勾选",
      runningLocked: "运行中的会话不可删除",
      currentLocked: "当前打开的会话不可删除，请先切换到其他会话",
      confirmTitle: "永久删除会话",
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
      timeNow: "刚刚",
      timeMinutes: "{n}分钟前",
      timeHours: "{n}小时前",
      timeDays: "{n}天前",
      timeDate: "{d}",
    };
    const en = {
      nav: "Delete sessions",
      menuDelete: "Delete session",
      search: "Search sessions…",
      empty: "No sessions yet",
      emptySearch: "No matching sessions",
      patchRepairing: "Shortcut patch missing — repairing automatically…",
      patchFailed: "Automatic patch repair failed: {msg}",
      patchRetry: "Retry repair",
      selectAll: "Select all",
      clearSel: "Clear",
      deleteSelected: "Delete selected ({n})",
      toggleCheck: "Toggle selection",
      runningLocked: "Running sessions cannot be deleted",
      currentLocked: "The current session cannot be deleted. Switch to another session first.",
      confirmTitle: "Delete sessions permanently",
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
      ".sd-hbtn-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-accent-strong)}",
      ".sd-dot{position:absolute;top:2px;right:2px;width:7px;height:7px;border-radius:50%;background:var(--dsw-accent-strong);border:1.5px solid var(--dsw-alias-bg-layer-1);pointer-events:none}",
      ".sd-hbtn-label{white-space:nowrap}",
      ".sd-bar{position:fixed;left:12px;bottom:12px;z-index:1000;display:flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px 8px;box-shadow:0 4px 16px rgba(0,0,0,.18)}",
      ".sd-barbtn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:2px 10px;font-size:12px;line-height:18px;cursor:pointer}",
      ".sd-barbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-barbtn:disabled{opacity:.45;cursor:not-allowed}",
      ".sd-barbtn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".sd-lead{box-sizing:border-box;width:16px;height:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:transparent;font-size:11px;line-height:14px;padding:0;margin:0;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center}",
      ".sd-lead:hover{border-color:var(--dsw-accent-strong)}",
      ".sd-lead:disabled{opacity:.4;cursor:not-allowed}",
      ".sd-lead-on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted)}",
      ".sd-foot{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:26px;border:1px solid #f5a524;border-radius:8px;background:transparent;color:#f5a524;padding:0 8px;font-size:12px;line-height:18px;cursor:pointer}",
      ".sd-overlay{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}",
      ".sd-modal{box-sizing:border-box;width:min(420px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.25)}",
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
      ".sd-list{display:flex;flex-direction:column;gap:2px;max-height:440px;overflow:auto}",
      ".sd-prow{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:32px;border-radius:8px;padding:0 8px;color:var(--dsw-alias-label-primary)}",
      ".sd-prow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-prow-on{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sd-prow-locked{opacity:.55}",
      ".sd-ptitle{flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:13px;line-height:18px}",
      ".sd-ptime{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;flex:none}",
      ".sd-badge{color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;flex:none}",
      ".sd-pbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
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
      const t = ctx.locale.bind(NS);
      startSelfHeal();
      ctx.slots.inject("sidebar.workspaces.headerAction", () =>
        ctx.slots.register({ name: "sidebar.workspaces.headerAction", id: "delete", order: 0, locale: NS }, HeaderAction),
      );
      ctx.slots.inject("sidebar.workspaces.sessionLead", () =>
        ctx.slots.register({ name: "sidebar.workspaces.sessionLead", id: "delete", order: 0, locale: NS }, LeadCheck),
      );
      ctx.slots.inject("sidebar.workspaces.sessionMenu", () =>
        ctx.slots.register({ name: "sidebar.workspaces.sessionMenu", id: "delete", order: 0, locale: NS }, MenuAction),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "session-delete-heal", order: 10, locale: NS }, FooterBadge),
      );
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: "session-delete", order: 26, label: () => t("nav"), locale: NS }, SessionDeletePanel),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
