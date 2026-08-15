# 🗑 plugin-session-delete

[![Release](https://img.shields.io/github/v/release/cynch18/plugin-session-delete)](https://github.com/cynch18/plugin-session-delete/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/cynch18/plugin-session-delete/test.yml)](https://github.com/cynch18/plugin-session-delete/actions)

> Fills the one gap DeepSeek Harness left open: **deleting sessions** — not from a buried settings page, but **right where you see them, in the sidebar**.

## Why it exists

DSH sessions only ever get renamed, forked, or archived. Archiving just hides a session — its files stay on disk. To truly delete one, you either dig through `.dsh` by hand or install a "session manager" that lives in Settings, forcing you to open Settings, find the panel, and check boxes every time.

Deleting a session should happen **where you see the session**. So this plugin adds nothing to your habits — just a 🗑 button in the header row, and deletion becomes a one-handed thing.

## Install in 30 seconds

```bash
npx @deepseek-ai/dsh plugin --profile web add github:cynch18/plugin-session-delete
```

Restart dsh → refresh the page. A **🗑** button appears on the left of the workspace header row.

**No patch scripts needed**: on first page load the plugin detects a missing sidebar patch, applies it, and reloads — the self-heal doubles as the installer. Verified end-to-end on a fresh profile: install → restart → plugin in the boot graph → patch in place, with just that one command.

> Alternative (offline / scripted): `node scripts/install.mjs` (cross-platform; copies, patches, and registers in one pass), or `install.ps1` on Windows. Pick **one** method — installing twice would create duplicate entries.

## How to use

1. Click **🗑** to enter selection mode — a checkbox appears at the left of every session row;
2. Check the ones you want gone (select-all is available; running and currently-open sessions are excluded automatically);
3. Click **Delete selected (n)** at the bottom-left → confirm → done.

Single deletion keeps the old habit: each session's "…" menu now has a red **Delete session** item.

Deletion is **permanent**: log files, workspace accounting, and archive state are all removed, and the confirmation dialog says so in plain words. But it never over-reaches — subagents, forks, and produced files are kept unless you explicitly select them.

## After an upgrade, nothing happens

This plugin opens three slots in the sidebar (one small patch). You might worry: won't a DSH upgrade wipe the patch?

It will. **But you will never know.** On page load the plugin detects it, re-applies it, and reloads — the 🗑 is always there. Only when auto-repair itself fails (permissions, locked file, a restructured release) does a ⚠ appear at the sidebar bottom. That is the whole split from settings-panel plugins: they sell "stability with zero patches", this one sells "speed + never having to care".

## Safety floor

- If the patch is ever unavailable, the **Settings → Delete sessions** panel still works fully — and it can see archived sessions too;
- Running sessions are rejected server-side (409); the currently-open session is disabled in the UI;
- The API only trusts loopback requests — starting with `--host 0.0.0.0` makes it refuse everything (403);
- Verified on DSH **0.1.0-rc.6**, including a "simulated upgrade → auto-repair" drill.

## Uninstall

```bash
# 1. remove the plugin-session-delete entry from cordis.patch.yml
node scripts/patch-workspace-menu.mjs strip   # 2. surgically remove the patch (skipped automatically if already upgraded)
# 3. delete profiles\web\node_modules\dsh-profile-plugin-session-delete\
```

## License

Deletion semantics were implemented following patterns from [dsh-archived-sessions](https://github.com/Zephyr-vibe/dsh-archived-sessions) (MIT). Anchor-drift troubleshooting after upgrades: [docs/anchors.md](docs/anchors.md).

MIT — © 2026 CYNCH18
