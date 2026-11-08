# Update Checker for Fedora

> See pending system updates without leaving your GNOME desktop.

![GNOME 49–51](https://img.shields.io/badge/GNOME-49--51-blue) ![Fedora 43–44](https://img.shields.io/badge/Fedora-43--44-blue) ![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue)

Update Checker monitors package sources on a schedule and displays the total number of pending updates in the GNOME top panel. Open the indicator to see which sources have updates, inspect reported package lines, run an immediate check, or start an update action when you choose.

**It does not install updates automatically.** Checks and update actions are separate: the extension reports what is available, and you decide whether and when to update.

## What it does

### Monitor your software sources
- DNF and Flatpak are configured as the default sources.
- Add custom check commands for other package managers and tools, including npm, Cargo, and uv.
- Optionally monitor fwupd firmware updates, security updates, reboot requirements, and advisory details.
- See a per-source breakdown, last-check information, and source errors in the popup.

### Fit checks around your system
- Set a global polling interval or override it for individual sources. The default global interval is **60 minutes**.
- Optionally pause automatic checks on battery power or metered networks.
- Watch package-database changes and recheck when watched DNF or Flatpak state changes.
- Enable adaptive polling to lengthen intervals for sources whose update counts remain stable over weekly history windows.
- Configure notifications, quiet hours, notification snooze, and ignored package identifiers.
- Keep the panel indicator visible even when no updates are pending.

### Choose how updates run
- Start an update command in a terminal or run it in the background.
- Configure a separate update script.
- Review confirmation prompts for potentially high-impact **Update all** commands.
- Run **Check now** from the popup or press **Ctrl+Alt+U** (the shortcut can be changed in preferences).

### Make it yours
- Search preferences across the General, Sources, and Advanced pages.
- Reorder sources and choose detailed or compact source rows.
- Export and import a versioned full configuration backup.
- Optionally apply a Matugen palette to the popup.

## How it works

1. The extension checks each enabled source according to its configured schedule.
2. It counts non-empty output lines from each source command as pending updates.
3. The panel indicator displays the combined total; the popup lets you inspect individual sources and their reported lines.
4. You choose whether to run an update action. Finding updates never starts installation by itself.

Security updates are displayed separately, but are already included in the overall update total.

## Requirements and compatibility

- **GNOME Shell:** 49, 50, or 51.
- **Distribution:** Fedora is the primary target. DNF, security-update, and reboot-check defaults are Fedora-oriented.
- **Default sources:** DNF and Flatpak.
- **Manual installation:** `glib-compile-schemas` is required.

This release does not claim compatibility with GNOME Shell 45–48. On another distribution, configure commands appropriate for its package manager and operating system.

## Install

The extension UUID is `update-checker-fedora@SakibShahariar.github.io`.

> **Upgrading from an older installation?** Disable and uninstall `update-checker@SakibShahariar.github.io` (or the older `update-checker@local`) before enabling this extension, otherwise you may get duplicate panel indicators. Your existing settings are retained because the GSettings schema ID and path are unchanged.

### Install from a GNOME extension ZIP

Download the extension ZIP, then run:

```sh
gnome-extensions install --force ./update-checker-fedora@SakibShahariar.github.io.zip
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

Replace the ZIP path with the archive you downloaded.

### Install from Git

```sh
git clone https://github.com/SakibShahariar/update-checker-gnome.git ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

Open preferences:

```sh
gnome-extensions prefs update-checker-fedora@SakibShahariar.github.io
```

If GNOME does not discover or activate the extension immediately, log out and back in. On X11, you may also be able to restart GNOME Shell with **Alt+F2**, then **r**.

## Configure your sources

Each source has a check command and can optionally have its own update command, polling interval, timeout, and output format.

**Important:** a check command must print **one non-empty output line per pending update**. The extension uses those lines to calculate the count. The default source timeout is 120 seconds; per-source timeouts can be configured from 5 to 600 seconds.

Commands are run through `sh -c` and isolated with `setsid`, both resolved from GNOME Shell's `PATH`. If either dependency is unavailable, the check reports an error. Review custom commands before saving them: they run as your logged-in user unless they explicitly request elevation.

The Sources preferences page supports output-format presets for DNF, Flatpak, npm outdated, Cargo outdated, and uv tool list, as well as custom column mappings.

For source setup, polling behavior, ignored packages, privilege handling, security and reboot checks, and command details, see the **[configuration guide](docs/configuration.md)**.

## Integration for other extensions

Update Checker publishes a versioned JSON status snapshot through GSettings. Other extensions can read it instead of running duplicate package-manager checks:

```sh
gsettings get org.gnome.shell.extensions.update-checker summary-json
```

The snapshot includes the total and security update counts, last-check display time, busy/offline/failure state, and reboot status. It is a read-only snapshot; consumers should check its version and handle missing or malformed data.

See the **[integration guide](docs/integration.md)** for the schema and consumer guidance.

## Diagnostics and performance

Optional performance counters provide session-local aggregate measurements for checks, command processes, menu rebuilds, and update actions. Collection is disabled by default.

See the **[performance profiling guide](docs/performance-profiling.md)** for repeatable before-and-after measurements.

## Uninstall

Disable and remove the extension:

```sh
gnome-extensions disable update-checker-fedora@SakibShahariar.github.io
rm -rf ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
```

This preserves your settings. To remove them as well:

```sh
dconf reset -f /org/gnome/shell/extensions/update-checker/
```

## License

Licensed under **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE).
