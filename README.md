# Update Checker (GNOME Shell extension)

Shows a count of pending updates in the top panel, refreshed on a timer.
Click the icon for a per-source breakdown, a "Check Now" button, and
(optionally) a "Run Update Script" button that opens a terminal and runs
your own update script — e.g. the fish script you're already using — so
`doas`/`sudo` password prompts still work interactively.

## Install

**Option A - from a release:** grab `update-checker@local.zip` from the
[Releases page](../../releases/latest), then:

```bash
unzip update-checker@local.zip -d ~/.local/share/gnome-shell/extensions/
cd ~/.local/share/gnome-shell/extensions/update-checker@local
glib-compile-schemas schemas/
```

**Option B - from a clone:**

```bash
git clone https://github.com/SakibShahariar/update-checker-gnome.git ~/.local/share/gnome-shell/extensions/update-checker@local
cd ~/.local/share/gnome-shell/extensions/update-checker@local
glib-compile-schemas schemas/
```

Reload GNOME Shell:
- **Wayland:** log out and back in.
- **X11:** `Alt+F2`, type `r`, `Enter`.

Then enable it:

```bash
gnome-extensions enable update-checker@local
```

Open preferences any time with:

```bash
gnome-extensions prefs update-checker@local
```

## How it works

Every N minutes (default 60, configurable), the extension runs each
configured source command via `sh -c`, captures stdout, and counts
non-empty lines. That count is treated as "updates available" for that
source. Nothing is ever installed automatically — it's read-only checking.

The default DNF source is:

```
dnf check-update -q --refresh | grep -E '^\S+\.\S+\s'
```

`--refresh` forces a real metadata refresh from the network on every
check, so the count is always accurate rather than bound by DNF's own
cache expiry - each check takes a few seconds instead of being
near-instant as a result. The `grep` filters output down to actual
package lines (`name.arch  version  repo`); dnf5's `check-update`
prints a category header line (e.g. "Upgrades (available for
reinstall, available for upgrade)") even with `-q`, which without
filtering gets counted as a phantom extra update.

Default sources are DNF and Flatpak. Click **"+ Add Source"** in
Preferences → Update Sources to pick from ready-made presets — Cargo,
npm (global), pipx, and uv tools — matching the tools in your fish
script, no manual typing needed. Each preset uses a verified check-only
command:

```
Cargo|cargo install-update -l -a | awk '$NF=="Yes"'
npm (global)|npm outdated -g --parseable
pipx|pipx list --outdated | grep '^package '
uv tools|uv tool list --outdated | grep '\[latest:'
```

A "Custom command…" option in the same popover adds a blank row for
anything not in the preset list.

## Failed checks vs. "up to date"

A source is only counted as "0 updates" if its command actually ran and
printed nothing. If a command isn't found (e.g. `cargo` isn't on PATH),
or it exits with an error and prints nothing to stdout (e.g. a network
failure during `dnf check-update --refresh`), that source is flagged as
**failed** instead — shown with a warning icon in the dropdown, with the
error visible if you click it. This keeps a broken check from silently
looking identical to "nothing pending." If every source fails and there
are also no updates, the panel icon still appears (with a warning icon)
so it isn't mistaken for "all clean."

Notes:
- `gup` (Go binaries) has no built-in "check only" mode, so it's not
  included by default — there's nothing to safely dry-run.
- `flatpak remote-ls --updates` checks against the default remote
  (usually `flathub`). If you use multiple remotes, add one source line
  per remote, e.g. `Flatpak (flathub)|flatpak remote-ls --updates flathub`.
- Parsing is line-count based and "good enough" for a badge, not pixel
  perfect — tune the commands/filters to match your exact tool output if
  you want precision. Prefer `grep 'pattern'` over `grep -c 'pattern'`
  for custom sources — `-c` prints a single summary line (which counts
  as "1"), not one line per update.

## Security updates

Separately from the main update count, the extension can flag how many
pending updates are security-related. This is **not** added on top of
the main total — security updates are already counted there, so a
second, additive count would double-count them. Instead it's shown as
its own icon and dropdown line, e.g. **"🛡 1 security update
pending"**, alongside the normal count.

The default check:

```
dnf check-update -q --refresh --security | grep -E '^\S+\.\S+\s'
```

Same header-stripping filter as the regular DNF source (see "How it
works" above), just with `--security` added. Requires network like the
main sources, so it's skipped while offline along with them — the last
known count stays visible rather than disappearing.

Toggle it off, or edit the command for other distros, in Preferences →
Security Updates.

## Offline handling

Before running any checks, the extension asks GNOME's own network
monitor whether there's a connection at all — no guessing via a failed
command first. If there isn't one:

- Network-dependent source checks (DNF, Flatpak, cargo, npm, pipx, uv)
  are skipped entirely, rather than run and left to fail one by one.
  This avoids a wall of per-source warning icons for something that
  isn't really a problem with any of those tools — just no connection.
- The reboot-required check keeps running as normal; it only reads the
  local RPM database and boot time, no network needed.
- The panel keeps showing the last-known count and per-source
  breakdown rather than going blank or flagging it as an error — the
  numbers aren't wrong, just possibly a little stale. A small greyed-out
  offline icon appears next to them, and the dropdown's status line
  switches to "Offline - showing results from HH:MM (N updates)" so
  it's clear the snapshot isn't live.
- The moment connectivity returns, a check runs automatically — no
  need to wait for the next scheduled interval or click "Check Now."

## Reboot required

Separately from update counts, the extension can check whether the
system needs a reboot to fully apply an already-installed update (e.g.
a new kernel or glibc). When it does, a second icon appears in the
panel and a "Reboot required" line shows at the top of the dropdown.

The default check wraps `dnf needs-restarting -r`:

```
err=$(dnf needs-restarting -r 2>&1 1>/dev/null); code=$?; if [ "$code" = "1" ]; then echo "Reboot required to finish pending updates"; elif [ "$code" != "0" ]; then printf "%s\n" "$err" >&2; exit 1; fi
```

`needs-restarting -r` exits `1` specifically when a reboot is needed and
`0` when it isn't. The wrapper checks for exactly that `1`, rather than
"any non-zero exit" — an earlier version used `command || echo ...`,
which fired on *any* failure (a transient error, a lock conflict,
anything), producing a false "reboot required" whenever the underlying
command broke for unrelated reasons. Any exit code other than `0` or `1`
is now treated as a genuine failure: it surfaces as **"⚠ Reboot check
failed: ..."** in the dropdown instead of being misread as "needed."

On Ubuntu/Debian, use this instead (set it in Preferences → Reboot
Required):

```
test -f /var/run/reboot-required && echo "Reboot required"
```

Toggle the check off entirely, or edit the command, from Preferences.

## Updating a single source

Each source in Preferences → Update Sources has an optional second
**Update** field, separate from its check command. When a source has
pending updates *and* an update command configured, clicking it in the
panel dropdown opens a terminal and runs just that command — e.g.
clicking "Flatpak: 3" runs only `flatpak update`, without touching DNF,
cargo, or anything else. Sources with no update command configured just
show their count and aren't clickable.

The built-in presets (DNF, Flatpak, Cargo, npm, pipx, uv) all come with
matching update commands pre-filled. Leave the field blank for any
source you'd rather only ever update through your own script.

Like "Run Update Script" below, the terminal closes as soon as the
command finishes — append `; read` to a custom command if you want the
window to stay open so you can see the output.

### Running without a terminal

Preferences → Per-Source Updates has a **"Run in background instead of
a terminal"** toggle. With it on, clicking a source's update:

- Strips any `doas`/`sudo` from the command and re-runs the whole thing
  through `pkexec` instead, which shows a normal graphical password
  prompt — no terminal window at all. This also handles chained
  commands like `doas dnf update -y && doas dnf autoremove -y`
  correctly (both `doas` calls are stripped, and the entire chain runs
  under one `pkexec`-elevated shell).
- Commands with no `doas`/`sudo` (cargo, pipx, uv, etc.) just run
  directly in the background, no prompt needed.
- A notification reports success or failure when it's done; on success,
  the extension automatically re-checks so the count updates.

Requires `pkexec` (part of polkit, installed by default on Fedora
Workstation). This only affects per-source updates — "Run Update
Script" always opens a terminal, since an external script's contents
can't be safely rewritten to swap `doas` for `pkexec` line-by-line, and
it's usually written to show its own progress anyway.

## Run Update Script

Set **Preferences → Update Script → Script path** to your fish script
(e.g. `/home/you/bin/update-system.fish`), and set the terminal command
if you don't use GNOME Terminal (default `gnome-terminal --`). The panel
menu's "Run Update Script" item then opens a terminal and runs it, so
you still see the colored output and get prompted for your `doas`
password as normal.

## Uninstall

```bash
gnome-extensions disable update-checker@local
rm -rf ~/.local/share/gnome-shell/extensions/update-checker@local
```
