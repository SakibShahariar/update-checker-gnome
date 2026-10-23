# Configuration

All settings are available from **Update Checker → Settings** (or `gnome-extensions prefs update-checker-fedora@SakibShahariar.github.io`).

## Sources

Each source has a name and a shell check command. The extension runs the command through `/bin/sh -c` and counts non-empty standard-output lines as pending updates, so configure one output line per update. The default sources are DNF and Flatpak; optional presets include fwupd firmware checks. Custom sources can monitor tools such as Cargo, npm, or uv.

Each source can also define an optional update command and a polling interval. A source interval overrides the global interval; otherwise the global interval applies. The default global interval is 60 minutes. A check has a 120-second timeout. Output and exit status are considered together because some package managers use a non-zero exit code to indicate that updates are available. Timeouts and command failures are reported as errors rather than as an empty update list.

Review custom commands before saving them. Commands run as the logged-in user unless the command requests elevation.

## Automatic polling

- **Battery-aware polling:** optionally pause automatic checks while UPower reports that the machine is on battery.
- **Metered-network polling:** optionally pause automatic checks when NetworkManager reports a metered connection.
- **Database watches:** optionally recheck when watched DNF or Flatpak state changes.
- **Offline handling:** the last known counts are retained while offline and refreshed after reconnecting.
- **Quiet hours:** suppress supported notifications; they do not stop checks or hide panel status.
- **Notifications:** optionally notify when the total pending-update count increases.
- **Always show:** keep the panel indicator visible when no updates are pending.

Battery and metered-network policies apply to automatic checks. **Check now** remains available.

## Ignored packages

General settings can exclude exact package or app identifiers from successful source results. The extension matches the first whitespace-delimited token on each output line. Ignoring a package can hide security fixes, so use this only for identifiers you intentionally do not want counted.

## Security and reboot status

The optional security check can show a separate security-update count. That count is already included in the overall update total. An optional advisory metadata command can provide a matching advisory/severity line. The reboot check uses a command that prints output only when a reboot is required; its default is Fedora-oriented.

These defaults are Fedora-focused. On other distributions, configure checks appropriate to the package manager and operating system.

## Update actions and privileges

Update actions are always user-triggered; discovering updates does not install them.

- **Terminal mode** opens the configured terminal and runs the source's update command interactively.
- **Background mode** uses graphical `pkexec` elevation. A leading `doas`, `sudo`, or `pkexec` is normalized to a single `pkexec` invocation. Other elevation patterns such as `su -c` are not rewritten. Avoid combining privileged and unprivileged tools in one update command.
- **Run Update Script** launches the script path configured in Advanced settings. It is a separate action and is not rewritten for background mode.

Background updates expose elapsed-time and stop controls. Stopping sends a termination signal to the tracked process group and force-kills it after a short grace period if it remains tracked. This is best-effort: a command that daemonizes or hands work to an unrelated service may continue. Disabling the extension also does not cancel an update already running; stop it from the popup first if needed.

## Matugen

Matugen integration is optional. The extension reads `~/.config/matugen/matugen-colors.css` and applies the palette to its popup. Configure Matugen to also write that file if your existing setup generates colors elsewhere. Palette changes are picked up without restarting GNOME Shell.
