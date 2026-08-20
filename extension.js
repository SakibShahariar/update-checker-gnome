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
        this._lastAnyFailed = false;
        this._lastRebootRequired = false;
        this._lastSecurityCount = 0;
        this._lastNotifiedTotal = -1;
        this._lastNotifiedReboot = false;
        this._lastCheckTimeStr = null;
        this._lastOffline = false;
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
        this._securityIcon = new St.Icon({
            icon_name: 'security-high-symbolic',
            style_class: 'system-status-icon update-checker-security-icon',
            visible: false,
        });
        this._rebootIcon = new St.Icon({
            icon_name: 'system-shutdown-symbolic',
            style_class: 'system-status-icon update-checker-reboot-icon',
            visible: false,
        });
        this._offlineIcon = new St.Icon({
            icon_name: 'network-offline-symbolic',
            style_class: 'system-status-icon update-checker-offline-icon',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        box.add_child(this._securityIcon);
        box.add_child(this._rebootIcon);
        box.add_child(this._offlineIcon);
        this.add_child(box);

        this._offlineItem = new PopupMenu.PopupMenuItem('Offline', {reactive: false});
        this._offlineItem.visible = false;
        this.menu.addMenuItem(this._offlineItem);

        this._securityItem = new PopupMenu.PopupMenuItem('Security updates', {reactive: false});
        this._securityItem.visible = false;
        this.menu.addMenuItem(this._securityItem);

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

    // Recomputes panel visibility from the last-known check results and
    // the current show-zero setting. Called after every check, AND
    // whenever show-zero itself changes, so toggling it in Preferences
    // takes effect immediately instead of waiting for the next check.
    _updateVisibility() {
        const showZero = this._settings.get_boolean('show-zero');
        this.visible = this._lastTotal > 0 || showZero ||
            this._lastAnyFailed || this._lastRebootRequired || this._lastOffline;
    }

    // Whether background notifications ("updates available", "reboot
    // required") should be suppressed right now. Only applies to those
    // two passive/periodic notifications - anything the person directly
    // triggered (clicking a source's update, etc.) still notifies
    // regardless, since they're actively at the computer asking for it.
    _inQuietHours() {
        if (!this._settings.get_boolean('quiet-hours-enabled'))
            return false;
        const start = this._settings.get_int('quiet-hours-start');
        const end = this._settings.get_int('quiet-hours-end');
        if (start === end)
            return false;
        const hour = GLib.DateTime.new_now_local().get_hour();
        return start < end
            ? (hour >= start && hour < end)
            : (hour >= start || hour < end); // wraps past midnight
    }

    _renderEmpty() {
        this._label.set_text('');
        this._statusItem.label.set_text('Not checked yet');
        this._rebootIcon.visible = false;
        this._rebootItem.visible = false;
        this._securityIcon.visible = false;
        this._securityItem.visible = false;
        this._offlineIcon.visible = false;
        this._offlineItem.visible = false;
        // Stay hidden until the first check completes and actually finds
        // something, unless the user wants the icon visible regardless.
        this._updateVisibility();
    }

    _runInTerminal(command) {
        const term = this._settings.get_string('terminal-command');
        try {
            GLib.spawn_command_line_async(`${term} sh -c ${GLib.shell_quote(command)}`);
        } catch (e) {
            Main.notifyError('Update Checker', `Could not launch terminal: ${e.message}`);
        }
    }

    // Run a source's update command without a terminal. If it contains
    // doas/sudo, those are stripped and the whole command is re-run
    // through pkexec instead, which shows its own graphical password
    // prompt - covers multi-command lines like "doas a && doas b" too,
    // since running doas a second time *inside* an already-root pkexec
    // shell would just fail.
    _runInBackground(command, label) {
        const hasPrivilege = /\b(?:doas|sudo)\s+/.test(command);
        const cleaned = command.replace(/\b(?:doas|sudo)\s+/g, '');
        const argv = hasPrivilege ? ['pkexec', 'sh', '-c', cleaned] : ['sh', '-c', cleaned];

        Main.notify(`Updating ${label}...`, 'Running in background.');
        try {
            const proc = Gio.Subprocess.new(
                argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (proc_, res) => {
                let ok = false, stderr = '';
                try {
                    const [, , errOut] = proc_.communicate_utf8_finish(res);
                    stderr = errOut ?? '';
                    ok = proc_.get_exit_status() === 0;
                } catch (e) {
                    stderr = String(e);
                }
                if (ok) {
                    Main.notify(`${label} updated`, 'Finished successfully.');
                    this.checkNow();
                } else {
                    Main.notifyError(
                        `${label} update failed`, stderr.trim().split('\n')[0] || 'Unknown error');
                }
            });
        } catch (e) {
            Main.notifyError('Update Checker', `Could not run update: ${e.message}`);
        }
    }

    _runSourceUpdate(command, label) {
        if (this._settings.get_boolean('background-updates'))
            this._runInBackground(command, label);
        else
            this._runInTerminal(command);
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

    // Runs the reboot-required check on its own (local-only, works
    // offline). Updates the reboot icon/menu item/notification, and
    // returns whether the check itself failed (as opposed to "not
    // needed") - state otherwise lives on the instance so both the
    // normal and offline-shortcut paths in checkNow() can share this.
    async _checkReboot() {
        const checkRebootEnabled = this._settings.get_boolean('check-reboot-required');
        const rebootCommand = this._settings.get_string('reboot-check-command');

        let rebootRequired = false;
        let rebootCheckFailed = false;
        let rebootMessage = '';

        if (checkRebootEnabled && rebootCommand) {
            const raw = await runShell(rebootCommand);
            const r = classifyResult(raw);
            if (r.status === 'ok' && r.count > 0) {
                rebootRequired = true;
                rebootMessage = raw.stdout.trim().split('\n')[0];
            } else if (r.status === 'error') {
                // Visible instead of silent: a failed reboot-check
                // command is "unknown", not "not needed" - and the
                // person should be able to tell the difference.
                rebootCheckFailed = true;
                rebootMessage = r.message;
            }
        }

        this._lastRebootRequired = rebootRequired;
        this._rebootIcon.visible = rebootRequired;
        this._rebootItem.visible = rebootRequired || rebootCheckFailed;
        if (rebootRequired) {
            this._rebootItem.label.set_text(`⟳ ${rebootMessage || 'Reboot required'}`);
        } else if (rebootCheckFailed) {
            const reason = (rebootMessage || 'unknown error').slice(0, 60);
            this._rebootItem.label.set_text(`⚠ Reboot check failed: ${reason}`);
        }

        if (this._settings.get_boolean('notify-on-new') && !this._inQuietHours() &&
            rebootRequired && !this._lastNotifiedReboot) {
            Main.notify('Reboot required', rebootMessage || 'A reboot is needed to finish applying updates.');
        }
        this._lastNotifiedReboot = rebootRequired;
        this._updateVisibility();

        return rebootCheckFailed;
    }

    // Runs the security-update check. Network-dependent (like the main
    // sources), so this is only ever called from checkNow()'s online
    // path - never while offline. The count is informational only and
    // deliberately NOT added to the main total, since security updates
    // are already included in it (this is a subset, not an addition).
    async _checkSecurity() {
        const enabled = this._settings.get_boolean('check-security-updates');
        const command = this._settings.get_string('security-check-command');

        let count = 0;
        let failed = false;
        let message = '';

        if (enabled && command) {
            const raw = await runShell(command);
            const r = classifyResult(raw);
            if (r.status === 'ok') {
                count = r.count;
            } else {
                failed = true;
                message = r.message;
            }
        }

        this._lastSecurityCount = count;
        this._securityIcon.visible = count > 0;
        this._securityItem.visible = count > 0 || failed;
        if (count > 0) {
            this._securityItem.label.set_text(
                `🛡 ${count} security update${count === 1 ? '' : 's'} pending`);
        } else if (failed) {
            const reason = (message || 'unknown error').slice(0, 60);
            this._securityItem.label.set_text(`⚠ Security check failed: ${reason}`);
        }

        return failed;
    }

    async checkNow() {
        if (this._checking)
            return;
        this._checking = true;

        const isOnline = Gio.NetworkMonitor.get_default().get_network_available();
        this._lastOffline = !isOnline;
        this._offlineIcon.visible = !isOnline;

        if (!isOnline) {
            // Skip network-dependent source checks entirely rather than
            // let them fail one by one - no point spawning commands we
            // already know can't succeed, and it avoids a wall of
            // per-source warning icons that aren't a real problem, just
            // a disconnected network. Leave the last-known counts and
            // per-source breakdown exactly as they were; they're not
            // wrong, just possibly stale. The reboot check is local-only
            // so it still runs and stays fully live even offline.
            this._offlineItem.visible = true;
            await this._checkReboot();
            const when = this._lastCheckTimeStr ?? 'last check';
            let countPart = this._lastTotal >= 0 ? ` (${this._lastTotal} update${this._lastTotal === 1 ? '' : 's'}` : '';
            if (this._lastTotal >= 0 && this._lastSecurityCount > 0)
                countPart += `, ${this._lastSecurityCount} security`;
            if (countPart)
                countPart += ')';
            this._statusItem.label.set_text(`Offline - showing results from ${when}${countPart}`);
            this._checking = false;
            return;
        }

        this._offlineItem.visible = false;
        this._statusItem.label.set_text('Checking...');

        const sources = parseSources(this._settings.get_strv('sources'));
        const updateCommands = parseUpdateCommands(this._settings.get_strv('source-update-commands'));
        this._resultsSection.removeAll();

        let total = 0;
        const failed = [];
        const results = [];

        // Run all sources, the reboot check, and the security check
        // concurrently.
        const [, rebootCheckFailed, securityCheckFailed] = await Promise.all([
            Promise.all(sources.map(async (src) => {
                const raw = await runShell(src.command);
                results.push({name: src.name, ...classifyResult(raw)});
            })),
            this._checkReboot(),
            this._checkSecurity(),
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
                const reason = (r.message || 'unknown error').slice(0, 50);
                item.label.set_text(`${src.name} - failed: ${reason}`);
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
                    item.connect('activate', () => this._runSourceUpdate(updateCommand, src.name));
                }
            }
            this._resultsSection.addMenuItem(item);
        }

        const anyFailed = failed.length > 0;
        this._lastTotal = total;
        this._lastAnyFailed = anyFailed;
        this._updateVisibility();
        this._label.set_text(total > 0 ? `${total}` : (anyFailed ? '!' : ''));

        if (total > 0)
            this._icon.icon_name = 'software-update-urgent-symbolic';
        else if (anyFailed)
            this._icon.icon_name = 'dialog-warning-symbolic';
        else
            this._icon.icon_name = 'software-update-available-symbolic';

        const now = GLib.DateTime.new_now_local().format('%H:%M');
        this._lastCheckTimeStr = now;
        let statusText = `Last checked ${now} - ${total} update${total === 1 ? '' : 's'}`;
        if (this._lastSecurityCount > 0)
            statusText += ` (${this._lastSecurityCount} security)`;
        if (anyFailed)
            statusText += ` (${failed.length} source${failed.length === 1 ? '' : 's'} failed)`;
        if (rebootCheckFailed)
            statusText += ' (reboot check failed)';
        if (securityCheckFailed)
            statusText += ' (security check failed)';
        this._statusItem.label.set_text(statusText);

        if (this._settings.get_boolean('notify-on-new') && !this._inQuietHours() &&
            this._lastNotifiedTotal !== -1 && total > this._lastNotifiedTotal) {
            Main.notify(
                'Updates available',
                `${total} update${total === 1 ? '' : 's'} pending.`
            );
        }
        this._lastNotifiedTotal = total;
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
        this._showZeroChangedId = this._settings.connect(
            'changed::show-zero', () => this._indicator._updateVisibility()
        );

        // When connectivity comes back after being offline, refresh
        // automatically - but not instantly. The interface can report
        // "available" a moment before DNS/routing actually work (right
        // after reconnecting), so checking immediately can produce a
        // real but misleading "failed to download metadata" error. Wait
        // a few seconds for things to settle first, and if it flaps
        // offline again before that timer fires, cancel rather than
        // check on a connection that's already gone again.
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkDebounceId = null;
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed', (monitor, available) => {
                if (this._networkDebounceId) {
                    GLib.source_remove(this._networkDebounceId);
                    this._networkDebounceId = null;
                }
                if (!available)
                    return;
                this._networkDebounceId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, 5, () => {
                        this._networkDebounceId = null;
                        if (this._networkMonitor.get_network_available())
                            this._indicator.checkNow();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            }
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
        if (this._showZeroChangedId) {
            this._settings.disconnect(this._showZeroChangedId);
            this._showZeroChangedId = null;
        }
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = null;
        }
        if (this._networkDebounceId) {
            GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = null;
        }
        this._networkMonitor = null;
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}
