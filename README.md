# Update Checker

> Pending updates at a glance — in your GNOME top panel.

![GNOME 49–51](https://img.shields.io/badge/GNOME-49--51-blue) ![Fedora 43–44](https://img.shields.io/badge/Fedora-43--44-blue)

Update Checker checks package sources on a schedule and shows their pending-update counts in the panel. Click the indicator for a per-source breakdown, **Check now**, or an optional update action. It can also follow a Matugen-generated palette live.

## Features

- **Update counts:** DNF and Flatpak are configured by default; add custom shell commands for Cargo, npm, uv, or other tools.
- **Per-source controls:** configure a check command, optional update command, and per-source interval.
- **Security updates:** show a separate security-update count without adding it to the total again.
- **Reboot status:** optional check for whether a reboot is needed after updates.
- **Offline handling:** retain the last known counts while offline and refresh after reconnecting.
- **Notifications and quiet hours:** optionally notify when the total increases, with configurable quiet hours.
- **Database watches:** optionally recheck after watched DNF or Flatpak state changes.
- **Update actions:** run a source-specific command in a terminal or, optionally, in the background with a graphical privilege prompt.
- **Update script:** launch your own update script from the menu.
- **Matugen theming:** popup colors follow your generated wallpaper palette and refresh when it changes.

## Requirements

- GNOME Shell **49, 50, or 51**.
- DNF is the default system-package source; Flatpak is an additional default source. You can replace or remove either and configure other sources.
- `glib-compile-schemas` to compile the extension's settings schema during a manual installation.
- [Matugen](https://github.com/InioX/matugen) is optional. Without a readable generated palette, the extension uses its fallback styling.

The default DNF, security-update, and reboot checks are Fedora-oriented. Other distributions should configure commands appropriate to their package manager.

## Install

### From a GNOME extension ZIP

Use GNOME's extension installer so the extension is placed in its UUID-named directory:

```sh
gnome-extensions install --force ./update-checker@local.zip
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker@local/schemas/
gnome-extensions enable update-checker@local
```

Replace the ZIP path with the location of your downloaded archive.

### From Git

```sh
git clone https://github.com/SakibShahariar/update-checker-gnome.git \
  ~/.local/share/gnome-shell/extensions/update-checker@local
glib-compile-schemas ~/.local/share/gnome-shell/extensions/update-checker@local/schemas/
gnome-extensions enable update-checker@local
```

Open settings with:

```sh
gnome-extensions prefs update-checker@local
```

You can also open **Settings** from the extension's popup. If GNOME does not discover or activate the extension immediately, log out and back in; on X11, restarting GNOME Shell may also be possible with **Alt+F2**, then **r**.

## How checks work

Each source is configured as **Name|shell command**. The command runs through `/bin/sh -c`; the extension counts the non-empty lines written to standard output. Configure commands that print **one line per pending update**. It does not install updates automatically just because it finds them.

Default sources:

- **DNF:** `dnf check-update -q --refresh --color=never`, filtered to remove non-package output.
- **Flatpak:** `flatpak remote-ls --updates`.

A command's output and exit status are interpreted together because some package managers return a non-zero exit status when updates are available. Missing commands and likely command failures are shown as errors in the popup.

### Add or customize a source

Open **Settings → Sources** and add a preset or custom entry. Each source can have:
- a check command;
- an optional update command shown when that source has updates;
- its own interval, or the global interval.

Commands run as your logged-in user unless the command itself requests elevation. Review custom commands before saving them. The default update commands use `doas` for DNF and Flatpak; change them if your system uses `sudo` or a different package manager.

### Update actions

- **Terminal mode** opens the configured terminal and runs the source's update command interactively.
- **Background mode** uses `pkexec` for a graphical privilege prompt. The extension removes a leading `doas`/`sudo` from the configured command and runs the command elevated; avoid combining privileged and unprivileged tools in one command.
- **Run Update Script** launches the script path configured in Advanced settings. It remains a separate action and is not rewritten for background mode.

Update actions are user-triggered. The extension is an update monitor, not an automatic updater. Disabling the extension does **not** cancel an update command that is already running; stop it from the popup first if you need to cancel it. A package manager or elevated child process may continue after the panel indicator disappears.

## Panel and popup

- The panel indicator shows the total number of pending updates. Enable **Always show** to keep it visible when the count is zero.
- Expand a source to inspect its reported package lines.
- Security updates and reboot-required status are shown separately; security updates are already included in the main total.
- Use **Check now** to refresh immediately, or **Dismiss errors** to clear displayed errors until the next check.
- While a background update is running, the popup provides progress and stop controls.

## Settings

- **General:** global check interval, notifications, visibility at zero, quiet hours, and package-database watches.
- **Sources:** check commands, optional update commands, and per-source intervals.
- **Advanced:** reboot and security checks, update-script path, terminal command, and background-update behavior.

The default global interval is 60 minutes. Quiet hours suppress supported notifications; they do not stop checks or hide the panel status.

## Matugen theming

The extension reads Matugen colors from `~/.config/matugen/matugen-colors.css` and applies them to its popup. If your Matugen setup writes the palette elsewhere, configure Matugen to also generate this file. Palette changes are picked up without requiring a GNOME Shell restart.

## Uninstall

```sh
gnome-extensions disable update-checker@local
rm -rf ~/.local/share/gnome-shell/extensions/update-checker@local
dconf reset -f /org/gnome/shell/extensions/update-checker/
```

If you installed the extension using GNOME's extension installer, these commands remove its installed directory and reset its settings.
