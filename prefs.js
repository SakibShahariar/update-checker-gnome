import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PRESET_SOURCES = [
    {
        name: 'DNF',
        command: "dnf check-update -q --refresh --color=never | grep -E '^\\S+\\.\\S+\\s'",
        updateCommand: 'doas dnf update --refresh -y && doas dnf autoremove -y',
        blurb: 'Fedora/RHEL packages.',
    },
    {
        name: 'Flatpak',
        command: 'flatpak remote-ls --updates',
        updateCommand: 'flatpak update -y && flatpak uninstall --unused -y',
        blurb: 'Flathub (add one per remote if needed).',
    },
    {
        name: 'Cargo',
        command: "cargo install-update -l -a | awk '$NF==\"Yes\"'",
        updateCommand: 'cargo install-update -a',
        blurb: 'Requires cargo-update crate.',
    },
    {
        name: 'npm (global)',
        command: 'npm outdated -g --parseable',
        updateCommand: 'doas npm update -g',
        blurb: 'Global npm packages.',
    },
    {
        name: 'uv tools',
        command: "uv tool list --outdated | grep '\\[latest:'",
        updateCommand: 'uv tool upgrade --all',
        blurb: 'Requires network.',
    },
];

export default class UpdateCheckerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Page 1: General
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const generalGroup = new Adw.PreferencesGroup({title: 'Updates', description: 'How often to check and notify.'});
        generalPage.add(generalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Check interval',
            subtitle: 'Minutes between checks',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 1440, step_increment: 5}),
        });
        intervalRow.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 18}));
        settings.bind('check-interval-minutes', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on new updates',
            subtitle: 'When count increases',
        });
        notifyRow.add_prefix(new Gtk.Image({icon_name: 'preferences-system-notifications-symbolic', pixel_size: 18}));
        settings.bind('notify-on-new', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(notifyRow);

        const showZeroRow = new Adw.SwitchRow({
            title: 'Always show icon',
            subtitle: 'Even when 0 updates',
        });
        showZeroRow.add_prefix(new Gtk.Image({icon_name: 'view-visible-symbolic', pixel_size: 18}));
        settings.bind('show-zero', showZeroRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(showZeroRow);

        const quietGroup = new Adw.PreferencesGroup({title: 'Quiet Hours', description: 'Silence popups, keep icon live.'});
        generalPage.add(quietGroup);

        const quietEnabledRow = new Adw.SwitchRow({
            title: 'Suppress notifications',
            subtitle: 'Only popups - icon still updates',
        });
        quietEnabledRow.add_prefix(new Gtk.Image({icon_name: 'weather-clear-night-symbolic', pixel_size: 18}));
        settings.bind('quiet-hours-enabled', quietEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quietGroup.add(quietEnabledRow);

        const quietStartRow = new Adw.SpinRow({
            title: 'Start',
            subtitle: 'Hour (0-23), e.g. 23',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 23, step_increment: 1}),
        });
        quietStartRow.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 16}));
        settings.bind('quiet-hours-start', quietStartRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        quietGroup.add(quietStartRow);

        const quietEndRow = new Adw.SpinRow({
            title: 'End',
            subtitle: 'Hour (0-23), same as start = 24h',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 23, step_increment: 1}),
        });
        quietEndRow.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 16}));
        settings.bind('quiet-hours-end', quietEndRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        quietGroup.add(quietEndRow);

        const watchGroup = new Adw.PreferencesGroup({title: 'Instant Refresh', description: 'Watch system package DBs for changes.'});
        generalPage.add(watchGroup);

        const watchRow = new Adw.SwitchRow({
            title: 'Watch package databases',
            subtitle: 'Re-check after any update (needs reload)',
        });
        watchRow.add_prefix(new Gtk.Image({icon_name: 'view-refresh-symbolic', pixel_size: 18}));
        settings.bind('watch-package-db', watchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(watchRow);

        // Page 2: Sources — beautiful cards
        const sourcesPage = new Adw.PreferencesPage({
            title: 'Sources',
            icon_name: 'system-software-install-symbolic',
        });
        window.add(sourcesPage);

        const bgGroup = new Adw.PreferencesGroup({
            title: 'Update Action',
            description: 'What happens when you click a source with updates.',
        });
        sourcesPage.add(bgGroup);

        const backgroundRow = new Adw.SwitchRow({
            title: 'Run in background',
            subtitle: 'Use graphical password, no terminal window',
        });
        backgroundRow.add_prefix(new Gtk.Image({icon_name: 'system-run-symbolic', pixel_size: 18}));
        settings.bind('background-updates', backgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        bgGroup.add(backgroundRow);

        const SOURCE_ICONS = {
            'DNF': 'system-software-install-symbolic',
            'Flatpak': 'application-x-flatpak-symbolic',
            'Cargo': 'application-x-cargo-symbolic',
            'npm (global)': 'application-x-npm-symbolic',
            'uv tools': 'application-x-python-symbolic',
        };
        const getSourceIcon = (name) => SOURCE_ICONS[name] || 'package-x-generic-symbolic';

        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Update Sources',
            description: 'Each check prints one line per update. Update command runs when you click the source.',
        });
        sourcesPage.add(sourcesGroup);

        const rowsBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        const sourceRows = [];
        const emptyBanner = new Adw.Banner({
            title: 'No valid sources - add one below.',
            revealed: false,
        });
        const emptyStatus = new Adw.StatusPage({
            icon_name: 'system-software-install-symbolic',
            title: 'No sources yet',
            description: 'Add DNF, Flatpak or a custom command to start checking.',
            visible: false,
            vexpand: false,
        });
        const updateBannerVisibility = () => {
            const valid = sourceRows.some(r => {
                const n = r.nameEntry.get_text().trim();
                const c = r.cmdEntry.get_text().trim();
                return n && c;
            });
            emptyBanner.set_revealed(!valid);
            emptyStatus.set_visible(sourceRows.length === 0);
            rowsBox.set_visible(sourceRows.length > 0);
        };

        const saveSources = () => {
            const checkValues = [];
            const updateValues = [];
            const seen = new Set();
            let hasDuplicate = false;
            for (const r of sourceRows) {
                const name = r.nameEntry.get_text().trim();
                const command = r.cmdEntry.get_text().trim();
                const updateCommand = r.updateCmdEntry.get_text().trim();
                r.nameEntry.remove_css_class('error');
                if (!name || !command)
                    continue;
                if (seen.has(name)) {
                    r.nameEntry.add_css_class('error');
                    r.nameEntry.set_tooltip_text(`Duplicate "${name}"`);
                    hasDuplicate = true;
                    continue;
                }
                seen.add(name);
                checkValues.push(`${name}|${command}`);
                if (updateCommand)
                    updateValues.push(`${name}|${updateCommand}`);
            }
            if (hasDuplicate) {
                updateBannerVisibility();
                return;
            }
            settings.set_strv('sources', checkValues);
            settings.set_strv('source-update-commands', updateValues);
            updateBannerVisibility();
        };

        const addSourceRow = (name = '', command = '', updateCommand = '') => {
            const wrapper = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 0,
                css_classes: ['card'],
                margin_top: 4, margin_bottom: 4,
            });

            const iconName = getSourceIcon(name);
            const topRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 10,
                margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 4,
            });
            const icon = new Gtk.Image({
                icon_name: iconName,
                pixel_size: 22,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            });
            const nameEntry = new Gtk.Entry({
                placeholder_text: 'Name  •  e.g. DNF',
                text: name,
                width_chars: 11,
                hexpand: false,
                css_classes: ['heading'],
            });
            nameEntry.set_tooltip_text('Source name - must be unique');
            const cmdEntry = new Gtk.Entry({
                placeholder_text: 'Check  •  e.g. flatpak remote-ls --updates',
                text: command,
                hexpand: true,
                css_classes: ['monospace'],
            });
            cmdEntry.set_tooltip_text('Prints one line per pending update');
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove this source',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            topRow.append(icon);
            topRow.append(nameEntry);
            topRow.append(cmdEntry);
            topRow.append(removeButton);

            // live icon update when name changes
            const updateIcon = () => icon.set_from_icon_name(getSourceIcon(nameEntry.get_text().trim()));
            nameEntry.connect('changed', updateIcon);

            const separator = new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL, css_classes: ['spacer']});

            const bottomRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
                margin_top: 10, margin_start: 12, margin_end: 12, margin_bottom: 12,
            });
            const updateIconImg = new Gtk.Image({
                icon_name: 'system-run-symbolic',
                pixel_size: 14,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
                tooltip_text: 'Runs when you click the source',
            });
            const updateCmdEntry = new Gtk.Entry({
                placeholder_text: 'On click →  e.g. flatpak update -y',
                text: updateCommand,
                hexpand: true,
                css_classes: ['monospace'],
            });
            updateCmdEntry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, 'media-playback-start-symbolic');
            updateCmdEntry.set_icon_tooltip_text(Gtk.EntryIconPosition.SECONDARY, 'Runs on click');
            updateCmdEntry.set_tooltip_text('Optional: command to run when you click this source');
            // dim when empty, normal when filled
            const syncUpdateStyle = () => {
                if (updateCmdEntry.get_text().trim())
                    updateCmdEntry.remove_css_class('dim-label');
                else
                    updateCmdEntry.add_css_class('dim-label');
            };
            updateCmdEntry.connect('changed', syncUpdateStyle);
            syncUpdateStyle();
            bottomRow.append(updateIconImg);
            bottomRow.append(updateCmdEntry);

            wrapper.append(topRow);
            wrapper.append(separator);
            wrapper.append(bottomRow);
            rowsBox.append(wrapper);

            const entry = {row: wrapper, nameEntry, cmdEntry, updateCmdEntry};
            sourceRows.push(entry);

            for (const w of [nameEntry, cmdEntry, updateCmdEntry]) {
                w.connect('activate', saveSources);
                w.connect('notify::has-focus', widget => { if (!widget.has_focus) saveSources(); });
                w.connect('changed', updateBannerVisibility);
            }

            removeButton.connect('clicked', () => {
                rowsBox.remove(wrapper);
                const idx = sourceRows.indexOf(entry);
                if (idx !== -1)
                    sourceRows.splice(idx, 1);
                saveSources();
                updateBannerVisibility();
            });

            updateBannerVisibility();
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
            min_content_height: Math.min(340, Math.max(120, sourceRows.length * 92 + 16)),
            hexpand: true,
            css_classes: ['card'],
        });
        scroller.set_child(rowsBox);
        // subtle rounded clipping for cards inside
        rowsBox.set_margin_top(6);
        rowsBox.set_margin_bottom(6);
        rowsBox.set_margin_start(6);
        rowsBox.set_margin_end(6);

        const addButton = new Gtk.Button({
            label: 'Add Source',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill', 'suggested-action'],
        });
        addButton.set_icon_name('list-add-symbolic');

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
                subtitle: 'Blank row',
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

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        box.append(emptyBanner);
        box.append(emptyStatus);
        box.append(scroller);
        box.append(addButton);
        updateBannerVisibility();

        sourcesGroup.add(box);

        // Page 3: Advanced
        const advancedPage = new Adw.PreferencesPage({
            title: 'Advanced',
            icon_name: 'applications-system-symbolic',
        });
        window.add(advancedPage);

        const rebootGroup = new Adw.PreferencesGroup({title: 'Reboot Required', description: 'Separate icon when reboot is needed.'});
        advancedPage.add(rebootGroup);

        const rebootEnabledRow = new Adw.SwitchRow({
            title: 'Check for reboot',
            subtitle: 'After kernel update',
        });
        rebootEnabledRow.add_prefix(new Gtk.Image({icon_name: 'system-reboot-symbolic', pixel_size: 18}));
        settings.bind('check-reboot-required', rebootEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        rebootGroup.add(rebootEnabledRow);

        const rebootCommandRow = new Adw.EntryRow({title: 'Command'});
        rebootCommandRow.add_prefix(new Gtk.Image({icon_name: 'utilities-terminal-symbolic', pixel_size: 16}));
        settings.bind('reboot-check-command', rebootCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        rebootGroup.add(rebootCommandRow);

        const rebootHintRow = new Adw.ActionRow({
            title: 'Ubuntu/Debian',
            subtitle: 'test -f /var/run/reboot-required && echo "Reboot required"',
        });
        rebootHintRow.add_prefix(new Gtk.Image({icon_name: 'help-about-symbolic', pixel_size: 16}));
        rebootGroup.add(rebootHintRow);

        const securityGroup = new Adw.PreferencesGroup({title: 'Security Updates', description: 'Subset of main count, shown separately.'});
        advancedPage.add(securityGroup);

        const securityEnabledRow = new Adw.SwitchRow({
            title: 'Flag security separately',
            subtitle: 'Highlight security updates',
        });
        securityEnabledRow.add_prefix(new Gtk.Image({icon_name: 'security-high-symbolic', pixel_size: 18}));
        settings.bind('check-security-updates', securityEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        securityGroup.add(securityEnabledRow);

        const securityCommandRow = new Adw.EntryRow({title: 'Command'});
        securityCommandRow.add_prefix(new Gtk.Image({icon_name: 'utilities-terminal-symbolic', pixel_size: 16}));
        settings.bind('security-check-command', securityCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        securityGroup.add(securityCommandRow);

        const scriptGroup = new Adw.PreferencesGroup({title: 'Update Script', description: 'Optional script via Run Update Script menu.'});
        advancedPage.add(scriptGroup);

        const scriptRow = new Adw.EntryRow({title: 'Script path'});
        scriptRow.add_prefix(new Gtk.Image({icon_name: 'text-x-script-symbolic', pixel_size: 16}));
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
                title: 'Select script',
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

        const terminalRow = new Adw.EntryRow({title: 'Terminal'});
        terminalRow.add_prefix(new Gtk.Image({icon_name: 'utilities-terminal-symbolic', pixel_size: 16}));
        settings.bind('terminal-command', terminalRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        scriptGroup.add(terminalRow);
    }
}
