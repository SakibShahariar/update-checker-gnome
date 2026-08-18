import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Run `sh -c command`, resolving with stdout, stderr, and the exit
// status. We never reject on non-zero exit - many tools (e.g. `dnf
// check-update`) exit non-zero simply because updates ARE available -
// so the caller decides what a given exit code/output combo means.
function runShell(command) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc_, res) => {
                try {
                    const [, stdout, stderr] = proc_.communicate_utf8_finish(res);
                    resolve({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitStatus: proc_.get_exit_status(),
                        spawnFailed: false,
                    });
                } catch (e) {
                    resolve({stdout: '', stderr: String(e), exitStatus: -1, spawnFailed: true});
                }
            });
        } catch (e) {
            resolve({stdout: '', stderr: String(e), exitStatus: -1, spawnFailed: true});
        }
    });
}

function countLines(output) {
    return output.split('\n').filter(line => line.trim().length > 0).length;
}

// Classify a source's result. We deliberately don't treat "non-zero
// exit" alone as failure, since plenty of check-only commands (dnf,
// grep -c, etc.) use non-zero to mean "found something", not "broke".
// Only two things get flagged as a real error:
//  - the shell couldn't even run the command (missing binary: exit 127,
//    or the subprocess failed to spawn at all)
//  - the command produced no stdout AND wrote to stderr AND exited
//    non-zero - i.e. it looks like it broke, not like it found nothing
function classifyResult({stdout, stderr, exitStatus, spawnFailed}) {
    if (spawnFailed || exitStatus === 127) {
        const reason = stderr.trim().split('\n')[0] || 'command not found';
        return {status: 'error', count: 0, message: reason};
    }
    if (stdout.trim() === '' && stderr.trim() !== '' && exitStatus !== 0) {
        const reason = stderr.trim().split('\n')[0];
        return {status: 'error', count: 0, message: reason};
    }
    return {status: 'ok', count: countLines(stdout), message: ''};
}

function parseSources(strv) {
    const sources = [];
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1)
            continue;
        const name = entry.slice(0, idx).trim();
        const command = entry.slice(idx + 1).trim();
        if (name && command)
            sources.push({name, command});
    }
    return sources;
}

// "Name|command" entries, keyed by name, for the optional per-source
// update commands. Same simple format/parsing as parseSources.
function parseUpdateCommands(strv) {
    const map = new Map();
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1)
            continue;
        const name = entry.slice(0, idx).trim();
        const command = entry.slice(idx + 1).trim();
        if (name && command)
            map.set(name, command);
    }
    return map;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'Update Checker');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        this._lastTotal = -1;
        this._lastRebootRequired = false;
        this._checking = false;

        const box = new St.BoxLayout({style_class: 'update-checker-box'});
        this._icon = new St.Icon({
            icon_name: 'software-update-available-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '',
            y_align: 2 /* Clutter.ActorAlign.CENTER */,
            style_class: 'update-checker-label',
        });
        this._rebootIcon = new St.Icon({
            icon_name: 'system-shutdown-symbolic',
            style_class: 'system-status-icon update-checker-reboot-icon',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        box.add_child(this._rebootIcon);
        this.add_child(box);

        this._rebootItem = new PopupMenu.PopupMenuItem('Reboot required', {reactive: false});
        this._rebootItem.visible = false;
        this.menu.addMenuItem(this._rebootItem);

        this._resultsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._resultsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('Checking...', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        const checkNowItem = new PopupMenu.PopupMenuItem('Check Now');
        checkNowItem.connect('activate', () => this.checkNow());
        this.menu.addMenuItem(checkNowItem);

        this._runScriptItem = new PopupMenu.PopupMenuItem('Run Update Script');
        this._runScriptItem.connect('activate', () => this._runUpdateScript());
        this.menu.addMenuItem(this._runScriptItem);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._updateRunScriptVisibility();
        });

        this._renderEmpty();
    }

    _updateRunScriptVisibility() {
        const path = this._settings.get_string('update-script-path');
        this._runScriptItem.visible = !!path;
    }

    _renderEmpty() {
        this._label.set_text('');
        this._statusItem.label.set_text('Not checked yet');
        this._rebootIcon.visible = false;
        this._rebootItem.visible = false;
        // Stay hidden until the first check completes and actually finds
        // something, unless the user wants the icon visible regardless.
        this.visible = this._settings.get_boolean('show-zero');
    }

    _runInTerminal(command) {
        const term = this._settings.get_string('terminal-command');
        try {
            GLib.spawn_command_line_async(`${term} sh -c ${GLib.shell_quote(command)}`);
        } catch (e) {
            Main.notifyError('Update Checker', `Could not launch terminal: ${e.message}`);
        }
    }

    _runUpdateScript() {
        const path = this._settings.get_string('update-script-path');
        if (!path)
            return;
        const term = this._settings.get_string('terminal-command');
        try {
            GLib.spawn_command_line_async(`${term} ${GLib.shell_quote(path)}`);
        } catch (e) {
            Main.notifyError('Update Checker', `Could not launch terminal: ${e.message}`);
        }
    }

    async checkNow() {
        if (this._checking)
            return;
        this._checking = true;
        this._statusItem.label.set_text('Checking...');

        const sources = parseSources(this._settings.get_strv('sources'));
        const updateCommands = parseUpdateCommands(this._settings.get_strv('source-update-commands'));
        this._resultsSection.removeAll();

        let total = 0;
        const failed = [];
        const results = [];
        let rebootRequired = false;
        let rebootMessage = '';

        const checkRebootEnabled = this._settings.get_boolean('check-reboot-required');
        const rebootCommand = this._settings.get_string('reboot-check-command');

        // Run all sources, plus the reboot check, concurrently.
        await Promise.all([
            ...sources.map(async (src) => {
                const raw = await runShell(src.command);
                results.push({name: src.name, ...classifyResult(raw)});
            }),
            (async () => {
                if (!checkRebootEnabled || !rebootCommand)
                    return;
                const raw = await runShell(rebootCommand);
                const r = classifyResult(raw);
                if (r.status === 'ok' && r.count > 0) {
                    rebootRequired = true;
                    rebootMessage = raw.stdout.trim().split('\n')[0];
                }
                // A failed reboot-check command is treated as "unknown" -
                // we don't claim a reboot is needed on shaky evidence.
            })(),
        ]);

        // Keep a stable, configured order.
        for (const src of sources) {
            const r = results.find(x => x.name === src.name) ??
                {status: 'error', count: 0, message: 'no result'};

            const updateCommand = updateCommands.get(src.name);
            const canUpdate = r.status === 'ok' && r.count > 0 && !!updateCommand;
            const item = new PopupMenu.PopupMenuItem(
                `${src.name}`, {reactive: r.status === 'error' || canUpdate});

            if (r.status === 'error') {
                failed.push(src.name);
                const warnIcon = new St.Icon({
                    icon_name: 'dialog-warning-symbolic',
                    style_class: 'update-checker-warning-icon',
                    icon_size: 16,
                });
                item.add_child(warnIcon);
                item.label.set_text(`${src.name} - check failed`);
                item.connect('activate', () => {
                    Main.notifyError(`${src.name} check failed`, r.message || 'Unknown error');
                });
            } else {
                total += r.count;
                const countLabel = new St.Label({text: `${r.count}`, style_class: 'update-checker-count'});
                item.add_child(countLabel);
                if (canUpdate) {
                    const runIcon = new St.Icon({
                        icon_name: 'media-playback-start-symbolic',
                        style_class: 'update-checker-run-icon',
                        icon_size: 14,
                    });
                    item.add_child(runIcon);
                    item.connect('activate', () => this._runInTerminal(updateCommand));
                }
            }
            this._resultsSection.addMenuItem(item);
        }

        const showZero = this._settings.get_boolean('show-zero');
        const anyFailed = failed.length > 0;
        this.visible = total > 0 || showZero || anyFailed || rebootRequired;
        this._label.set_text(total > 0 ? `${total}` : (anyFailed ? '!' : ''));
        this._rebootIcon.visible = rebootRequired;

        if (total > 0)
            this._icon.icon_name = 'software-update-urgent-symbolic';
        else if (anyFailed)
            this._icon.icon_name = 'dialog-warning-symbolic';
        else
            this._icon.icon_name = 'software-update-available-symbolic';

        this._rebootItem.visible = rebootRequired;
        if (rebootRequired)
            this._rebootItem.label.set_text(`⟳ ${rebootMessage || 'Reboot required'}`);

        const now = GLib.DateTime.new_now_local().format('%H:%M');
        let statusText = `Last checked ${now} - ${total} update${total === 1 ? '' : 's'}`;
        if (anyFailed)
            statusText += ` (${failed.length} source${failed.length === 1 ? '' : 's'} failed)`;
        this._statusItem.label.set_text(statusText);

        if (this._settings.get_boolean('notify-on-new')) {
            if (this._lastTotal !== -1 && total > this._lastTotal) {
                Main.notify(
                    'Updates available',
                    `${total} update${total === 1 ? '' : 's'} pending (was ${this._lastTotal}).`
                );
            }
            if (rebootRequired && !this._lastRebootRequired) {
                Main.notify('Reboot required', rebootMessage || 'A reboot is needed to finish applying updates.');
            }
        }
        this._lastTotal = total;
        this._lastRebootRequired = rebootRequired;
        this._checking = false;
    }
});

export default class UpdateCheckerExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings = this.getSettings();
        this._timeoutId = null;

        this._scheduleTimer();
        this._settingsChangedId = this._settings.connect(
            'changed::check-interval-minutes', () => this._scheduleTimer()
        );

        // Kick off an initial check shortly after enabling, so the panel
        // isn't blank while the shell finishes starting up.
        this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._indicator.checkNow();
            this._startupId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const minutes = this._settings.get_int('check-interval-minutes');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                this._indicator.checkNow();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._startupId) {
            GLib.source_remove(this._startupId);
            this._startupId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}
