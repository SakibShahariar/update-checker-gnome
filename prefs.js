import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

import {runShell, classifyResult, validateSourceBackup} from './lib/utils.js';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function isHighImpactCommand(command) {
    const text = command.trim();
    if (!text)
        return false;

    return /\b(?:sudo|doas|pkexec)\b/i.test(text) ||
        /(?:>>?|2>|&>)\s*\//.test(text) ||
        /(?:^|\s)tee(?:\s+-[a-zA-Z]+)*\s+\//.test(text) ||
        /\b(?:rm|mkfs(?:\.[\w-]+)?|dd)\b/i.test(text);
}

const PRESET_SOURCES = [
    {
        name: 'DNF',
        command: "dnf check-update -q --refresh --color=never | grep -E '^\\S+\\.\\S+\\s'",
        updateCommand: 'doas dnf update --refresh -y && doas dnf autoremove -y',
        interval: 60,
        blurb: 'Fedora/RHEL packages · every 60 min',
    },
    {
        name: 'Flatpak',
        command: 'flatpak remote-ls --updates',
        updateCommand: 'flatpak update -y && flatpak uninstall --unused -y',
        interval: 120,
        blurb: 'Flathub · every 120 min',
    },
    {
        name: 'Firmware (fwupd)',
        command: "fwupdmgr get-updates --json | jq -r '.Devices[]? | select((.Releases // []) | length > 0) | [.Name, (.Releases[0].Version // \"\")] | @tsv'",
        updateCommand: 'doas fwupdmgr update',
        interval: 360,
        blurb: 'Requires fwupd and jq · every 6h',
    },
    {
        name: 'Cargo',
        command: "cargo install-update -l -a | awk '$NF==\"Yes\"'",
        updateCommand: 'cargo install-update -a',
        interval: 1440,
        blurb: 'Requires cargo-update · daily',
    },
    {
        name: 'npm (global)',
        command: 'npm outdated -g --parseable',
        updateCommand: 'doas npm update -g',
        interval: 360,
        blurb: 'Global npm packages · every 6h',
    },
    {
        name: 'uv tools',
        command: "uv tool list --outdated | grep '\\[latest:'",
        updateCommand: 'uv tool upgrade --all',
        interval: 360,
        blurb: 'uv tools · every 6h',
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

        const compactRows = new Adw.SwitchRow({
            title: 'Compact source rows',
            subtitle: 'Focus on counts; hide secondary freshness and progress labels',
        });
        compactRows.add_prefix(new Gtk.Image({icon_name: 'view-compact-symbolic', pixel_size: 18}));
        settings.bind('compact-source-rows', compactRows, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(compactRows);

        const ignoredPackagesRow = new Adw.ActionRow({
            title: 'Ignored packages / apps',
            subtitle: 'Comma-separated exact identifiers. Ignored updates are excluded from counts; this can hide security fixes.',
        });
        const ignoredPackagesEntry = new Gtk.Entry({
            text: settings.get_strv('ignored-packages').join(', '),
            placeholder_text: 'e.g. package-name, org.example.App',
            width_chars: 28,
            valign: Gtk.Align.CENTER,
        });
        ignoredPackagesEntry.set_tooltip_text('Exact first-column identifiers to ignore. Leave empty to count everything.');
        const saveIgnoredPackages = () => {
            const names = [...new Set(ignoredPackagesEntry.get_text()
                .split(',')
                .map(name => name.trim())
                .filter(Boolean))];
            settings.set_strv('ignored-packages', names);
        };
        ignoredPackagesEntry.connect('activate', saveIgnoredPackages);
        ignoredPackagesEntry.connect('notify::has-focus', widget => {
            if (!widget.has_focus)
                saveIgnoredPackages();
        });
        ignoredPackagesRow.add_suffix(ignoredPackagesEntry);
        generalGroup.add(ignoredPackagesRow);

        const batteryRow = new Adw.SwitchRow({
            title: 'Pause background checks on battery',
            subtitle: 'Manual Check now still runs',
        });
        batteryRow.add_prefix(new Gtk.Image({icon_name: 'battery-good-symbolic', pixel_size: 18}));
        settings.bind('skip-on-battery', batteryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(batteryRow);

        const meteredRow = new Adw.SwitchRow({
            title: 'Pause background checks on metered networks',
            subtitle: 'Uses NetworkManager metered-state detection; manual Check now still runs',
        });
        meteredRow.add_prefix(new Gtk.Image({icon_name: 'network-cellular-signal-excellent-symbolic', pixel_size: 18}));
        settings.bind('skip-on-metered', meteredRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(meteredRow);

        const permGroup = new Adw.PreferencesGroup({
            title: 'DNF metadata access',
            description: 'If DNF checks fail with Permission denied on libdnf5, fix directory readability.',
        });
        generalPage.add(permGroup);

        const dnfPath = '/usr/lib/sysimage/libdnf5';
        let permSubtitle = 'Path not present (OK on non-DNF systems)';
        let needsFix = false;
        try {
            const file = Gio.File.new_for_path(dnfPath);
            if (file.query_exists(null)) {
                try {
                    file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null).close(null);
                    permSubtitle = 'Readable — no action needed';
                } catch (e) {
                    needsFix = true;
                    permSubtitle = 'Not readable by your user — DNF checks may fail';
                }
            }
        } catch (e) {
            permSubtitle = 'Could not probe path';
        }

        const permRow = new Adw.ActionRow({
            title: dnfPath,
            subtitle: permSubtitle,
        });
        permRow.add_prefix(new Gtk.Image({
            icon_name: needsFix ? 'dialog-warning-symbolic' : 'emblem-ok-symbolic',
            pixel_size: 18,
        }));
        if (needsFix) {
            const copyBtn = new Gtk.Button({
                label: 'Copy fix command',
                valign: Gtk.Align.CENTER,
            });
            const fixCmd = `doas chmod -R a+rX ${dnfPath}`;
            copyBtn.connect('clicked', () => {
                try {
                    const display = Gdk.Display.get_default();
                    display.get_clipboard().set(fixCmd);
                } catch (e) {}
            });
            permRow.add_suffix(copyBtn);
        }
        permGroup.add(permRow);

        const quietGroup = new Adw.PreferencesGroup({title: 'Quiet Hours', description: 'Uses your local clock in whole-hour increments. The start hour is included and the end hour is excluded; equal values mean all day. Notifications are silenced, but the icon and update checks stay active.'});
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

        const diagnosticsGroup = new Adw.PreferencesGroup({
            title: 'Diagnostics',
            description: 'Copy a redacted report for bug reports. Source commands and raw command output are never included.',
        });
        generalPage.add(diagnosticsGroup);
        const diagnosticsRow = new Adw.ActionRow({
            title: 'Troubleshooting report',
            subtitle: 'Includes source status, intervals, and enabled policies; excludes commands and raw output.',
        });
        const copyDiagnosticsButton = new Gtk.Button({
            label: 'Copy diagnostics',
            icon_name: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
        });
        copyDiagnosticsButton.connect('clicked', () => {
            let summary = {};
            try {
                summary = JSON.parse(settings.get_string('summary-json') || '{}');
            } catch (e) {}
            const globalInterval = settings.get_int('check-interval-minutes');
            const intervalMap = new Map();
            for (const entry of settings.get_strv('source-intervals')) {
                const split = entry.indexOf('|');
                if (split < 1) continue;
                const value = entry.slice(split + 1).trim();
                if (/^\d+$/.test(value) && Number(value) >= 5)
                    intervalMap.set(entry.slice(0, split).trim(), Number(value));
            }
            const sourceRows = settings.get_strv('sources').map(entry => {
                const split = entry.indexOf('|');
                if (split < 1) return null;
                return {name: entry.slice(0, split).trim()};
            }).filter(Boolean);
            const report = [
                'Update Checker diagnostics',
                `Extension version: ${this.metadata.version ?? 'unknown'}`,
                `GNOME Shell version: ${GLib.getenv('GNOME_SHELL_VERSION') || 'unknown'}`,
                `Last check: ${summary.lastCheck || 'not available'}`,
                `Total updates: ${Number.isFinite(summary.total) && summary.total >= 0 ? summary.total : 'unknown'}`,
                `Security updates: ${summary.securityCount ?? 'unknown'}`,
                `Offline: ${summary.offline === true ? 'yes' : summary.offline === false ? 'no' : 'unknown'}`,
                `On battery: ${summary.onBattery === true ? 'yes' : summary.onBattery === false ? 'no' : 'unknown'}`,
                `Network metered: ${summary.networkMetered === true ? 'yes' : summary.networkMetered === false ? 'no' : 'unknown'}`,
                `Quiet hours active: ${summary.quietHoursActive === true ? 'yes' : summary.quietHoursActive === false ? 'no' : 'unknown'}`,
                `Check busy: ${summary.busy === true ? 'yes' : 'no'}`,
                `Any check failed: ${summary.failed === true ? 'yes' : 'no'}`,
                `Reboot required: ${summary.rebootRequired === true ? 'yes' : 'no'}`,
                `Global check interval: ${globalInterval} minutes`,
                `Pause on battery policy: ${settings.get_boolean('skip-on-battery') ? 'enabled' : 'disabled'}`,
                `Pause on metered network policy: ${settings.get_boolean('skip-on-metered') ? 'enabled' : 'disabled'}`,
                `Quiet hours: ${settings.get_boolean('quiet-hours-enabled') ? 'enabled' : 'disabled'} (${settings.get_int('quiet-hours-start')}:00–${settings.get_int('quiet-hours-end')}:00)`,
                `Security check enabled: ${settings.get_boolean('check-security-updates') ? 'yes' : 'no'}`,
                `Reboot check enabled: ${settings.get_boolean('check-reboot-required') ? 'yes' : 'no'}`,
                '',
                'Sources (commands and raw output intentionally omitted):',
            ];
            for (const source of sourceRows) {
                const detail = (summary.sources || []).find(item => item.name === source.name) || {};
                const interval = intervalMap.get(source.name) ?? globalInterval;
                const lastChecked = detail.lastChecked || 'unknown';
                const cached = detail.cached ? ', cached' : '';
                report.push(`- ${source.name}: every ${interval} min; status ${detail.status || 'not checked'}; updates ${detail.count ?? 'unknown'}; last checked ${lastChecked}${cached}`);
                if (detail.status === 'error' && detail.error)
                    report.push(`  Error summary: ${String(detail.error).slice(0, 160)}`);
            }
            try {
                Gdk.Display.get_default().get_clipboard().set(report.join('\n'));
                diagnosticsRow.set_subtitle('Diagnostics copied. Review the report before sharing it.');
            } catch (e) {
                diagnosticsRow.set_subtitle('Could not access the clipboard. Please try again.');
            }
        });
        diagnosticsRow.add_suffix(copyDiagnosticsButton);
        diagnosticsGroup.add(diagnosticsRow);

        const historyGroup = new Adw.PreferencesGroup({
            title: 'Recent Update History',
            description: 'Optional successful daily totals stored locally for up to 7 days. Commands and raw output are never stored.',
        });
        generalPage.add(historyGroup);
        const recordHistoryRow = new Adw.SwitchRow({
            title: 'Record local history',
            subtitle: 'Keep successful daily totals on this device for up to 7 days',
        });
        settings.bind('record-history', recordHistoryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        recordHistoryRow.connect('notify::active', () => {
            if (!recordHistoryRow.get_active())
                settings.set_string('history-json', '[]');
        });
        historyGroup.add(recordHistoryRow);

        
        let historyEntries = [];
        try {
            historyEntries = JSON.parse(settings.get_string('history-json') || '[]');
        } catch (e) {}
        if (!Array.isArray(historyEntries))
            historyEntries = [];
        historyEntries = historyEntries
            .filter(entry => entry && typeof entry.date === 'string' &&
                Number.isSafeInteger(entry.total) && entry.total >= 0)
            .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
            .slice(0, 7);
        if (historyEntries.length === 0) {
            historyGroup.add(new Adw.ActionRow({
                title: 'No recent successful checks',
                subtitle: 'History appears after a fresh check completes successfully.',
            }));
        } else {
            for (const entry of historyEntries) {
                const perSource = Array.isArray(entry.sources)
                    ? entry.sources.filter(source => source && typeof source.name === 'string' &&
                        Number.isSafeInteger(source.count) && source.count >= 0)
                    : [];
                const sourceSummary = perSource.length
                    ? perSource.map(source => `${source.name}: ${source.count}`).join(' · ')
                    : 'Per-source totals unavailable';
                historyGroup.add(new Adw.ActionRow({
                    title: `${entry.date} · ${entry.total} update${entry.total === 1 ? '' : 's'}`,
                    subtitle: `${entry.securityCount ?? 0} security · ${sourceSummary}`,
                }));
            }
        }

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
            subtitle: 'Use graphical password, no terminal window. ' +
                "Don't mix doas/sudo and non-privileged commands in one line -- " +
                'the whole line runs elevated.',
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
            description: 'Checks run as your user via /bin/sh -c. Background updates may run elevated through pkexec; only add commands you trust. The default DNF update command uses doas; switch it to sudo if doas is unavailable. Each check prints one line per update. Names must be unique and cannot contain |.',
        });
        sourcesPage.add(sourcesGroup);

        const commandWarningBanner = new Adw.Banner({
            title: 'Review elevated, system-path, or destructive commands before using them.',
            button_label: 'Dismiss',
            revealed: false,
        });
        commandWarningBanner.connect('button-clicked', () => commandWarningBanner.set_revealed(false));

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
            const intervalValues = [];
            const seen = new Set();
            let hasDuplicate = false;
            let hasInvalidName = false;
            for (const r of sourceRows) {
                const name = r.nameEntry.get_text().trim();
                const command = r.cmdEntry.get_text().trim();
                const updateCommand = r.updateCmdEntry.get_text().trim();
                const interval = Math.round(r.intervalSpin.get_value());
                r.nameEntry.remove_css_class('error');
                if (!name || !command)
                    continue;
                if (name.includes('|')) {
                    r.nameEntry.add_css_class('error');
                    r.nameEntry.set_tooltip_text('Source names cannot contain |');
                    hasInvalidName = true;
                    continue;
                }
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
                intervalValues.push(`${name}|${interval}`);
            }
            if (hasDuplicate || hasInvalidName) {
                updateBannerVisibility();
                return;
            }

            // Warn only when a command is being changed/saved, not every time
            // Preferences opens with an existing elevated preset. The warning
            // is advisory: saving is never blocked.
            const savedChecks = new Map(settings.get_strv('sources').map(entry => {
                const idx = entry.indexOf('|');
                return idx === -1 ? null : [entry.slice(0, idx).trim(), entry.slice(idx + 1).trim()];
            }).filter(Boolean));
            const savedUpdates = new Map(settings.get_strv('source-update-commands').map(entry => {
                const idx = entry.indexOf('|');
                return idx === -1 ? null : [entry.slice(0, idx).trim(), entry.slice(idx + 1).trim()];
            }).filter(Boolean));
            for (const r of sourceRows) {
                const name = r.nameEntry.get_text().trim();
                const command = r.cmdEntry.get_text().trim();
                const updateCommand = r.updateCmdEntry.get_text().trim();
                if (!name || !command)
                    continue;
                const checkChanged = command !== (savedChecks.get(name) ?? '');
                const updateChanged = updateCommand !== (savedUpdates.get(name) ?? '');
                if ((checkChanged && isHighImpactCommand(command)) ||
                    (updateChanged && isHighImpactCommand(updateCommand))) {
                    commandWarningBanner.set_revealed(true);
                }
            }

            settings.set_strv('disabled-sources', sourceRows
                .filter(r => !r.enabledCheck.get_active())
                .map(r => r.nameEntry.get_text().trim())
                .filter(Boolean));
            settings.set_strv('sources', checkValues);
            settings.set_strv('source-update-commands', updateValues);
            settings.set_strv('source-intervals', intervalValues);
            updateBannerVisibility();
        };

        const updateSourceOrderControls = () => {
            sourceRows.forEach((entry, index) => {
                const name = entry.nameEntry.get_text().trim() || 'new source';
                entry.moveUpButton.set_sensitive(index > 0);
                entry.moveDownButton.set_sensitive(index < sourceRows.length - 1);
                entry.moveUpButton.set_accessible_name(`Move ${name} up`);
                entry.moveDownButton.set_accessible_name(`Move ${name} down`);
            });
        };

        const moveSource = (entry, direction) => {
            const oldIndex = sourceRows.indexOf(entry);
            const newIndex = oldIndex + direction;
            if (oldIndex < 0 || newIndex < 0 || newIndex >= sourceRows.length)
                return;
            const sibling = direction < 0
                ? (newIndex === 0 ? null : sourceRows[newIndex - 1].row)
                : sourceRows[newIndex].row;
            rowsBox.reorder_child_after(entry.row, sibling);
            sourceRows.splice(oldIndex, 1);
            sourceRows.splice(newIndex, 0, entry);
            saveSources();
            updateSourceOrderControls();
        };

        const addSourceRow = (name = '', command = '', updateCommand = '', interval = null, enabled = null) => {
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
                accessible_name: 'Remove source: ' + (name || 'new source'),
                tooltip_text: 'Remove this source',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            topRow.append(icon);
            const enabledCheck = new Gtk.CheckButton({
                active: enabled ?? !settings.get_strv('disabled-sources').includes(name),
                tooltip_text: 'Include this source in automatic and manual checks',
                valign: Gtk.Align.CENTER,
            });
            enabledCheck.set_accessible_name('Enable source: ' + (name || 'new source'));
            enabledCheck.connect('toggled', () => saveSources());
            topRow.append(enabledCheck);
            topRow.append(nameEntry);
            topRow.append(cmdEntry);
            topRow.append(removeButton);

            // live icon update when name changes
            const updateIcon = () => icon.set_from_icon_name(getSourceIcon(nameEntry.get_text().trim()));
            nameEntry.connect('changed', () => {
                updateIcon();
                const currentName = nameEntry.get_text().trim() || 'new source';
                enabledCheck.set_accessible_name('Enable source: ' + currentName);
                removeButton.set_accessible_name('Remove source: ' + currentName);
                updateSourceOrderControls();
            });

            const separator = new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL, css_classes: ['spacer']});

            const bottomRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
                margin_top: 10, margin_start: 12, margin_end: 12, margin_bottom: 6,
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

            const testRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_start: 12, margin_end: 12, margin_bottom: 12,
            });
            const testButton = new Gtk.Button({
                label: 'Test command',
                icon_name: 'system-run-symbolic',
                tooltip_text: 'Execute this check command once and preview its parsed result',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            const testResultLabel = new Gtk.Label({
                label: 'Not tested',
                xalign: 0,
                hexpand: true,
                wrap: true,
                selectable: true,
                css_classes: ['dim-label', 'caption'],
            });
            testRow.append(testButton);
            testRow.append(testResultLabel);
            testButton.connect('clicked', () => {
                const candidate = cmdEntry.get_text().trim();
                if (!candidate) {
                    testResultLabel.set_text('Enter a check command before testing.');
                    return;
                }
                const risky = isHighImpactCommand(candidate);
                const dialog = new Adw.MessageDialog({
                    transient_for: window,
                    modal: true,
                    heading: risky ? 'Run this potentially risky command?' : 'Execute this check command?',
                    body: risky
                        ? 'This command appears privileged, destructive, or writes to a system path. Testing executes it now as your user, with any privileges explicitly included in the command. Review it carefully before continuing.'
                        : 'This will execute the current check command once through /bin/sh. Commands can change your system; only test commands you trust. The command is not saved by this action.',
                });
                dialog.add_response('cancel', 'Cancel');
                dialog.add_response('run', risky ? 'Run potentially risky command' : 'Run test');
                dialog.set_default_response('cancel');
                dialog.set_close_response('cancel');
                if (risky)
                    dialog.set_response_appearance('run', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.connect('response', async (dialog_, response) => {
                    dialog_.close();
                    if (response !== 'run')
                        return;
                    testButton.set_sensitive(false);
                    testResultLabel.set_text('Testing command…');
                    try {
                        const result = await runShell(candidate);
                        const parsed = classifyResult(result);
                        const stdoutLines = result.stdout.trim()
                            ? result.stdout.trim().split('\n').length : 0;
                        const state = result.timedOut ? 'Timed out'
                            : result.spawnFailed ? 'Could not start command'
                                : parsed.status === 'ok' ? 'Succeeded' : 'Failed';
                        const lines = [
                            `${state} · ${parsed.count} update${parsed.count === 1 ? '' : 's'} parsed`,
                            `Exit status: ${result.exitStatus}`,
                            `Stdout lines: ${stdoutLines}`,
                        ];
                        if (result.stderr.trim())
                            lines.push('stderr: ' + result.stderr.trim().split('\n')[0]);
                        if (parsed.status === 'error')
                            lines.push('Reason: ' + parsed.message);
                        else
                            lines.push('Output accepted as one line per update.');
                        if (wrapper.get_root())
                            testResultLabel.set_text(lines.join('\n'));
                    } catch (error) {
                        if (wrapper.get_root())
                            testResultLabel.set_text('Test failed: ' + String(error));
                    } finally {
                        if (wrapper.get_root())
                            testButton.set_sensitive(true);
                    }
                });
                dialog.present();
            });

            const intervalRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
                margin_start: 12, margin_end: 12, margin_bottom: 12,
            });
            const moveUpButton = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: 'Move this source earlier in the check order',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            const moveDownButton = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: 'Move this source later in the check order',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            const intervalLabel = new Gtk.Label({
                label: 'Every',
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            });
            const intervalSpin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: 5, upper: 1440, step_increment: 5,
                    value: interval ?? settings.get_int('check-interval-minutes'),
                }),
                numeric: true,
                width_chars: 5,
                valign: Gtk.Align.CENTER,
            });
            intervalSpin.set_tooltip_text('Minutes for this source (overrides global)');
            const intervalSuffix = new Gtk.Label({
                label: 'min',
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            });
            intervalRow.append(moveUpButton);
            intervalRow.append(moveDownButton);
            intervalRow.append(intervalLabel);
            intervalRow.append(intervalSpin);
            intervalRow.append(intervalSuffix);

            wrapper.append(topRow);
            wrapper.append(separator);
            wrapper.append(bottomRow);
            wrapper.append(intervalRow);
            wrapper.append(testRow);
            rowsBox.append(wrapper);

            const entry = {row: wrapper, nameEntry, cmdEntry, updateCmdEntry, intervalSpin, testButton, testResultLabel, enabledCheck, moveUpButton, moveDownButton};
            sourceRows.push(entry);
            moveUpButton.connect('clicked', () => moveSource(entry, -1));
            moveDownButton.connect('clicked', () => moveSource(entry, 1));
            updateSourceOrderControls();

            intervalSpin.connect('value-changed', saveSources);
            for (const w of [nameEntry, cmdEntry, updateCmdEntry]) {
                w.connect('activate', saveSources);
                w.connect('notify::has-focus', widget => {
                    // Moving from the candidate command to Test must not save it.
                    if (!widget.has_focus && widget !== cmdEntry) saveSources();
                });
                w.connect('changed', updateBannerVisibility);
            }

            removeButton.connect('clicked', () => {
                rowsBox.remove(wrapper);
                const idx = sourceRows.indexOf(entry);
                if (idx !== -1)
                    sourceRows.splice(idx, 1);
                updateSourceOrderControls();
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
        const existingIntervals = new Map();
        for (const entry of settings.get_strv('source-intervals')) {
            const idx = entry.indexOf('|');
            if (idx === -1)
                continue;
            const n = entry.slice(0, idx).trim();
            const rawValue = entry.slice(idx + 1).trim();
            if (!/^\d+$/.test(rawValue))
                continue;
            const v = Number(rawValue);
            if (n && Number.isSafeInteger(v) && v >= 5) existingIntervals.set(n, v);
        }
        for (const entry of settings.get_strv('sources')) {
            const idx = entry.indexOf('|');
            if (idx === -1)
                continue;
            const name = entry.slice(0, idx).trim();
            const command = entry.slice(idx + 1).trim();
            addSourceRow(name, command, existingUpdateCommands.get(name) ?? '', existingIntervals.get(name) ?? null);
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

        const detectSourcesButton = new Gtk.Button({
            label: 'Detect Installed Sources',
            icon_name: 'system-search-symbolic',
            tooltip_text: 'Suggest source presets only when their required tools are installed. Existing sources are not replaced.',
            halign: Gtk.Align.CENTER,
        });
        detectSourcesButton.connect('clicked', () => {
            const requirements = new Map([
                ['DNF', ['dnf']],
                ['Flatpak', ['flatpak']],
                ['Firmware (fwupd)', ['fwupdmgr', 'jq']],
                ['Cargo', ['cargo', 'cargo-install-update']],
                ['npm (global)', ['npm']],
                ['uv tools', ['uv']],
            ]);
            const existing = new Set(sourceRows
                .map(r => r.nameEntry.get_text().trim().toLowerCase())
                .filter(Boolean));
            const detected = PRESET_SOURCES.filter(preset => {
                if (existing.has(preset.name.toLowerCase()))
                    return false;
                const tools = requirements.get(preset.name) ?? [];
                return tools.length > 0 && tools.every(tool => !!GLib.find_program_in_path(tool));
            });
            if (detected.length === 0) {
                sourceTransferStatus.set_text('No missing presets detected. Install a supported tool or use Add Source for a custom command.');
                return;
            }
            const names = detected.map(preset => preset.name).join(', ');
            const confirm = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading: 'Add detected source presets?',
                body: `Detected installed tools for: ${names}. This adds only missing presets; it will not replace or modify your existing sources. Review every command after adding it.`,
            });
            confirm.add_response('cancel', 'Cancel');
            confirm.add_response('add', 'Add Sources');
            confirm.set_default_response('cancel');
            confirm.set_close_response('cancel');
            confirm.connect('response', (dialog, response) => {
                dialog.close();
                if (response !== 'add')
                    return;
                for (const preset of detected)
                    addSourceRow(preset.name, preset.command, preset.updateCommand, preset.interval, true);
                saveSources();
                sourceTransferStatus.set_text(`Added ${detected.length} detected preset(s): ${names}.`);
            });
            confirm.present();
        });

        const sourceTransferRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            margin_bottom: 8,
        });
        const exportSourcesButton = new Gtk.Button({
            label: 'Export Sources',
            icon_name: 'document-save-symbolic',
            tooltip_text: 'Export source commands, per-source intervals, and enabled states to a JSON file.',
        });
        const importSourcesButton = new Gtk.Button({
            label: 'Import Sources',
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Validate a JSON source backup before replacing the current source list.',
        });
        sourceTransferRow.append(exportSourcesButton);
        sourceTransferRow.append(importSourcesButton);

        const sourceTransferStatus = new Gtk.Label({
            label: 'Back up or restore source commands and per-source settings.',
            wrap: true,
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
        });
        sourceTransferStatus.set_max_width_chars(72);

        exportSourcesButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: 'Export Update Checker Sources',
                action: Gtk.FileChooserAction.SAVE,
                transient_for: window,
                modal: true,
                accept_label: 'Export',
                cancel_label: 'Cancel',
            });
            chooser.set_current_name('update-checker-sources.json');
            chooser.connect('response', (dlg, response) => {
                if (response !== Gtk.ResponseType.ACCEPT) {
                    dlg.destroy();
                    return;
                }
                try {
                    const path = dlg.get_file()?.get_path();
                    if (!path)
                        throw new Error('Choose a local file path.');
                    const payload = {
                        format: 'update-checker-sources',
                        version: 1,
                        exportedAt: new Date().toISOString(),
                        sources: sourceRows.map(r => ({
                            name: r.nameEntry.get_text().trim(),
                            command: r.cmdEntry.get_text().trim(),
                            updateCommand: r.updateCmdEntry.get_text().trim(),
                            intervalMinutes: Math.round(r.intervalSpin.get_value()),
                            enabled: r.enabledCheck.get_active(),
                        })).filter(s => s.name && s.command),
                    };
                    GLib.file_set_contents(path, JSON.stringify(payload, null, 2) + '\n');
                    sourceTransferStatus.set_text(`Exported ${payload.sources.length} source(s).`);
                } catch (error) {
                    sourceTransferStatus.set_text('Export failed: ' + String(error.message ?? error));
                } finally {
                    dlg.destroy();
                }
            });
            chooser.show();
        });

        importSourcesButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: 'Import Update Checker Sources',
                action: Gtk.FileChooserAction.OPEN,
                transient_for: window,
                modal: true,
                accept_label: 'Validate',
                cancel_label: 'Cancel',
            });
            chooser.connect('response', (dlg, response) => {
                if (response !== Gtk.ResponseType.ACCEPT) {
                    dlg.destroy();
                    return;
                }
                let imported;
                try {
                    const path = dlg.get_file()?.get_path();
                    if (!path)
                        throw new Error('Choose a local JSON file.');
                    const [ok, bytes] = GLib.file_get_contents(path);
                    if (!ok)
                        throw new Error('Could not read the selected file.');
                    const payload = JSON.parse(new TextDecoder().decode(bytes));
                    imported = validateSourceBackup(payload, settings.get_int('check-interval-minutes'));
                } catch (error) {
                    sourceTransferStatus.set_text('Import rejected: ' + String(error.message ?? error));
                    dlg.destroy();
                    return;
                }
                dlg.destroy();
                const confirm = new Adw.MessageDialog({
                    transient_for: window,
                    modal: true,
                    heading: 'Replace configured sources?',
                    body: `The validated backup contains ${imported.length} source(s). Import replaces the current source list, commands, intervals, and enabled states. Exported commands may contain sensitive paths or arguments; keep the backup private.`,
                });
                confirm.add_response('cancel', 'Cancel');
                confirm.add_response('replace', 'Replace Sources');
                confirm.set_default_response('cancel');
                confirm.set_close_response('cancel');
                confirm.set_response_appearance('replace', Adw.ResponseAppearance.DESTRUCTIVE);
                confirm.connect('response', (dialog, response) => {
                    dialog.close();
                    if (response !== 'replace')
                        return;
                    for (const entry of [...sourceRows])
                        rowsBox.remove(entry.row);
                    sourceRows.splice(0, sourceRows.length);
                    for (const source of imported)
                        addSourceRow(source.name, source.command, source.updateCommand, source.interval, source.enabled);
                    saveSources();
                    sourceTransferStatus.set_text(`Imported ${imported.length} source(s).`);
                });
                confirm.present();
            });
            chooser.show();
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
                    activatable: !already,
                    sensitive: !already,
                    hexpand: true,
                });
                row.add_suffix(new Gtk.Image({
                    icon_name: already ? 'object-select-symbolic' : 'list-add-symbolic',
                }));
                if (!already) {
                    row.connect('activated', () => {
                        addSourceRow(preset.name, preset.command, preset.updateCommand ?? '', preset.interval ?? null);
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
        box.append(commandWarningBanner);
        box.append(emptyBanner);
        box.append(emptyStatus);
        box.append(scroller);
        box.append(addButton);
        box.append(detectSourcesButton);
        box.append(sourceTransferRow);
        box.append(sourceTransferStatus);
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

        const advisoryCommandRow = new Adw.EntryRow({title: 'Advisory metadata command'});
        advisoryCommandRow.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic', pixel_size: 16}));
        advisoryCommandRow.set_tooltip_text('Optional command that prints security advisory IDs or severity metadata; only matching output is shown.');
        settings.bind('security-advisory-command', advisoryCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        securityGroup.add(advisoryCommandRow);

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
            accessible_name: 'Browse for update script',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse for update script',
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
