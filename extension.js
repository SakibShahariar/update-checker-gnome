import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Run `sh -c command`, return trimmed stdout as a string.
// Never rejects on non-zero exit (many tools, e.g. `dnf check-update`,
// exit non-zero simply because updates ARE available).
function runShell(command) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, null, (proc_, res) => {
                try {
                    const [, stdout] = proc_.communicate_utf8_finish(res);
                    resolve(stdout ?? '');
                } catch (e) {
                    resolve('');
                }
            });
        } catch (e) {
            resolve('');
        }
    });
}

function countLines(output) {
    return output.split('\n').filter(line => line.trim().length > 0).length;
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

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'Update Checker');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        this._lastTotal = -1;
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
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

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
        this._resultsSection.removeAll();

        let total = 0;
        const results = [];

        // Run all sources concurrently.
        await Promise.all(sources.map(async (src) => {
            const output = await runShell(src.command);
            const count = countLines(output);
            results.push({name: src.name, count});
        }));

        // Keep a stable, configured order.
        for (const src of sources) {
            const r = results.find(x => x.name === src.name);
            const count = r ? r.count : 0;
            total += count;
            const item = new PopupMenu.PopupMenuItem(`${src.name}`, {reactive: false});
            const countLabel = new St.Label({text: `${count}`, style_class: 'update-checker-count'});
            item.add_child(countLabel);
            this._resultsSection.addMenuItem(item);
        }

        const showZero = this._settings.get_boolean('show-zero');
        if (total > 0 || showZero)
            this._label.set_text(`${total}`);
        else
            this._label.set_text('');

        this._icon.icon_name = total > 0
            ? 'software-update-urgent-symbolic'
            : 'software-update-available-symbolic';

        const now = GLib.DateTime.new_now_local().format('%H:%M');
        this._statusItem.label.set_text(`Last checked ${now} - ${total} update${total === 1 ? '' : 's'}`);

        if (this._settings.get_boolean('notify-on-new') &&
            this._lastTotal !== -1 && total > this._lastTotal) {
            Main.notify(
                'Updates available',
                `${total} update${total === 1 ? '' : 's'} pending (was ${this._lastTotal}).`
            );
        }
        this._lastTotal = total;
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
