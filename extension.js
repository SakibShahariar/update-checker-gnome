import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
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
        const reason = stripAnsi(stderr).trim().split('\n')[0] || 'command not found';
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    if (stdout.trim() === '' && stderr.trim() !== '' && exitStatus !== 0) {
        const reason = stripAnsi(stderr).trim().split('\n')[0];
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    const lines = stripAnsi(stdout).split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return {status: 'ok', count: lines.length, message: '', lines};
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

// Some tools (dnf5 in particular) emit ANSI color escape codes even
// when their output is piped rather than going to a real terminal.
// St.Label has no concept of terminal colors, so those bytes would
// otherwise show up as literal garbage text. Strip them generically so
// this is fixed for every source, not just the ones we know about.
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return (str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// Truncates with an ellipsis, consistently, everywhere a message could
// otherwise be long enough to stretch the whole popup menu wide. Keep
// this short - it's the character budget for the WHOLE displayed
// string, not just this piece, so callers should account for any
// prefix (icon glyph, "source name - failed:", etc.) they add on top.
function truncate(str, max) {
    const s = (str || '').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseIntervals(strv) {
    const map = new Map();
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1) continue;
        const name = entry.slice(0, idx).trim();
        const val = parseInt(entry.slice(idx + 1).trim(), 10);
        if (name && Number.isFinite(val) && val >= 5) map.set(name, val);
    }
    return map;
}

function sparkline(values) {
    if (!values || values.length === 0) return '';
    const blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    return values.map(v => blocks[Math.round(((v - min) / range) * (blocks.length - 1))]).join('');
}

function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex, amount = 0x14) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    let r = Math.min(255, parseInt(h.slice(0, 2), 16) + amount);
    let g = Math.min(255, parseInt(h.slice(2, 4), 16) + amount);
    let b = Math.min(255, parseInt(h.slice(4, 6), 16) + amount);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function loadMatugenColors() {
    const fallback = {
        background: '#111318',
        error: '#ffb4ab',
        error_container: '#93000a',
        on_error_container: '#ffdad6',
        on_primary: '#06305f',
        on_primary_container: '#d5e3ff',
        on_secondary_container: '#d9e3f8',
        on_surface: '#e1e2e9',
        on_surface_variant: '#c4c6cf',
        on_tertiary_container: '#f8d8fe',
        outline: '#8e9099',
        outline_variant: '#43474e',
        primary: '#a8c8ff',
        primary_container: '#254777',
        secondary: '#bdc7dc',
        secondary_container: '#3e4758',
        surface: '#111318',
        surface_container: '#1d2024',
        surface_container_high: '#282a2f',
        tertiary: '#dbbce1',
        tertiary_container: '#563e5d',
    };
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return fallback;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return fallback;
        const text = new TextDecoder().decode(contents);
        const map = {};
        const re = /--([\w_]+)\s*:\s*([^;]+);/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            map[m[1]] = m[2].trim();
        }
        const get = (k) => map[k] || fallback[k];
        return {
            background: get('background'),
            error: get('error'),
            error_container: get('error_container'),
            on_error_container: get('on_error_container'),
            on_primary: get('on_primary'),
            on_primary_container: get('on_primary_container'),
            on_secondary_container: get('on_secondary_container'),
            on_surface: get('on_surface'),
            on_surface_variant: get('on_surface_variant'),
            on_tertiary_container: get('on_tertiary_container'),
            outline: get('outline'),
            outline_variant: get('outline_variant'),
            primary: get('primary'),
            primary_container: get('primary_container'),
            secondary: get('secondary'),
            secondary_container: get('secondary_container'),
            surface: get('surface'),
            surface_container: get('surface_container'),
            surface_container_high: get('surface_container_high'),
            tertiary: get('tertiary'),
            tertiary_container: get('tertiary_container'),
        };
    } catch (e) {
        return fallback;
    }
}

function buildMatugenCss(c) {
    // Mirrors stylesheet.css but with live Matugen hex values — more colors than -st-accent
    return `
.update-checker-header-card { background-color: ${c.primary_container}; border-color: ${c.outline_variant}; }
.update-checker-header-icon-box { background-color: ${c.primary}; }
.update-checker-header-icon { color: ${c.on_primary}; }
.update-checker-header-title { color: ${c.on_primary_container}; }
.update-checker-header-subtitle { color: ${hexToRgba(c.on_primary_container, 0.75)}; }
.update-checker-refresh-button { color: ${c.on_primary_container}; }
.update-checker-refresh-button:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.update-checker-refresh-button:active { background-color: ${hexToRgba(c.tertiary, 0.22)}; }
.update-checker-accent { background-color: ${c.primary}; }
.update-checker-section-title { color: ${c.on_surface}; }
.update-checker-section-icon { color: ${c.secondary}; }
.update-checker-badge { background-color: ${c.secondary_container}; border-color: ${c.outline_variant}; color: ${c.on_secondary_container}; }
.update-checker-update-button { background-color: ${c.tertiary_container}; border-color: ${hexToRgba(c.tertiary, 0.35)}; color: ${c.on_tertiary_container}; }
.update-checker-update-button:hover { background-color: ${lightenHex(c.tertiary_container, 0x14)}; }
.update-checker-update-button:active { background-color: ${lightenHex(c.tertiary_container, 0x22)}; }
.update-checker-container { background-color: ${c.surface_container}; border-color: ${c.outline_variant}; }
.update-checker-container-empty { color: ${c.on_surface_variant}; }
.update-checker-package-row:hover { background-color: ${c.surface_container_high}; }
.update-checker-package-name { color: ${c.on_surface}; }
.update-checker-package-version { color: ${c.secondary}; }
.update-checker-reboot-icon, .update-checker-security-icon, .update-checker-warning-icon, .update-checker-stop-icon { color: ${c.error}; }
.update-checker-offline-icon { color: ${c.secondary}; }
.update-checker-run-icon { color: ${c.primary}; }
.update-checker-updating-label { color: ${c.on_secondary_container}; }
.update-checker-package-line { color: ${c.on_surface_variant}; }
.update-checker-count { color: ${c.on_surface}; }
`;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'Update Checker');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        // Scoped width: only this extension's popup should be wide (DMS 480 -> 440).
        // Adding class to menu.box so stylesheet can target .update-checker-menu
        // instead of the global .popup-menu-content which affects every popup.
        this.menu.box.add_style_class_name('update-checker-menu');
        this._lastTotal = -1;
        this._lastAnyFailed = false;
        this._lastRebootRequired = false;
        this._lastSecurityCount = 0;
        this._lastNotifiedTotal = -1;
        this._lastNotifiedReboot = false;
        this._lastCheckTimeStr = null;
        this._lastOffline = false;
        this._expandedSources = new Set();
        // Name -> {proc, startTime, tickId}. A Map (not a Set) because
        // we need the live Gio.Subprocess handle to support stopping,
        // and the start time to show elapsed seconds while it runs.
        this._updatingSources = new Map();
        // Name -> {countLabel, runButton, updatingLabel, stopButton} -
        // live references to each row's widgets, refreshed on every
        // checkNow() rebuild. Lets an in-progress update mutate its own
        // row directly (elapsed tick, clearing on completion) without
        // needing a rebuild, which matters since checkNow() now skips
        // itself entirely while a background update is running.
        this._sourceRowWidgets = new Map();
        this._checking = false;
        this._destroyed = false;
        this._lastSourcePoll = new Map(); // name -> epoch ms
        this._lastSourceResults = new Map(); // name -> {status,count,message,lines}

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

        // Header card — neutral structure only, maps PkgUpdateWidget.qml:192
        this._headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'update-checker-header-card'});
        const headerBox = new St.BoxLayout({style_class: 'update-checker-header-card', x_expand: true});
        const headerLeft = new St.BoxLayout({style_class: 'update-checker-section-header', x_expand: true});
        const iconBox = new St.Widget({style_class: 'update-checker-header-icon-box', layout_manager: new Clutter.BinLayout()});
        const headerIcon = new St.Icon({icon_name: 'system-software-install-symbolic', icon_size: 20, style_class: 'update-checker-header-icon'});
        iconBox.add_child(headerIcon);
        const headerTextBox = new St.BoxLayout({vertical: true, y_align: 2 /* CENTER */, style_class: ''});
        this._headerTitle = new St.Label({text: 'Package Updates', style_class: 'update-checker-header-title'});
        this._headerSubtitle = new St.Label({text: 'Checking…', style_class: 'update-checker-header-subtitle'});
        headerTextBox.add_child(this._headerTitle);
        headerTextBox.add_child(this._headerSubtitle);
        headerLeft.add_child(iconBox);
        headerLeft.add_child(headerTextBox);
        const refreshBtn = new St.Button({style_class: 'update-checker-refresh-button', child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16})});
        refreshBtn.connect('clicked', () => this.checkNow(true));
        headerBox.add_child(headerLeft);
        headerBox.add_child(refreshBtn);
        this._headerItem.add_child(headerBox);
        this.menu.addMenuItem(this._headerItem);

        this._offlineItem = new PopupMenu.PopupMenuItem('Offline', {reactive: false});
        this._offlineItem.visible = false;
        this.menu.addMenuItem(this._offlineItem);

        this._securityItem = new PopupMenu.PopupMenuItem('Security updates', {reactive: true});
        this._securityItem.label.add_style_class_name('update-checker-status-line');
        this._securityItem.visible = false;
        this._securityFullMessage = '';
        // Connected once here, not rebuilt every check - reads whatever
        // the current state is at click time via instance state set in
        // _checkSecurity(), rather than reconnecting a fresh handler on
        // every check (which would stack up duplicate handlers).
        this._securityItem.connect('activate', () => {
            if (this._securityFullMessage)
                Main.notifyError('Security check', this._securityFullMessage);
        });
        this.menu.addMenuItem(this._securityItem);

        this._rebootItem = new PopupMenu.PopupMenuItem('Reboot required', {reactive: true});
        this._rebootItem.label.add_style_class_name('update-checker-status-line');
        this._rebootItem.visible = false;
        this._rebootFullMessage = '';
        this._rebootItem.connect('activate', () => {
            if (this._rebootFullMessage)
                Main.notifyError('Reboot check', this._rebootFullMessage);
        });
        this.menu.addMenuItem(this._rebootItem);

        this._resultsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._resultsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('Checking...', {reactive: false});
        this._statusItem.label.add_style_class_name('update-checker-status-line');
        this.menu.addMenuItem(this._statusItem);

        this._historyItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._historyItem.label.add_style_class_name('update-checker-status-line');
        this._historyItem.visible = false;
        this.menu.addMenuItem(this._historyItem);

        this._dismissItem = new PopupMenu.PopupMenuItem('Dismiss errors');
        this._dismissItem.visible = false;
        this._dismissItem.connect('activate', () => this._dismissErrors());
        this.menu.addMenuItem(this._dismissItem);

        const checkNowItem = new PopupMenu.PopupMenuItem('Check Now');
        checkNowItem.connect('activate', () => this.checkNow(true));
        this.menu.addMenuItem(checkNowItem);

        this._runScriptItem = new PopupMenu.PopupMenuItem('Run Update Script');
        this._runScriptItem.connect('activate', () => this._runUpdateScript());
        this.menu.addMenuItem(this._runScriptItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings…');
        settingsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(settingsItem);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._updateRunScriptVisibility();
        });

        this._renderEmpty();
        // Apply Matugen colors at launch — reads ~/.config/matugen/matugen-colors.css once per enable
        this._applyMatugenTheme();
    }

    // Ensure matugen stylesheet is unloaded when indicator is destroyed
    destroy() {
        this._removeMatugenTheme();
        super.destroy();
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

    _updateHeaderSubtitle() {
        if (!this._headerSubtitle)
            return;
        if (this._checking) {
            this._headerSubtitle.set_text('Checking…');
        } else if (this._lastOffline) {
            const when = this._lastCheckTimeStr ?? 'last check';
            this._headerSubtitle.set_text(`Offline — from ${when}`);
        } else if (this._lastTotal === -1) {
            this._headerSubtitle.set_text('Not checked yet');
        } else if (this._lastTotal > 0) {
            this._headerSubtitle.set_text(`${this._lastTotal} update${this._lastTotal === 1 ? '' : 's'} available`);
        } else if (this._lastAnyFailed) {
            this._headerSubtitle.set_text('Some checks failed');
        } else {
            this._headerSubtitle.set_text('System is up to date');
        }
    }

    _applyMatugenTheme() {
        try {
            const colors = loadMatugenColors();
            const css = buildMatugenCss(colors);
            const cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'update-checker-matugen.css']);
            GLib.file_set_contents(cachePath, css);
            const file = Gio.File.new_for_path(cachePath);
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            // Unload previous if any (hot reload)
            if (this._matugenThemeFile) {
                try { theme.unload_stylesheet(this._matugenThemeFile); } catch (e) {}
            }
            theme.load_stylesheet(file);
            this._matugenThemeFile = file;
        } catch (e) {
            logError(e, 'UpdateChecker matugen theme failed');
        }
    }

    _removeMatugenTheme() {
        if (this._matugenThemeFile) {
            try {
                const theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme();
                if (theme) theme.unload_stylesheet(this._matugenThemeFile);
            } catch (e) {}
            this._matugenThemeFile = null;
        }
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
            return true; // same hour => 24h quiet (disable via toggle, not via equal hours)
        const hour = GLib.DateTime.new_now_local().get_hour();
        return start < end
            ? (hour >= start && hour < end)
            : (hour >= start || hour < end); // wraps past midnight
    }

    _dismissErrors() {
        this._lastAnyFailed = false;
        this._lastRebootRequired = false;
        this._rebootItem.visible = false;
        this._securityItem.visible = false;
        this._dismissItem.visible = false;
        // Hide failed per-source rows until next check
        // (they will be rebuilt on next checkNow)
        this._updateVisibility();
        this._label.set_text(this._lastTotal > 0 ? `${this._lastTotal}` : '');
        this._icon.icon_name = this._lastTotal > 0 ? 'software-update-urgent-symbolic' : 'software-update-available-symbolic';
        this._statusItem.label.set_text(`Dismissed — next check ${this._settings.get_int('check-interval-minutes')}m`);
        this._updateHeaderSubtitle();
    }

    _pushHistory(total) {
        try {
            const now = GLib.DateTime.new_now_local().format_iso8601();
            const hist = this._settings.get_strv('history');
            hist.push(`${now}|${total}`);
            while (hist.length > 14) hist.shift();
            this._settings.set_strv('history', hist);
        } catch (e) {}
        this._updateHistoryItem();
    }

    _updateHistoryItem() {
        try {
            const hist = this._settings.get_strv('history');
            if (hist.length < 2) {
                this._historyItem.visible = false;
                return;
            }
            const vals = hist.map(h => {
                const idx = h.lastIndexOf('|');
                return idx !== -1 ? parseInt(h.slice(idx + 1), 10) || 0 : 0;
            });
            const sp = sparkline(vals);
            const last = vals[vals.length - 1];
            this._historyItem.label.set_text(`History ${sp}  ${last}`);
            this._historyItem.visible = true;
        } catch (e) {
            this._historyItem.visible = false;
        }
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
        this._updateHeaderSubtitle();
        if (this._dismissItem) this._dismissItem.visible = false;
        if (this._historyItem) this._updateHistoryItem();
    }

    // Launches a command in a terminal, same as before, but now tracked
    // via a real process handle (Gio.Subprocess + wait_async) instead
    // of fire-and-forget GLib.spawn_command_line_async - so we know
    // when it actually finishes. Tracked in _updatingSources under
    // `key` so checkNow()'s "skip while an update is running" guard
    // covers terminal-launched updates too, not just background ones -
    // otherwise the same lock-contention/empty-dropdown bug fixed for
    // background mode could still happen via this door. Unlike
    // background mode, this doesn't drive any row UI (no elapsed timer,
    // no stop button) - the open terminal window is already that
    // indicator, this is purely to prevent the collision.
    _runInTerminal(command, key) {
        const term = this._settings.get_string('terminal-command');
        const fullCommand = `${term} sh -c ${GLib.shell_quote(command)}`;
        this._launchTracked(fullCommand, key);
    }

    _launchTracked(fullCommand, key) {
        if (this._updatingSources.has(key)) {
            Main.notify('Update Checker', 'Already running - check the open terminal window.');
            return;
        }
        try {
            const [ok, argv] = GLib.shell_parse_argv(fullCommand);
            if (!ok)
                throw new Error('Could not parse terminal command');
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            this._updatingSources.set(key, {proc, isTerminal: true});
            proc.wait_async(null, (proc_, res) => {
                try {
                    proc_.wait_finish(res);
                } catch (e) {
                    // Terminal itself failed to launch/run - harmless
                    // to ignore here, the person already sees the
                    // terminal window (or its absence) directly.
                }
                // Guard: indicator may have been destroyed while terminal was open
                if (!this._sourceRowWidgets)
                    return;
                this._updatingSources.delete(key);
                // Only re-check if nothing else is still in flight -
                // checkNow() already guards this itself, but skip the
                // call entirely rather than let it early-return for no
                // visible reason.
                if (this._updatingSources.size === 0) {
                    // Terminal updates (including per-source and the
                    // generic script) don't have a single source name
                    // to invalidate, so force a full manual re-check
                    // to bypass the per-source interval cache (same
                    // bug as the pkexec background path above).
                    if (key !== '__script__')
                        this._lastSourcePoll.delete(key);
                    this._lastSourceResults.delete(key);
                    // __script__ could have touched anything - invalidate all
                    if (key === '__script__') {
                        this._lastSourcePoll.clear();
                        this._lastSourceResults.clear();
                    }
                    this.checkNow(true);
                }
            });
        } catch (e) {
            Main.notifyError('Update Checker', `Could not launch terminal: ${e.message}`);
        }
    }

    // Directly mutates a source's already-rendered row to show/hide the
    // "Updating..." state, without needing a checkNow() rebuild - which
    // matters since checkNow() deliberately skips itself entirely while
    // an update is in progress (see the guard at the top of checkNow).
    _setRowUpdating(name, isUpdating, elapsedText) {
        const widgets = this._sourceRowWidgets.get(name);
        if (!widgets)
            return;
        const {countLabel, runButton, updatingLabel, stopButton} = widgets;
        countLabel.visible = !isUpdating;
        if (runButton)
            runButton.visible = !isUpdating;
        updatingLabel.visible = isUpdating;
        stopButton.visible = isUpdating;
        if (isUpdating)
            updatingLabel.set_text(`Updating… ${elapsedText}`);
    }

    _stopSourceUpdate(label) {
        const entry = this._updatingSources.get(label);
        if (!entry)
            return;
        entry.stopped = true;
        try {
            entry.proc.force_exit();
        } catch (e) {
            // Already exited on its own right as we tried to stop it -
            // harmless, the completion callback will still run.
        }
    }

    // Run a source's update command without a terminal. If it contains
    // doas/sudo, those are stripped and the whole command is re-run
    // through pkexec instead, which shows its own graphical password
    // prompt - covers multi-command lines like "doas a && doas b" too,
    // since running doas a second time *inside* an already-root pkexec
    // shell would just fail.
    _runInBackground(command, label) {
        if (this._updatingSources.has(label)) {
            Main.notify(`${label} update already running`, 'Wait for it to finish first.');
            return;
        }

        const isOnline = Gio.NetworkMonitor.get_default().get_connectivity() ===
            Gio.NetworkConnectivity.FULL;
        if (!isOnline) {
            Main.notifyError(
                `${label} update not started`, 'No internet connection detected.');
            return;
        }

        const hasPrivilege = /\b(?:doas|sudo)\s+/.test(command);
        const cleaned = command.replace(/\b(?:doas|sudo)\s+/g, '');
        const argv = hasPrivilege ? ['pkexec', 'sh', '-c', cleaned] : ['sh', '-c', cleaned];

        Main.notify(`Updating ${label}...`, 'Running in background.');
        try {
            const proc = Gio.Subprocess.new(
                argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            const entry = {proc, startTime: GLib.get_monotonic_time(), stopped: false, tickId: null};
            this._updatingSources.set(label, entry);
            this._setRowUpdating(label, true, '0s');

            entry.tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                const elapsed = Math.round((GLib.get_monotonic_time() - entry.startTime) / 1000000);
                this._setRowUpdating(label, true, `${elapsed}s`);
                return GLib.SOURCE_CONTINUE;
            });

            proc.communicate_utf8_async(null, null, (proc_, res) => {
                if (entry.tickId) {
                    GLib.source_remove(entry.tickId);
                    entry.tickId = null;
                }
                let ok = false, stderr = '';
                try {
                    const [, , errOut] = proc_.communicate_utf8_finish(res);
                    stderr = errOut ?? '';
                    ok = proc_.get_exit_status() === 0;
                } catch (e) {
                    stderr = String(e);
                }
                // Guard: indicator may have been destroyed while update was running
                if (!this._sourceRowWidgets)
                    return;
                this._updatingSources.delete(label);
                this._setRowUpdating(label, false);
                if (entry.stopped)
                    Main.notify(`${label} update stopped`, 'Stopped before it finished.');
                else if (ok)
                    Main.notify(`${label} updated`, 'Finished successfully.');
                else {
                    const low = stderr.toLowerCase();
                    const cancelled = low.includes('dismissed') || low.includes('cancel') ||
                        low.includes('not authorized') || low.includes('auth could not be obtained');
                    if (cancelled) {
                        Main.notify(`${label} update cancelled`, 'Authentication cancelled.');
                    } else {
                        Main.notifyError(
                            `${label} update failed`, stderr.trim().split('\n')[0] || 'Unknown error');
                    }
                }
                // Re-check either way - success needs a fresh count,
                // and failure/stop needs a fresh look at what's still
                // actually pending, since a partial run may have
                // changed the real state even if it didn't finish.
                // Invalidate cached poll for this source so the
                // per-source interval cache (checkNow's `manual=false`
                // fast-path at extension.js:738) doesn't reuse the
                // stale pre-update count. Without this, the immediate
                // re-check would see `now - last < 60m` and return the
                // old `1` instead of the real `0` until the interval
                // expires or the user clicks "Check Now" (manual=true).
                this._lastSourcePoll.delete(label);
                this._lastSourceResults.delete(label);
                this.checkNow(true);
            });
        } catch (e) {
            this._updatingSources.delete(label);
            this._setRowUpdating(label, false);
            Main.notifyError('Update Checker', `Could not run update: ${e.message}`);
        }
    }

    _runSourceUpdate(command, label) {
        if (this._settings.get_boolean('background-updates'))
            this._runInBackground(command, label);
        else
            this._runInTerminal(command, label);
    }

    _runUpdateScript() {
        const path = this._settings.get_string('update-script-path');
        if (!path)
            return;
        const term = this._settings.get_string('terminal-command');
        const fullCommand = `${term} sh -c ${GLib.shell_quote(path)}`;
        this._launchTracked(fullCommand, '__script__');
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
        this._rebootFullMessage = rebootMessage || '';
        if (rebootRequired) {
            this._rebootItem.label.set_text(`⟳ ${truncate(rebootMessage || 'Reboot required', 55)}`);
            this._rebootItem.tooltip_text = rebootMessage || 'Reboot required';
        } else if (rebootCheckFailed) {
            this._rebootItem.label.set_text(`⚠ Reboot check failed: ${truncate(rebootMessage, 35)}`);
            this._rebootItem.tooltip_text = rebootMessage || '';
        } else {
            this._rebootItem.tooltip_text = '';
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
        this._securityFullMessage = failed ? (message || '') : '';
        if (count > 0) {
            this._securityItem.label.set_text(
                `🛡 ${count} security update${count === 1 ? '' : 's'} pending`);
            this._securityItem.tooltip_text = '';
        } else if (failed) {
            this._securityItem.label.set_text(`⚠ Security check failed: ${truncate(message, 35)}`);
            this._securityItem.tooltip_text = message || '';
        } else {
            this._securityItem.tooltip_text = '';
        }

        return failed;
    }

    async checkNow(manual = false) {
        if (this._checking)
            return;
        // A background update (no-terminal/pkexec mode) we started
        // ourselves is still running - running a check right now would
        // race it for the same package-manager lock, which is exactly
        // what caused the check to hang with nothing to show. Its own
        // completion already triggers a fresh check afterward, so
        // there's nothing lost by skipping this one. Only say something
        // for a manual click though - automatic triggers (timer,
        // package-db watcher, reconnect) skipping silently is correct,
        // not something worth a notification every single time.
        if (this._updatingSources.size > 0) {
            if (manual) {
                Main.notify(
                    'Update Checker',
                    'A background update is still running - it will refresh automatically when done.'
                );
            }
            return;
        }
        this._checking = true;
        this._updateHeaderSubtitle();

        // get_network_available() alone only means "there's a route" -
        // it's still true when connected to a router with no working
        // upstream internet (captive portal, ISP outage, etc.), which
        // would otherwise send us down the "online" path straight into
        // a wall of real but misleading failures. FULL connectivity
        // specifically means the host can actually reach the internet.
        const isOnline = Gio.NetworkMonitor.get_default().get_connectivity() ===
            Gio.NetworkConnectivity.FULL;
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
            this._statusItem.label.set_text(
                truncate(`Offline - showing results from ${when}${countPart}`, 55));
            this._checking = false;
            this._updateHeaderSubtitle();
            return;
        }

        this._offlineItem.visible = false;
        this._statusItem.label.set_text('Checking...');
        this._updateHeaderSubtitle();

        const sources = parseSources(this._settings.get_strv('sources'));
        const updateCommands = parseUpdateCommands(this._settings.get_strv('source-update-commands'));

        // Empty sources is misconfigured, not "up to date"
        if (sources.length === 0) {
            this._resultsSection.removeAll();
            this._sourceRowWidgets.clear();
            const warn = new PopupMenu.PopupMenuItem('No sources configured', {reactive: true});
            warn.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, style_class: 'update-checker-warning-icon'}));
            warn.label.add_style_class_name('update-checker-status-line');
            warn.label.set_text('No sources configured - add one in Preferences');
            warn.connect('activate', () => Main.notifyError('Update Checker', 'No update sources configured. Open Preferences → Update Sources and add one.'));
            this._resultsSection.addMenuItem(warn);
            this._lastTotal = 0;
            this._lastAnyFailed = true;
            this._label.set_text('!');
            this._icon.icon_name = 'dialog-warning-symbolic';
            this._statusItem.label.set_text('No sources configured');
            this._updateVisibility();
            this._checking = false;
            this._updateHeaderSubtitle();
            return;
        }

        const currentNames = new Set(sources.map(s => s.name));
        for (const name of this._expandedSources) {
            if (!currentNames.has(name))
                this._expandedSources.delete(name);
        }

        let total = 0;
        const failed = [];
        const results = [];

        // Per-source intervals: skip source if its interval hasn't elapsed (unless manual)
        const intervals = parseIntervals(this._settings.get_strv('source-intervals'));
        const globalMinutes = this._settings.get_int('check-interval-minutes');
        const nowMs = Date.now();
        const toPoll = [];
        for (const src of sources) {
            const iv = intervals.get(src.name) ?? globalMinutes;
            const last = this._lastSourcePoll.get(src.name) ?? 0;
            const cached = this._lastSourceResults.get(src.name);
            if (!manual && cached && (nowMs - last) < iv * 60 * 1000) {
                results.push({name: src.name, ...cached});
            } else {
                toPoll.push(src);
            }
        }

        // Run all sources, the reboot check, and the security check
        // concurrently.
        const [, rebootCheckFailed, securityCheckFailed] = await Promise.all([
            Promise.all(toPoll.map(async (src) => {
                const raw = await runShell(src.command);
                const res = classifyResult(raw);
                results.push({name: src.name, ...res});
                this._lastSourcePoll.set(src.name, nowMs);
                this._lastSourceResults.set(src.name, res);
            })),
            this._checkReboot(),
            this._checkSecurity(),
        ]);
        // For cached sources, ensure poll time stays as last (don't update)

        // Only clear the old rows now that fresh results are actually
        // ready to replace them - keeps the last-known (stale but real)
        // breakdown visible for the whole duration of the check instead
        // of a "Checking..." gap with nothing shown, which is jarring
        // if a check ever takes a while (e.g. contending for a lock a
        // background update is holding).
        this._resultsSection.removeAll();
        this._sourceRowWidgets.clear();

        // DMS-style neutral cards — header + container per source (no colors)
        const SOURCE_ICONS = {
            'DNF': 'system-software-install-symbolic',
            'Flatpak': 'application-x-flatpak-symbolic',
            'Cargo': 'application-x-cargo-symbolic',
            'npm (global)': 'application-x-npm-symbolic',
            'uv tools': 'application-x-python-symbolic',
        };
        const getIcon = n => SOURCE_ICONS[n] || 'package-x-generic-symbolic';

        for (const src of sources) {
            const r = results.find(x => x.name === src.name) ??
                {status: 'error', count: 0, message: 'no result', lines: []};
            const updateCommand = updateCommands.get(src.name);
            const canUpdate = r.status === 'ok' && r.count > 0 && !!updateCommand;

            if (r.status === 'error')
                failed.push(src.name);
            else
                total += r.count;

            // — Section header — PkgUpdateWidget.qml:293 structure
            const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'update-checker-section-header'});
            const headerBox = new St.BoxLayout({x_expand: true, style_class: 'update-checker-section-header'});
            const accent = new St.Widget({style_class: 'update-checker-accent'});
            const secIcon = new St.Icon({icon_name: getIcon(src.name), icon_size: 16, style_class: 'update-checker-section-icon'});
            const titleLabel = new St.Label({text: src.name, style_class: 'update-checker-section-title', y_align: 2});
            const badgeText = r.status === 'error' ? '!' : `${r.count}`;
            const countLabel = new St.Label({text: badgeText, style_class: 'update-checker-badge', y_align: 2});
            headerBox.add_child(accent);
            headerBox.add_child(secIcon);
            headerBox.add_child(titleLabel);
            headerBox.add_child(countLabel);

            // spacer
            const spacer = new St.Widget({x_expand: true});
            headerBox.add_child(spacer);

            let runButton = null;
            const updatingLabel = new St.Label({text: 'Updating…', style_class: 'update-checker-updating-label', visible: false, y_align: 2});
            const stopButton = new St.Button({style_class: 'update-checker-stop-icon', visible: false, child: new St.Icon({icon_name: 'process-stop-symbolic', icon_size: 14})});
            stopButton.connect('clicked', () => this._stopSourceUpdate(src.name));
            if (canUpdate) {
                runButton = new St.Button({style_class: 'update-checker-update-button', child: new St.BoxLayout({style_class: 'update-checker-section-header'})});
                const btnBox = new St.BoxLayout({style_class: 'update-checker-section-header'});
                btnBox.add_child(new St.Icon({icon_name: 'software-update-available-symbolic', icon_size: 12}));
                btnBox.add_child(new St.Label({text: 'Update', style_class: 'update-checker-update-button-label'}));
                runButton.set_child(btnBox);
                runButton.connect('clicked', () => this._runSourceUpdate(updateCommand, src.name));
                headerBox.add_child(runButton);
            }
            headerBox.add_child(updatingLabel);
            headerBox.add_child(stopButton);
            headerItem.add_child(headerBox);
            this._resultsSection.addMenuItem(headerItem);

            // keep live handles for _setRowUpdating (elapsed tick)
            this._sourceRowWidgets.set(src.name, {countLabel, runButton, updatingLabel, stopButton});
            const existingUpdate = this._updatingSources.get(src.name);
            if (existingUpdate && !existingUpdate.isTerminal)
                this._setRowUpdating(src.name, true);

            // — Container — PkgUpdateWidget.qml:397 StyledRect
            const containerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'update-checker-container'});
            const containerBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'update-checker-container'});

            if (r.status === 'error') {
                const errBox = new St.BoxLayout({style_class: 'update-checker-container-empty', x_expand: true});
                errBox.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16}));
                const errLabel = new St.Label({text: truncate(r.message || 'Unknown error', 50), style_class: 'update-checker-status-line'});
                errBox.add_child(errLabel);
                const clickable = new St.Button({child: errBox, x_expand: true});
                clickable.connect('clicked', () => Main.notifyError(`${src.name} check failed`, r.message || 'Unknown error'));
                containerBox.add_child(clickable);
            } else if (r.count === 0) {
                const emptyBox = new St.BoxLayout({style_class: 'update-checker-container-empty', x_expand: true});
                emptyBox.add_child(new St.Icon({icon_name: 'emblem-ok-symbolic', icon_size: 16}));
                emptyBox.add_child(new St.Label({text: 'No updates available', style_class: ''}));
                containerBox.add_child(emptyBox);
            } else {
                // list rows — PkgUpdateWidget.qml:454 ListView delegate 36px
                for (const line of r.lines) {
                    const parts = line.trim().split(/\s+|\t/);
                    const pkgName = parts[0] || line;
                    const version = parts[1] || '';
                    const row = new St.BoxLayout({style_class: 'update-checker-package-row', x_expand: true});
                    row.add_child(new St.Icon({icon_name: 'go-up-symbolic', icon_size: 12}));
                    const nameLabel = new St.Label({text: truncate(pkgName, 42), style_class: 'update-checker-package-name', x_expand: true});
                    row.add_child(nameLabel);
                    if (version) {
                        const verLabel = new St.Label({text: truncate(version, 24), style_class: 'update-checker-package-version'});
                        row.add_child(verLabel);
                    }
                    containerBox.add_child(row);
                }
            }

            containerItem.add_child(containerBox);
            this._resultsSection.addMenuItem(containerItem);
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
        let statusText = `${now} - ${total} update${total === 1 ? '' : 's'}`;
        if (this._lastSecurityCount > 0)
            statusText += ` · ${this._lastSecurityCount} security`;
        if (anyFailed)
            statusText += ` · ${failed.length} failed`;
        if (rebootCheckFailed)
            statusText += ' · reboot ⚠';
        if (securityCheckFailed)
            statusText += ' · security ⚠';
        // Hard cap regardless of phrasing - however many of the above
        // are true at once, this can never be the thing that stretches
        // the popup wide. Full detail is always one click away on the
        // individual failed items anyway.
        this._statusItem.label.set_text(truncate(statusText, 55));

        if (this._settings.get_boolean('notify-on-new') && !this._inQuietHours() &&
            this._lastNotifiedTotal !== -1 && total > this._lastNotifiedTotal) {
            Main.notify(
                'Updates available',
                `${total} update${total === 1 ? '' : 's'} pending.`
            );
        }
        this._lastNotifiedTotal = total;
        // History + dismiss visibility
        this._pushHistory(total);
        this._dismissItem.visible = anyFailed || rebootCheckFailed || securityCheckFailed;
        this._updateHistoryItem();
        this._checking = false;
        this._updateHeaderSubtitle();
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
        const scheduleReconnectCheck = () => {
            if (this._networkDebounceId) {
                GLib.source_remove(this._networkDebounceId);
                this._networkDebounceId = null;
            }
            if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                return;
            this._networkDebounceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 5, () => {
                    this._networkDebounceId = null;
                    if (this._networkMonitor.get_connectivity() === Gio.NetworkConnectivity.FULL)
                        this._indicator.checkNow();
                    return GLib.SOURCE_REMOVE;
                }
            );
        };
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed', () => scheduleReconnectCheck());
        // Belt-and-braces: 'network-changed' is documented around the
        // coarser network-available property, so also watch the
        // connectivity property directly in case a captive-portal login
        // completing (PORTAL -> FULL, with network-available true the
        // whole time) doesn't fire the former on its own.
        this._connectivityChangedId = this._networkMonitor.connect(
            'notify::connectivity', () => scheduleReconnectCheck());

        // Watch DNF's and Flatpak's own state directories directly, so
        // an update run ANY way - your own terminal, another tool, this
        // extension - triggers a fresh check, not just the scheduled
        // timer. A single package operation touches these directories
        // several times in a row, so this is debounced the same way as
        // the network-reconnect check above: wait a few seconds after
        // the LAST change before actually checking.
        this._dbWatchPaths = [
            '/usr/lib/sysimage/libdnf5', // dnf5 state (modern Fedora)
            '/var/lib/rpm',              // traditional rpmdb location
            '/var/lib/flatpak',          // system-wide Flatpak installs
            GLib.build_filenamev([GLib.get_home_dir(), '.local/share/flatpak']),
        ];
        this._dbMonitors = [];
        this._dbDebounceId = null;
        if (this._settings.get_boolean('watch-package-db')) {
            for (const path of this._dbWatchPaths) {
                try {
                    const monitor = Gio.File.new_for_path(path).monitor_directory(
                        Gio.FileMonitorFlags.NONE, null);
                    monitor.connect('changed', () => {
                        // Skip scheduling if offline or an update is running - checkNow()
                        // would just early-return anyway (and we avoid waking the disk
                        // for nothing). The update's own completion already triggers
                        // a fresh check, so nothing is lost.
                        if (this._indicator._updatingSources.size > 0)
                            return;
                        if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                            return;
                        if (this._dbDebounceId)
                            GLib.source_remove(this._dbDebounceId);
                        this._dbDebounceId = GLib.timeout_add_seconds(
                            GLib.PRIORITY_DEFAULT, 4, () => {
                                this._dbDebounceId = null;
                                // Re-check guards at fire time too (state may have changed)
                                if (this._indicator._updatingSources.size > 0)
                                    return GLib.SOURCE_REMOVE;
                                if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                                    return GLib.SOURCE_REMOVE;
                                // DB changed externally (e.g. dnf in your own terminal):
                                // force a full refresh bypassing per-source interval
                                // cache, otherwise the 60m cache would hide the change
                                // until the next scheduled tick / manual "Check Now".
                                this._indicator._lastSourcePoll.clear();
                                this._indicator._lastSourceResults.clear();
                                this._indicator.checkNow(true);
                                return GLib.SOURCE_REMOVE;
                            }
                        );
                    });
                    this._dbMonitors.push(monitor);
                } catch (e) {
                    // Path doesn't exist or isn't watchable on this
                    // system - harmless, just skip it.
                }
            }
        }

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
        if (this._connectivityChangedId) {
            this._networkMonitor.disconnect(this._connectivityChangedId);
            this._connectivityChangedId = null;
        }
        if (this._networkDebounceId) {
            GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = null;
        }
        this._networkMonitor = null;

        if (this._dbDebounceId) {
            GLib.source_remove(this._dbDebounceId);
            this._dbDebounceId = null;
        }
        for (const monitor of this._dbMonitors ?? [])
            monitor.cancel();
        this._dbMonitors = [];

        // Any background update's elapsed-time tick timer is tracked on
        // the indicator, not here - clear those too so they don't keep
        // firing (and mutating disposed widgets) after this runs. The
        // update's own subprocess isn't touched - it keeps running
        // regardless, same as it would if you closed a terminal running
        // `doas dnf update` - only our tracking/UI stops.
        for (const entry of this._indicator?._updatingSources?.values() ?? []) {
            if (entry.tickId)
                GLib.source_remove(entry.tickId);
        }
        // Mark destroyed so inflight wait_async/communicate callbacks can bail
        if (this._indicator)
            this._indicator._destroyed = true;

        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}
