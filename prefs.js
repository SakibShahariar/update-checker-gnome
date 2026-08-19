import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Known-good check-only commands for common tools. Each prints one line
// of output per pending update on stdout, so a plain line count is
// accurate (verified against each tool's current documented behavior).
const PRESET_SOURCES = [
    {
        name: 'DNF',
        command: "dnf check-update -q --refresh | grep -E '^\\S+\\.\\S+\\s'",
        updateCommand: 'doas dnf update --refresh -y && doas dnf autoremove -y',
        blurb: 'Fedora/RHEL system packages. --refresh forces a real metadata check every run.',
    },
    {
        name: 'Flatpak',
        command: 'flatpak remote-ls --updates',
        updateCommand: 'flatpak update -y && flatpak uninstall --unused -y',
        blurb: 'Checks your default remote (usually flathub). Add one source per extra remote if needed.',
    },
    {
        name: 'Cargo',
        command: "cargo install-update -l -a | awk '$NF==\"Yes\"'",
        updateCommand: 'cargo install-update -a',
        blurb: 'Rust binaries installed via `cargo install`, using the cargo-update crate.',
    },
    {
        name: 'npm (global)',
        command: 'npm outdated -g --parseable',
        updateCommand: 'doas npm update -g',
        blurb: 'Global npm packages. --parseable prints one line per outdated package, no header.',
    },
    {
        name: 'pipx',
        command: "pipx list --outdated | grep '^package '",
        updateCommand: 'pipx upgrade-all',
        blurb: 'Python CLI tools installed via pipx.',
    },
    {
        name: 'uv tools',
        command: "uv tool list --outdated | grep '\\[latest:'",
        updateCommand: 'uv tool upgrade --all',
        blurb: 'Python tools installed via `uv tool install`. Requires network access to check.',
    },
];

export default class UpdateCheckerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- General group ---
        const generalGroup = new Adw.PreferencesGroup({title: 'General'});
        page.add(generalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Check interval (minutes)',
            subtitle: 'How often to re-run all update checks',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 1440, step_increment: 5}),
        });
        settings.bind('check-interval-minutes', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on new updates',
            subtitle: 'Show a notification when the update count increases',
        });
        settings.bind('notify-on-new', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(notifyRow);

        const showZeroRow = new Adw.SwitchRow({
            title: 'Keep icon visible when up to date',
            subtitle: 'Off (default): the panel icon only appears when updates are pending',
        });
        settings.bind('show-zero', showZeroRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(showZeroRow);

        // --- Reboot required group ---
        const rebootGroup = new Adw.PreferencesGroup({
            title: 'Reboot Required',
            description: 'A separate check for whether the system needs a reboot to finish applying updates (e.g. after a kernel update) - shown as its own icon in the panel.',
        });
        page.add(rebootGroup);

        const rebootEnabledRow = new Adw.SwitchRow({
            title: 'Check for pending reboot',
            subtitle: 'Uses `dnf needs-restarting -r` by default (Fedora/RHEL)',
        });
        settings.bind('check-reboot-required', rebootEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        rebootGroup.add(rebootEnabledRow);

        const rebootCommandRow = new Adw.EntryRow({title: 'Reboot check command'});
        settings.bind('reboot-check-command', rebootCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        rebootGroup.add(rebootCommandRow);

        const rebootHintRow = new Adw.ActionRow({
            title: 'On Ubuntu/Debian, use instead:',
            subtitle: 'test -f /var/run/reboot-required && echo "Reboot required"',
        });
        rebootGroup.add(rebootHintRow);

        // --- Security updates group ---
        const securityGroup = new Adw.PreferencesGroup({
            title: 'Security Updates',
            description: 'Separately flags how many pending updates are security-related, without double-counting them into the main total - they\'re already included there. Requires network, so it\'s skipped while offline, same as the main sources.',
        });
        page.add(securityGroup);

        const securityEnabledRow = new Adw.SwitchRow({
            title: 'Flag security updates separately',
            subtitle: 'Uses `dnf check-update --security` by default (Fedora/RHEL)',
        });
        settings.bind('check-security-updates', securityEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        securityGroup.add(securityEnabledRow);

        const securityCommandRow = new Adw.EntryRow({title: 'Security check command'});
        settings.bind('security-check-command', securityCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        securityGroup.add(securityCommandRow);

        // --- Update script group ---
        const scriptGroup = new Adw.PreferencesGroup({
            title: 'Update Script',
            description: 'Optional: a script to run (in a terminal, so password prompts work) from the panel menu\'s "Run Update Script" item.',
        });
        page.add(scriptGroup);

        const scriptRow = new Adw.EntryRow({title: 'Script path'});
        scriptRow.set_text(settings.get_string('update-script-path'));
        scriptRow.connect('notify::text', () => {
            settings.set_string('update-script-path', scriptRow.get_text());
        });
        scriptGroup.add(scriptRow);

        const browseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse...',
        });
        browseButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: 'Select update script',
                action: Gtk.FileChooserAction.OPEN,
                transient_for: window,
                modal: true,
            });
            chooser.connect('response', (dlg, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = dlg.get_file();
                    if (file) {
                        const path = file.get_path();
                        scriptRow.set_text(path);
                    }
                }
                chooser.destroy();
            });
            chooser.show();
        });
        scriptRow.add_suffix(browseButton);

        const terminalRow = new Adw.EntryRow({title: 'Terminal command'});
        settings.bind('terminal-command', terminalRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        scriptGroup.add(terminalRow);

        // --- Per-source update behavior ---
        const backgroundGroup = new Adw.PreferencesGroup({
            title: 'Per-Source Updates',
            description: 'How clicking a source (e.g. "Flatpak: 3") in the panel menu runs its update command. Only applies to per-source updates below, not "Run Update Script" above.',
        });
        page.add(backgroundGroup);

        const backgroundRow = new Adw.SwitchRow({
            title: 'Run in background instead of a terminal',
            subtitle: 'Uses a graphical password prompt (pkexec) for any doas/sudo command, no terminal window',
        });
        settings.bind('background-updates', backgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        backgroundGroup.add(backgroundRow);

        // --- Sources group ---
        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Update Sources',
            description: 'Each row runs a check command; the number of non-empty lines it prints on stdout becomes that source\'s update count. The optional "update" field is a command to run (in a terminal) when you click that source in the panel menu - leave it blank to just show the count. Use "Add Source" below instead of editing text by hand.',
        });
        page.add(sourcesGroup);

        const rowsBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10});
        const sourceRows = [];

        const saveSources = () => {
            const checkValues = [];
            const updateValues = [];
            for (const r of sourceRows) {
                const name = r.nameEntry.get_text().trim();
                const command = r.cmdEntry.get_text().trim();
                const updateCommand = r.updateCmdEntry.get_text().trim();
                if (!name || !command)
                    continue;
                checkValues.push(`${name}|${command}`);
                if (updateCommand)
                    updateValues.push(`${name}|${updateCommand}`);
            }
            settings.set_strv('sources', checkValues);
            settings.set_strv('source-update-commands', updateValues);
        };

        const addSourceRow = (name = '', command = '', updateCommand = '') => {
            const wrapper = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 3,
                css_classes: ['card'],
                margin_top: 2, margin_bottom: 2,
            });

            const topRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 6,
                margin_top: 6, margin_start: 8, margin_end: 8,
            });
            const nameEntry = new Gtk.Entry({
                placeholder_text: 'Name',
                text: name,
                width_chars: 12,
                hexpand: false,
            });
            const cmdEntry = new Gtk.Entry({
                placeholder_text: 'Check command',
                text: command,
                hexpand: true,
            });
            const removeButton = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                tooltip_text: 'Remove this source',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            topRow.append(nameEntry);
            topRow.append(cmdEntry);
            topRow.append(removeButton);

            const bottomRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 6,
                margin_bottom: 6, margin_start: 8, margin_end: 8,
            });
            const updateLabel = new Gtk.Label({
                label: 'Update:', width_chars: 12, xalign: 0, css_classes: ['dim-label'],
            });
            const updateCmdEntry = new Gtk.Entry({
                placeholder_text: 'Optional - command to run when clicked in the panel menu',
                text: updateCommand,
                hexpand: true,
            });
            bottomRow.append(updateLabel);
            bottomRow.append(updateCmdEntry);

            wrapper.append(topRow);
            wrapper.append(bottomRow);
            rowsBox.append(wrapper);

            const entry = {row: wrapper, nameEntry, cmdEntry, updateCmdEntry};
            sourceRows.push(entry);

            for (const w of [nameEntry, cmdEntry, updateCmdEntry]) {
                w.connect('activate', saveSources);
                w.connect('notify::has-focus', widget => { if (!widget.has_focus) saveSources(); });
            }

            removeButton.connect('clicked', () => {
                rowsBox.remove(wrapper);
                const idx = sourceRows.indexOf(entry);
                if (idx !== -1)
                    sourceRows.splice(idx, 1);
                saveSources();
            });

            return entry;
        };

        const existingUpdateCommands = new Map();
        for (const entry of settings.get_strv('source-update-commands')) {
            const idx = entry.indexOf('|');
            if (idx === -1)
                continue;
            existingUpdateCommands.set(entry.slice(0, idx).trim(), entry.slice(idx + 1).trim());
        }
        for (const entry of settings.get_strv('sources')) {
            const idx = entry.indexOf('|');
            if (idx === -1)
                continue;
            const name = entry.slice(0, idx).trim();
            const command = entry.slice(idx + 1).trim();
            addSourceRow(name, command, existingUpdateCommands.get(name) ?? '');
        }

        const scroller = new Gtk.ScrolledWindow({
            min_content_height: Math.min(320, Math.max(90, sourceRows.length * 78 + 12)),
            hexpand: true,
        });
        scroller.set_child(rowsBox);

        const frame = new Gtk.Frame();
        frame.set_child(scroller);

        // --- "Add Source" popover: pick a known tool, or add a custom one ---
        const addButton = new Gtk.Button({
            label: '+ Add Source',
            halign: Gtk.Align.START,
        });

        const buildPopoverContent = () => {
            const existingNames = new Set(sourceRows.map(r => r.nameEntry.get_text().trim()));

            const listBox = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
                hexpand: true,
            });

            for (const preset of PRESET_SOURCES) {
                const already = existingNames.has(preset.name);
                const row = new Adw.ActionRow({
                    title: preset.name,
                    subtitle: preset.blurb,
                    subtitle_lines: 2,
                    activatable: !already,
                    sensitive: !already,
                    hexpand: true,
                });
                row.add_suffix(new Gtk.Image({
                    icon_name: already ? 'object-select-symbolic' : 'list-add-symbolic',
                }));
                if (!already) {
                    row.connect('activated', () => {
                        addSourceRow(preset.name, preset.command, preset.updateCommand ?? '');
                        saveSources();
                        popover.popdown();
                    });
                }
                listBox.append(row);
            }

            const customRow = new Adw.ActionRow({
                title: 'Custom command…',
                subtitle: 'Add a blank row and write your own name and command',
                activatable: true,
                hexpand: true,
            });
            customRow.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
            customRow.connect('activated', () => {
                const entry = addSourceRow('', '');
                popover.popdown();
                entry.nameEntry.grab_focus();
            });
            listBox.append(customRow);

            const scrolled = new Gtk.ScrolledWindow({
                child: listBox,
                vexpand: false,
                hexpand: true,
                max_content_height: 400,
                propagate_natural_height: true,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
            });

            const wrapper = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
            });
            // Force a fixed, sane width - ScrolledWindow content-size hints
            // alone don't make the child (and its wrapped labels) expand to fill it.
            wrapper.set_size_request(360, -1);
            wrapper.append(scrolled);

            return wrapper;
        };

        const popover = new Gtk.Popover();
        popover.connect('show', () => {
            popover.set_child(buildPopoverContent());
        });
        popover.set_parent(addButton);
        addButton.connect('clicked', () => popover.popup());

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        box.append(frame);
        box.append(addButton);

        sourcesGroup.add(box);
    }
}
