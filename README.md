# Update Checker (GNOME Shell extension)

Shows a count of pending updates in the top panel, refreshed on a timer.
Click the icon for a per-source breakdown, a "Check Now" button, and
(optionally) a "Run Update Script" button that opens a terminal and runs
your own update script — e.g. the fish script you're already using — so
`doas`/`sudo` password prompts still work interactively.

**GNOME support policy:** `shell-version` tracks whatever the two
currently-maintained Fedora releases ship (Fedora runs exactly two at a
time, ~13 months of support each) — not because anything in the code
actually requires a recent GNOME, but because that's the only range
this extension is ever realistically tested against. As of this
writing that's GNOME 49-50 (Fedora 43-44). When Fedora's supported pair
rolls forward, bump this list to match.

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
dnf check-update -q --refresh --color=never | grep -E '^\S+\.\S+\s'
```

`--refresh` forces a real metadata refresh from the network on every
check, so the count is always accurate rather than bound by DNF's own
cache expiry - each check takes a few seconds instead of being
near-instant as a result. The `grep` filters output down to actual
package lines (`name.arch  version  repo`); dnf5's `check-update`
prints a category header line (e.g. "Upgrades (available for
reinstall, available for upgrade)") even with `-q`, which without
filtering gets counted as a phantom extra update.

`check-update` doesn't need root — as a regular user it just falls back
to a per-user cache under `~/.cache/dnf` instead of the system one, so
this should work as-is for most people. **If it fails with a permission
error** (e.g. `Unable to access configuration file ...: Permission
denied`, or errors loading `/usr/lib/sysimage/libdnf5/*.toml`), that
means something on your system has put root-only permissions on files
DNF needs to read even for a plain check — check with `ls -l` on the
file named in the error and `chmod 644` it if so. If you can't track
down the root cause and have **passwordless** `doas`/`sudo` configured
(a `nopass` rule in `/etc/doas.conf`, e.g. `permit nopass yourname as
root`), prefixing the check command with `doas`/`sudo` in Preferences
works around it, since root can read those files regardless of
permissions — but this isn't the shipped default, since checks run with
no terminal attached, and a `doas`/`sudo` call that isn't passwordless
has nowhere to prompt and just fails outright.

Default sources are DNF and Flatpak. Click **"+ Add Source"** in
Preferences → Update Sources to pick from ready-made presets — Cargo,
npm (global), and uv tools — matching the tools in your fish script, no
manual typing needed. Each preset uses a verified check-only command:

```
Cargo|cargo install-update -l -a | awk '$NF=="Yes"'
npm (global)|npm outdated -g --parseable
uv tools|uv tool list --outdated | grep '\[latest:'
```

A "Custom command…" option in the same popover adds a blank row for
anything not in the preset list.

## Failed checks vs. "up to date"

A source is only counted as "0 updates" if its command actually ran and
printed nothing. If a command isn't found (e.g. `cargo` isn't on PATH),
or it exits with an error and prints nothing to stdout (e.g. a network
failure during `dnf check-update --refresh`), that source is flagged as
**failed** instead — shown with a warning icon and a truncated reason
right in the dropdown (e.g. "DNF - failed: Permission denied..."), with
the full error available on click. This keeps a broken check from
silently looking identical to "nothing pending." If every source fails
and there are also no updates, the panel icon still appears (with a
warning icon) so it isn't mistaken for "all clean."

Notes:
- `gup` (Go binaries) and `pipx` both lack a "check only, don't touch
  anything" mode — `gup` has no dry-run at all, and pipx's `list`
  command has no `--outdated` flag despite what some docs suggest
  (confirmed against pipx 1.15.0's own `--help` output). Neither is
  included as a preset for that reason; `pipx upgrade-all` is
  idempotent (safe to run even with nothing outdated), so it's a
  reasonable thing to run periodically via "Run Update Script" instead
  of trying to check it first.
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
dnf check-update -q --refresh --security --color=never | grep -E '^\S+\.\S+\s'
```

Same header-stripping filter as the regular DNF source (see "How it
works" above), just with `--security` added. Requires network like the
main sources, so it's skipped while offline along with them — the last
known count stays visible rather than disappearing.

Toggle it off, or edit the command for other distros, in Preferences →
Security Updates.

## Offline handling

Before running any checks, the extension asks GNOME's own network
monitor whether there's genuine internet connectivity — not just "is
there a network route at all," which stays true even when connected to
a router with no working upstream internet (a captive portal, a WAN
outage, etc.). That distinction matters: without it, "connected but
nothing actually works" would run the real checks anyway and produce a
wall of technically-accurate but misleading failures, rather than the
quiet offline state below. If there's no full connectivity:

- Network-dependent source checks (DNF, Flatpak, cargo, npm, uv)
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
- The moment full connectivity returns — including completing a
  captive portal login, not just plugging a cable back in — a check
  runs automatically, after a short (5 second) delay, not instantly.
  The interface can report a route a moment before DNS/routing are
  actually working again right after reconnecting, so checking
  immediately risks a real but misleading "failed to download
  metadata" error. If it drops offline again before that timer fires,
  again before that delay is up, the pending check is cancelled rather
  than run against a connection that's already gone.

## Reboot required

Separately from update counts, the extension can check whether the
system needs a reboot to fully apply an already-installed update (e.g.
a new kernel or glibc). When it does, a second icon appears in the
panel and a "Reboot required" line shows at the top of the dropdown.

The default check wraps `dnf needs-restarting -r`:

```
out=$(dnf needs-restarting -r 2>&1); code=$?; if [ "$code" = "1" ] && printf "%s" "$out" | grep -qi reboot; then echo "Reboot required to finish pending updates"; elif [ "$code" != "0" ]; then printf "%s\n" "$out" >&2; exit 1; fi
```

`needs-restarting -r` exits `1` specifically when a reboot is needed
and `0` when it isn't — but that exit code alone isn't fully reliable:
dnf5's generic error handler can *also* exit `1` for unrelated failures
(a transient error, a lock conflict), which would otherwise get
misread as "reboot needed" purely by coincidence. The wrapper requires
*both* exit code `1` **and** the actual command output mentioning
"reboot" before treating it as a genuine signal. Anything that doesn't
clear both checks — including a real crash that happens to share the
same exit code — surfaces as **"⚠ Reboot check failed: ..."** instead
of being misread as "needed."

On Ubuntu/Debian, use this instead (set it in Preferences → Reboot
Required):

```
test -f /var/run/reboot-required && echo "Reboot required"
```

Toggle the check off entirely, or edit the command, from Preferences.

## Seeing which packages are pending

Any source with pending updates (e.g. "DNF: 3") expands right in the
dropdown when clicked — showing just the package name for each pending
update (the first whitespace-separated token of each output line, e.g.
`firefox-nightly.x86_64` rather than the full `name.arch version repo`
row). Click the source name again to collapse it. This is read-only —
the listed names aren't individually clickable, only the source-level
"run update" button (if configured) still is, positioned as its own
small button so it doesn't conflict with expanding/collapsing.

Any ANSI color codes a tool emits (some, like dnf5, print them even
when piped rather than going to a real terminal) are stripped before
display, generically, for every source — not just DNF.

## Updating a single source

Each source in Preferences → Update Sources has an optional second
**Update** field, separate from its check command. When a source has
pending updates *and* an update command configured, clicking it in the
panel dropdown opens a terminal and runs just that command — e.g.
clicking "Flatpak: 3" runs only `flatpak update`, without touching DNF,
cargo, or anything else. Sources with no update command configured just
show their count and aren't clickable.

The built-in presets (DNF, Flatpak, Cargo, npm, uv) all come with
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
- Commands with no `doas`/`sudo` (cargo, uv, etc.) just run
  directly in the background, no prompt needed.
- A notification reports success or failure when it's done; the
  extension re-checks either way, so the count updates on success and
  the row goes back to normal (rather than staying stuck) on failure.
- While it's running, the source's row shows a live elapsed-time
  counter ("Updating… 12s", ticking up every second) plus a stop
  button, instead of the count and run button — clicking the source
  again mid-run shows a notice rather than starting a second,
  conflicting update. There's no percentage/progress bar: the
  underlying tools don't report parseable progress when piped
  non-interactively, and every source's output format differs anyway,
  so an elapsed timer is the honest signal available generically across
  any configured source.
- The stop button kills the running process. For commands with no
  `doas`/`sudo` (cargo, uv, etc.) this is reliable — there's no extra
  process layer involved. For `doas`/`sudo` commands (routed through
  `pkexec`), stopping should work, but depending on how `pkexec` forks
  internally, the actual privileged work might technically be a child
  process that doesn't automatically die with it — this hasn't been
  exhaustively verified. If in doubt after clicking stop, check with
  `ps aux | grep dnf` (or whatever the command was).
- Automatic checks (timer tick, the package-database watcher, network
  reconnect) are skipped entirely while a background update is still
  running, rather than attempted — running one anyway would contend
  with the update for the same package-manager lock, which could hang
  the check with nothing to show until it cleared. The update's own
  completion already triggers a fresh, accurate check afterward, so
  nothing is lost by skipping. A manual "Check Now" click during this
  window shows a brief notice explaining why, instead of doing nothing
  silently; automatic triggers stay silent since a notification every
  time would just be noise.
- More generally, a check no longer clears the dropdown's rows before
  it's done — the last-known breakdown stays visible for the whole
  duration of any check, replaced only once fresh results are ready,
  rather than a "Checking…" gap with nothing shown if a check ever
  takes a while for any reason.
- A background update refuses to start at all if no internet
  connection is detected — even for a command that might not actually
  need network, since an arbitrary user-configured command can't be
  assumed either way. If that ends up blocking something that
  genuinely doesn't need a connection (a purely local operation), the
  workaround is running it manually instead until connectivity is
  detected again.

Terminal-launched updates ("Run Update Script", and per-source updates
when background mode is off) are tracked the same way internally, so
the "skip automatic checks while something is running" protection
above applies to them too — even though they don't get their own
elapsed-time/stop-button UI, since the open terminal window is already
that indicator for this mode.

Requires `pkexec` (part of polkit, installed by default on Fedora
Workstation). This only affects per-source updates — "Run Update
Script" always opens a terminal, since an external script's contents
can't be safely rewritten to swap `doas` for `pkexec` line-by-line, and
it's usually written to show its own progress anyway. The open
terminal window itself already serves as the "it's running" indicator
in that mode.

## Instant refresh after updates

The extension is otherwise purely poll-based — it only knows what it
knew as of its last scheduled check or manual "Check Now" click. If you
update packages some other way (your own terminal script, another
tool), the panel stays stale until the next check runs.

To close that gap, it watches DNF's and Flatpak's own state
directories directly (`/usr/lib/sysimage/libdnf5`, `/var/lib/rpm`,
`/var/lib/flatpak`, `~/.local/share/flatpak`) and triggers a fresh
check a few seconds after any of them change — a debounce, since a
single package operation touches these directories several times in a
row and there's no point checking on every individual write. This
catches an update *no matter how it was run*, not just ones triggered
through this extension.

It's harmless if a given path doesn't exist on your system (no
Flatpak installed, a different rpmdb layout) — that watch just never
fires. Toggle it off in Preferences → Instant Refresh After Updates if
you'd rather it stick to the timer only; this needs an extension reload
(log out/in, or `Alt+F2` → `r` on X11) to take effect either way.

## Quiet hours

Preferences → Quiet Hours can suppress the two background popup
notifications ("updates available" and "reboot required") during a
configured hour range — e.g. 23 to 8 for 11pm–8am. The panel icon and
count still update completely normally either way; only the popup
itself is skipped. Notifications from something you directly triggered
(like a per-source update finishing) are unaffected — quiet hours only
apply to the passive, periodic ones.

## Per-source intervals, history and dismiss

* **Per-source interval** — each source card in Preferences → Sources has an `Every [60] min` spin (default from General → Check interval). A fast source (e.g. DNF 60m, Cargo 1440m) is skipped until its interval elapses, reusing its last count; `Check Now` forces all.
* **History sparkline** — the dropdown footer shows the last 14 totals as `History ▁▅█ 12`, stored in `history` (`ISO|total`).
* **Dismiss errors** — when any source/reboot/security check fails, a `Dismiss errors` menu item appears; it clears `!`/warnings until the next poll.
* **Settings** — panel menu now has `Settings…` (calls `openPreferences()`).

## Run Update Script

Set **Preferences → Advanced → Update Script → Script path** to your fish script
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
