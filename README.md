# Update Checker for Fedora

> Pending updates at a glance — in your GNOME top panel.

![GNOME 49–51](https://img.shields.io/badge/GNOME-49--51-blue) ![Fedora 43–44](https://img.shields.io/badge/Fedora-43--44-blue)

Update Checker for Fedora checks package sources on a schedule and shows pending-update counts in the panel. Open the indicator for a per-source breakdown, **Check now**, or an optional update action.

## Features

The machine-readable `summary-json` GSettings snapshot has a versioned schema. Source error text is redacted and truncated; commands and raw standard output are not included.

- DNF and Flatpak sources by default, with custom commands for other package managers and tools.
- Optional fwupd firmware checks, security-update counts, reboot status, and advisory details.
- Configurable polling intervals, notifications, quiet hours, ignored package identifiers, and package-database watches.
- Actionable update notifications (Open / Check now) and persistent notification snooze for 4 hours or until tomorrow at 08:00.
- Reorder sources with accessible up/down controls and switch between detailed and count-focused compact rows.
- Local history of successful daily update totals, retained for up to 7 days without storing commands or raw output.
- Quiet hours use local time with whole-hour precision (0–23); equal start and end hours mean notifications are silenced all day. Checks and the panel indicator remain active.
- Optional battery- and metered-network-aware polling.
- Terminal or background update actions, plus a configurable update script.
- A machine-readable GSettings summary for other extensions and integrations.

Update Checker for Fedora is a monitor, not an automatic updater: finding updates does **not** install them. Update actions are user-triggered.

## Requirements

- GNOME Shell **49, 50, or 51**.
- DNF is the default system-package source; Flatpak is also configured by default.
- `glib-compile-schemas` for manual installation.

This release targets GNOME Shell 49–51; older versions are not listed because their API compatibility is outside this release's supported and tested scope. If you use GNOME Shell 45–48, do not assume this version is compatible: use a release that explicitly supports your Shell version, if available, or wait for support to be added. The default DNF, security, and reboot checks are Fedora-oriented. On other distributions, configure commands suitable for your package manager and operating system.

## Install

The extension UUID is `update-checker-fedora@SakibShahariar.github.io`.

If you previously installed `update-checker@SakibShahariar.github.io` (or the older `update-checker@local`), disable and uninstall the old extension before enabling this one to avoid duplicate panel indicators. The GSettings schema ID and path are unchanged, so the new UUID continues to use the existing settings.

### From a GNOME extension ZIP

```sh
gnome-extensions install --force ./update-checker-fedora@SakibShahariar.github.io.zip
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

Replace the ZIP path with your downloaded archive.

### From Git

```sh
git clone https://github.com/SakibShahariar/update-checker-gnome.git ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

Open settings with:

```sh
gnome-extensions prefs update-checker-fedora@SakibShahariar.github.io
```

If GNOME does not discover or activate the extension immediately, log out and back in. On X11, restarting GNOME Shell may also be possible with **Alt+F2**, then **r**.

## Use

- The panel indicator shows the total pending-update count. Enable **Always show** to keep it visible at zero.
- Expand a source in the popup to inspect its reported update lines.
- Security updates are shown separately but are already included in the total.
- **Check now** runs an immediate check; **Dismiss errors** clears displayed errors until the next check.
- The default global check interval is 60 minutes. Each source can override it.

Each source's check command should print **one non-empty output line per pending update**. Commands run through `/bin/sh -c`; failures and checks that exceed the 120-second timeout are reported as errors. Review custom commands before saving them.

For full details on source commands, polling policies, ignored packages, privilege handling, and security/reboot checks, see the [configuration guide](docs/configuration.md).

## Integration

Other extensions can read the versioned `summary-json` GSettings snapshot without duplicating package-manager checks:

```sh
gsettings get org.gnome.shell.extensions.update-checker summary-json
```

See the [integration guide](docs/integration.md) for the schema, fields, and consumer guidance.

## Uninstall

```sh
gnome-extensions disable update-checker-fedora@SakibShahariar.github.io
rm -rf ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
```

These commands remove the installed extension but preserve its settings. To erase settings manually:

```sh
dconf reset -f /org/gnome/shell/extensions/update-checker/
```

## License

Licensed under **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE).
