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
        command: 'dnf check-update -q --refresh',
        blurb: 'Fedora/RHEL system packages. --refresh forces a real metadata check every run.',
    },
    {
        name: 'Flatpak',
        command: 'flatpak remote-ls --updates',
        blurb: 'Checks your default remote (usually flathub). Add one source per extra remote if needed.',
    },
    {
        name: 'Cargo',
        command: "cargo install-update -l -a 2>/dev/null | awk '$NF==\"Yes\"'",
        blurb: 'Rust binaries installed via `cargo install`, using the cargo-update crate.',
    },
    {
        name: 'npm (global)',
        command: 'npm outdated -g --parseable 2>/dev/null',
        blurb: 'Global npm packages. --parseable prints one line per outdated package, no header.',
    },
    {
        name: 'pipx',
        command: "pipx list --outdated 2>/dev/null | grep -c '^package '",
        blurb: 'Python CLI tools installed via pipx.',
    },
    {
        name: 'uv tools',
        command: "uv tool list --outdated 2>/dev/null | grep -c '\\[latest:'",
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

        // --- Sources group ---
        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Update Sources',
            description: 'Each row runs a shell command; the number of non-empty lines it prints on stdout becomes that source\'s update count. Use "Add Source" below instead of editing text by hand. See the README for ready-made commands (cargo, npm, pipx, uv...).',
        });
        page.add(sourcesGroup);

        const rowsBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        const sourceRows = [];

        const saveSources = () => {
            const values = sourceRows
                .map(r => ({name: r.nameEntry.get_text().trim(), command: r.cmdEntry.get_text().trim()}))
                .filter(r => r.name && r.command)
                .map(r => `${r.name}|${r.command}`);
            settings.set_strv('sources', values);
        };

        const addSourceRow = (name = '', command = '') => {
            const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});

            const nameEntry = new Gtk.Entry({
                placeholder_text: 'Name',
                text: name,
                width_chars: 12,
                hexpand: false,
            });
            const cmdEntry = new Gtk.Entry({
                placeholder_text: 'Shell command',
                text: command,
                hexpand: true,
            });
            const removeButton = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                tooltip_text: 'Remove this source',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });

            row.append(nameEntry);
            row.append(cmdEntry);
            row.append(removeButton);
            rowsBox.append(row);

            const entry = {row, nameEntry, cmdEntry};
            sourceRows.push(entry);

            nameEntry.connect('activate', saveSources);
            cmdEntry.connect('activate', saveSources);
            nameEntry.connect('notify::has-focus', w => { if (!w.has_focus) saveSources(); });
            cmdEntry.connect('notify::has-focus', w => { if (!w.has_focus) saveSources(); });

            removeButton.connect('clicked', () => {
                rowsBox.remove(row);
                const idx = sourceRows.indexOf(entry);
                if (idx !== -1)
                    sourceRows.splice(idx, 1);
                saveSources();
            });

            return entry;
        };

        for (const entry of settings.get_strv('sources')) {
            const idx = entry.indexOf('|');
            if (idx === -1)
                continue;
            addSourceRow(entry.slice(0, idx).trim(), entry.slice(idx + 1).trim());
        }

        const scroller = new Gtk.ScrolledWindow({
            min_content_height: Math.min(220, Math.max(60, sourceRows.length * 44 + 12)),
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
                        addSourceRow(preset.name, preset.command);
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
