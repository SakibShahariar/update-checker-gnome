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

Default sources are DNF and Flatpak. Add more from Preferences → Update
Sources, one `Name|command` per line. Some ready-made ones to paste in,
matching the tools in your fish script:

```
Cargo|cargo install-update -l -a 2>/dev/null | awk '$NF=="Yes"'
npm (global)|npm outdated -g --parseable 2>/dev/null
pipx|pipx list --outdated 2>/dev/null | grep -c '^package'
uv tools|uv tool list --outdated 2>/dev/null
```

Notes:
- `gup` (Go binaries) has no built-in "check only" mode, so it's not
  included by default — there's nothing to safely dry-run.
- `flatpak remote-ls --updates` checks against the default remote
  (usually `flathub`). If you use multiple remotes, add one source line
  per remote, e.g. `Flatpak (flathub)|flatpak remote-ls --updates flathub`.
- Parsing is line-count based and "good enough" for a badge, not pixel
  perfect — tune the commands/filters to match your exact tool output if
  you want precision.

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
