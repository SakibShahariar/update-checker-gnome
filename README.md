# Update Checker

> Pending updates at a glance — in your top panel.

![GNOME 49-50](https://img.shields.io/badge/GNOME-49--50-blue) ![Fedora](https://img.shields.io/badge/Fedora-43--44-blue)

Click the icon for a per-source breakdown, `Check Now`, or `Run Update Script` (your fish script, with `doas` prompts).

### Features

| | |
|---|---|
| 🔢 **Counts** | DNF, Flatpak, Cargo, npm, uv — one line = one update |
| 🎯 **Per-source** | Check + optional update command + custom interval |
| 📈 **History** | Last 14 totals as sparkline `▁▅█ 12` |
| 🛡️ **Security** | Separate `🛡` icon, not double-counted |
| ⟳ **Reboot** | `needs-restarting` check, own icon |
| 🌙 **Quiet hours** | Silence popups, keep icon live |
| ⚡ **Instant refresh** | Watches `/usr/lib/sysimage/libdnf5` etc. |
| ▶️ **Background** | `pkexec` graphical prompt, elapsed + stop |

### Install

```bash
# from release
unzip update-checker@local.zip -d ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker@local/schemas/

# or clone
git clone https://github.com/SakibShahariar/update-checker-gnome.git ~/.local/share/gnome-shell/extensions/update-checker@local
glib-compile-schemas schemas/
```

Enable: `gnome-extensions enable update-checker@local`  
Prefs: `gnome-extensions prefs update-checker@local` or panel → `Settings…`

Reload: Wayland logout, X11 `Alt+F2` → `r`

### How it works

Runs each source via `sh -c`, counts non-empty stdout lines. Nothing auto-installed.

Default DNF: `dnf check-update -q --refresh --color=never | grep -E '^\S+\.\S+\s'`
* `--refresh` = real metadata, `grep` removes header phantom line.

<details>
<summary>Permissions & presets</summary>

* No root needed — falls back to `~/.cache/dnf`. If `Permission denied` on `/usr/lib/sysimage/libdnf5/*.toml`, `chmod 644`.
* Passwordless `doas`/`sudo` (`permit nopass` in `/etc/doas.conf`) can prefix check commands; non-nopass fails (no tty).
* Presets: `+ Add Source` → DNF / Flatpak / Cargo / npm / uv / Custom
</details>

### Panel

* `3` = updates, `!` = failed, `1` + `🛡`/`⟳`/`offline` icons.
* Click source → expand package names (first token), run button if update command set.
* `Dismiss errors` clears `!` until next poll.

### Settings

**General** — interval, notify, always show, quiet hours, watch DBs  
**Sources** — per-source check + `On click →` update + `Every [60] min`  
**Advanced** — reboot, security, script + terminal

<details>
<summary>Offline, Reboot, Security</summary>

* **Offline:** `FULL` connectivity only = skip DNF etc., keep stale counts + grey `offline` icon, status `Offline - from 14:32 (3)`. Reboot check still runs. Reconnect → 5s debounce.
* **Reboot:** `needs-restarting -r` exit 1 + `grep reboot` → `⟳` icon, else `⚠`.
* **Security:** `dnf --security` — subset, not added to total, skipped offline.
</details>

<details>
<summary>Updating</summary>

* Terminal vs background (`pkexec` strips `doas`/`sudo`, `Updating… 12s` + stop). Background skipped if offline; auto-checks skipped while running.
* `Run Update Script` always terminal.
</details>

### Uninstall

```bash
gnome-extensions disable update-checker@local
rm -rf ~/.local/share/gnome-shell/extensions/update-checker@local
```
