# 🗑 plugin-session-delete

[![Release](https://img.shields.io/github/v/release/cynch18/plugin-session-delete)](https://github.com/cynch18/plugin-session-delete/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/cynch18/plugin-session-delete/test.yml)](https://github.com/cynch18/plugin-session-delete/actions)

> Fills the one gap DeepSeek Harness left open: **deleting sessions** — not from a buried settings page, but **right where you see them, in the row's "…" menu**, plus a full-screen batch picker.

## Why it exists

DSH sessions only ever get renamed, forked, or archived. Archiving just hides a session — its files stay on disk. To truly delete one, you either dig through `.dsh` by hand or install a "session manager" that lives in Settings, forcing you to open Settings, find the panel, and check boxes every time.

Deleting a session should happen **where you see the session**.

## What it does (0.2.0: zero-patch architecture)

All three surfaces are **stock DSH slots**, registered through `ctx.slots.inject()`. This plugin writes no Harness files:

| Surface | Stock slot | Content |
|---|---|---|
| Session row "…" menu | `sidebar.workspaces.session.menu.item` | red **Delete session** (order 500, after the shipped Archive at 400) + **Delete sessions…** (510) |
| Global overlay | `shell.overlay` | permanent-delete confirm dialog + batch picker |
| Settings page | `settings.section` | the same batch picker |

The batch picker lists **every** session (archived included) with search, select-all, automatic locking of running/current sessions, and per-item result reporting.

> **Upgrades can no longer strand you.** Versions ≤ 0.1.1 text-surgered the `dsh-client-ui-workspace` bundle; anchors were pinned to upstream JSX structure, and the target file is a *globally shared* copy inside the npx cache — so a version bump could leave a half-applied patch behind, which combined with the "auto-apply then auto-reload" heal loop produced white screens and reload loops. 0.2.0 deletes all of that: no file writes, no auto-reload, no re-patching.

## Install in 30 seconds

```bash
npx @deepseek-ai/dsh plugin --profile web add github:cynch18/plugin-session-delete
```

Restart dsh → refresh the page. The row's "…" menu gains **Delete session** and **Delete sessions…**.

> Alternative (offline / scripted): `node scripts/install.mjs` (cross-platform) or `install.ps1` on Windows. Pick **one** method — installing twice would create duplicate entries.

## How to use

1. **Single**: row "…" → red **Delete session** → a dialog that says, in plain words, that this cannot be recovered;
2. **Batch**: row "…" → **Delete sessions…** (or Settings → Delete sessions) → check → **Delete selected (n)** → confirm.

Deletion is **permanent**: log files, projection cache, workspace accounting, and archive state are all removed. But it never over-reaches — subagents, forks, and produced files are kept unless you explicitly select them.

## Safety floor

- Running sessions are rejected server-side (409); the currently-open session is disabled in the UI;
- The API only trusts loopback Hosts (starting with `--host 0.0.0.0` makes it refuse everything with 403), and rejects cross-site requests and foreign Origins;
- Every delete path goes through a sessions-root fence plus a session-id charset check — no path-shaped input is ever concatenated;
- Slot declarations verified against DSH **0.1.7-rc.2** (`sidebar.workspaces.session.menu.item`, `shell.overlay`, `settings.section`).

## After an upgrade

Nothing to repair. If you upgraded from 0.1.x, the bundle may still carry the old patch markers: a ⚠ badge appears at the sidebar bottom and the settings panel says so. Remove them with:

```bash
node scripts/patch-workspace-menu.mjs strip
```

See [docs/legacy-patch.md](docs/legacy-patch.md).

## Uninstall

```bash
# 1. remove the plugin-session-delete entry from the profile's cordis.patch.yml
# 2. delete profiles\web\node_modules\dsh-profile-plugin-session-delete\
# 3. (only if you upgraded from 0.1.x) node scripts/patch-workspace-menu.mjs strip
```

## License

Deletion semantics were implemented following patterns from [dsh-archived-sessions](https://github.com/Zephyr-vibe/dsh-archived-sessions) (MIT).

MIT — © 2026 CYNCH18
