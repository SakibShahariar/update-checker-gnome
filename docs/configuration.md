# Configuration

All settings are available from **Update Checker → Settings** (or `gnome-extensions prefs update-checker-fedora@SakibShahariar.github.io`). Enable **Notify on new security updates** to receive a separate alert when the security count increases; quiet hours and notification snooze apply. Press **Ctrl+Alt+U** to run Check now from anywhere. Change or disable this shortcut in General → Keyboard preferences. Panel and menu animations also respect GNOME's reduced-motion preference, including CSS hover and state transitions.

## Sources

Each source has a name and a shell check command. The extension resolves `sh` from the current process `PATH`, runs it with `-c`, and uses `setsid` (also resolved from `PATH`) to isolate each check in its own process group. It counts non-empty standard-output lines as pending updates, so configure one output line per update.

### Package output formats

Each source has an **Output format** selector in Preferences → Sources. **Auto (legacy)** is the default and preserves the previous behavior: the first whitespace-delimited token is the package name and the second/third token is shown as the version. Choose a preset when the command emits a known layout:

- **DNF:** package name, then available version.
- **Flatpak:** application ID, branch, remote, then version (the version is omitted when that column is absent).
- **npm outdated** and **Cargo outdated:** package name and the latest-version column.
- **uv tool list:** package name and the version marked `latest:`, falling back to the second column.

For other custom commands, choose **Custom columns** and enter the one-based name and version column numbers. For example, if output is `1.2.3 stable org.example.app`, set Name column to `3` and Version column to `1`. Column mappings outside 1–50 or with the same column for both fields are rejected; invalid saved format entries fall back to Auto. The default sources are DNF and Flatpak; optional presets include fwupd firmware checks. Custom sources can monitor tools such as Cargo, npm, or uv.

### Command execution dependencies

The command runner discovers a POSIX `sh` and `setsid` at runtime instead of assuming fixed `/bin/sh` and `/usr/bin/setsid` locations. On common Linux distributions, `setsid` is supplied by **util-linux**. Both executables must be visible in GNOME Shell's `PATH`; a shell or `setsid` installed only inside an unrelated container/Flatpak environment is not automatically visible to the host extension. If either executable is missing, the source check reports the missing dependency instead of silently running without process-group isolation. Keep the selected shell and `setsid` available in the same environment where GNOME Shell runs.

If no sources are configured, all sources are disabled, or every configured entry is malformed, the popup shows a distinct explanation. Activate that warning to open the Sources preferences page directly.

Each source can also define an optional update command and a polling interval. A source interval overrides the global interval; otherwise the global interval applies. The menu header shows the earliest next source check, and each source row shows its own next due time beside the last-check age. Changing an interval refreshes these times immediately. The default global interval is 60 minutes. Source checks default to a 120-second timeout; each source can override it from 5 to 600 seconds. A timeout is reported with the configured duration. By default, exit status 0 and DNF's status 100 are accepted; status 1 with no output remains a valid no-match result. DNF's `check-update` uses status 100 when updates are available; Flatpak's update-list command normally succeeds with 0. For custom tools with other success conventions, set **Success exit codes** to a comma-separated list (for example, `0,2`). Exit 0 is always accepted. When overriding DNF's defaults, include 100 if it should remain successful. Output and exit status are considered together because some package managers use a non-zero exit code to indicate that updates are available. Timeouts and command failures are reported as errors rather than as an empty update list.

Review custom commands before saving them. When a source check or per-source update command is changed, Preferences shows a non-blocking warning for commands containing elevation (`sudo`, `doas`, `pkexec`), redirection or `tee` to an absolute path, or potentially destructive tools such as `rm`, `mkfs`, and `dd`. The warning does not block saving and is not a shell sanitizer; commands remain trusted user input. Commands run as the logged-in user unless the command requests elevation.

## Automatic polling

- **Battery-aware polling:** optionally pause automatic checks while UPower reports that the machine is on battery.
- **Metered-network polling:** optionally pause automatic checks when NetworkManager reports a metered connection.
- **Database watches:** optionally recheck when watched DNF or Flatpak state changes.
- **Offline handling:** the last known counts are retained while offline and refreshed after reconnecting.
- **Quiet hours:** start and end are configured in whole local hours (0–23), not minute precision. Setting the same start and end hour means quiet hours last all day. Quiet hours suppress supported notifications; they do not stop checks or hide panel status.

The panel indicator exposes an accessible name that includes the current update count and relevant warning states (checking, source failures, security updates, reboot required, offline, or an update command running). Icon-only actions also have descriptive names and tooltips where applicable.
- **Notifications:** optionally notify when the total pending-update count increases.
- **Always show:** keep the panel indicator visible when no updates are pending.

Battery and metered-network policies apply to automatic checks. **Check now** remains available.

## Ignored packages

General settings can exclude exact package or app identifiers from successful source results. The extension matches the first whitespace-delimited token on each output line. Ignoring a package can hide security fixes, so use this only for identifiers you intentionally do not want counted.

## Security and reboot status

The optional security check can show a separate security-update count. That count is already included in the overall update total. Failed source rows include a collapsed **Details** view and a **Copy** action for stdout/stderr. Diagnostics are redacted before display or copying and are not included in the published summary. An optional advisory metadata command can provide multiple matching advisory lines. The **Advisory match regex** setting controls which lines are shown; up to five distinct matches are displayed. Use a pattern such as `APT-[0-9]+` for another distribution. Invalid patterns fall back to the built-in matcher. The reboot check uses a command that prints output only when a reboot is required; its default is Fedora-oriented.

These defaults are Fedora-focused. On other distributions, configure checks appropriate to the package manager and operating system.

## Update actions and privileges

Update actions are always user-triggered; discovering updates does not install them.

- **Terminal mode** opens the configured terminal and runs the source's update command interactively. The per-source button is labeled **Update · Terminal**.
- **Background mode** runs without a terminal; the per-source button is labeled **Update · Background**. Privileged commands use graphical `pkexec` elevation. A leading `doas`, `sudo`, or `pkexec` is normalized to a single `pkexec` invocation. Other elevation patterns such as `su -c` are not rewritten. Commands that combine an elevation prefix with shell composition (such as `&&`, `;`, or pipes) are rejected in background mode: split privileged and user-scoped tools (especially Flatpak) into separate sources/commands. Simple privileged commands continue to work.
- **Run Update Script** launches the script path configured in Advanced settings. It is a separate action and is not rewritten for background mode.

Background updates expose elapsed-time and stop controls. Stopping sends a termination signal to the tracked process group and force-kills it after a short grace period if it remains tracked. This is best-effort: a command that daemonizes or hands work to an unrelated service may continue. Disabling the extension cancels its in-progress source check commands, but does not cancel an update already running in a terminal or background process. Stop an update from the popup before disabling if you want it terminated.

## Matugen

Matugen integration is optional. The extension reads `~/.config/matugen/matugen-colors.css` and applies the palette to its popup. Configure Matugen to also write that file if your existing setup generates colors elsewhere. Palette changes are picked up without restarting GNOME Shell.
