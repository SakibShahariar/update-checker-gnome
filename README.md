# Update Checker for Fedora

> See pending system updates at a glance, right from your GNOME top panel.

![GNOME 49–51](https://img.shields.io/badge/GNOME-49--51-blue) ![Fedora 43–44](https://img.shields.io/badge/Fedora-43--44-blue) ![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue)

Update Checker monitors software sources on a schedule and shows the number of available updates in the panel. Open the indicator for a per-source breakdown, run **Check now**, or start an update when you're ready.

**Updates are never installed automatically.** You stay in control of every update action.

## Features

- **Multiple sources:** DNF and Flatpak by default, with custom commands for tools such as npm, Cargo, and uv.
- **System status:** Optional security and firmware updates, reboot status, and advisory details.
- **Flexible checks:** Per-source intervals, adaptive polling, battery and metered-network awareness, and package-database watches.
- **Useful notifications:** Update alerts, quiet hours, snooze, and configurable ignored packages.
- **Update controls:** Terminal or background update actions, a configurable update script, and confirmation for potentially high-impact bulk actions.
- **Customizable interface:** Detailed or compact source rows, source reordering, searchable preferences, and optional Matugen colors.
- **History and integration:** Local update-count history and a versioned GSettings status summary for other extensions.

## Requirements

- GNOME Shell **49, 50, or 51**.
- Fedora is the primary target; DNF, security, and reboot checks use Fedora-oriented defaults.
- `glib-compile-schemas` is required for manual installation.

Other distributions may be used with appropriately configured package-manager and system commands. GNOME Shell 45–48 are not supported by this release.

## Install

The extension UUID is `update-checker-fedora@SakibShahariar.github.io`.

### From a GNOME extension ZIP

```sh
gnome-extensions install --force ./update-checker-fedora@SakibShahariar.github.io.zip
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

### From Git

```sh
git clone https://github.com/SakibShahariar/update-checker-gnome.git ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io/schemas/
gnome-extensions enable update-checker-fedora@SakibShahariar.github.io
```

Open preferences with:

```sh
gnome-extensions prefs update-checker-fedora@SakibShahariar.github.io
```

**Upgrading from an older version?** Disable and uninstall `update-checker@SakibShahariar.github.io` or `update-checker@local` first to avoid duplicate panel indicators. Your settings are preserved.

## Getting started

The panel indicator displays the combined update count. Open it to inspect individual sources and their reported updates. **Check now** starts an immediate check; **Ctrl+Alt+U** is the default global shortcut and can be changed in preferences.

Each source check command should print one non-empty line per pending update. Configure sources and their output formats in preferences. See the **[configuration guide](docs/configuration.md)** for command setup, polling, security checks, and update privileges.

## Integration

Other extensions can read the versioned status snapshot with:

```sh
gsettings get org.gnome.shell.extensions.update-checker summary-json
```

See the **[integration guide](docs/integration.md)** for its fields and usage. For performance measurements, see the **[profiling guide](docs/performance-profiling.md)**.

## Uninstall

```sh
gnome-extensions disable update-checker-fedora@SakibShahariar.github.io
rm -rf ~/.local/share/gnome-shell/extensions/update-checker-fedora@SakibShahariar.github.io
```

To remove saved settings too:

```sh
dconf reset -f /org/gnome/shell/extensions/update-checker/
```

## License

**GPL-3.0-only** — see [LICENSE](LICENSE).
