import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cleanOldMatugenCache} from './lib/theming.js';
import {Indicator} from './lib/indicator.js';

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
        // Re-check immediately on either change, regardless of whether the
        // popup is currently open -- consistent with every other checkNow()
        // trigger (reconnect, package-db watch), so editing Sources/commands
        // in Preferences doesn't leave stale results sitting until the next
        // scheduled poll.
        this._sourcesChangedId = this._settings.connect('changed::sources', () => {
            this._indicator?.checkNow(true);
        });
        this._updateCmdsChangedId = this._settings.connect('changed::source-update-commands', () => {
            this._indicator?.checkNow(true);
        });
        this._ignoredPackagesChangedId = this._settings.connect('changed::ignored-packages', () => {
            this._indicator?._lastSourcePoll.clear();
            this._indicator?._lastSourceResults.clear();
            this._indicator?.checkNow(true);
        });

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
            // Going offline: drop any pending DB-watch check so reconnect
            // does not flush a queue of deferred ticks at once.
            if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
                if (this._dbDebounceId) {
                    GLib.source_remove(this._dbDebounceId);
                    this._dbDebounceId = null;
                }
                return;
            }
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

        // Defer initial check until shell startup completes (or ~5–8s).
        cleanOldMatugenCache('update-checker-matugen-');
        const runInitialCheck = () => {
            if (this._startupId) {
                GLib.source_remove(this._startupId);
                this._startupId = null;
            }
            if (this._startupCompleteId) {
                try { Main.layoutManager.disconnect(this._startupCompleteId); } catch (e) {}
                this._startupCompleteId = null;
            }
            this._indicator?.checkNow();
        };
        this._startupCompleteId = null;
        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => runInitialCheck());
            this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                runInitialCheck();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                runInitialCheck();
                return GLib.SOURCE_REMOVE;
            });
        }
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
        if (this._startupCompleteId) {
            try { Main.layoutManager.disconnect(this._startupCompleteId); } catch (e) {}
            this._startupCompleteId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._showZeroChangedId) {
            this._settings.disconnect(this._showZeroChangedId);
            this._showZeroChangedId = null;
        }
        if (this._sourcesChangedId) {
            this._settings.disconnect(this._sourcesChangedId);
            this._sourcesChangedId = null;
        }
        if (this._updateCmdsChangedId) {
            this._settings.disconnect(this._updateCmdsChangedId);
            this._updateCmdsChangedId = null;
        }
        if (this._ignoredPackagesChangedId) {
            this._settings.disconnect(this._ignoredPackagesChangedId);
            this._ignoredPackagesChangedId = null;
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

        if (this._indicator?._monitorsChangedId)
            Main.layoutManager.disconnect(this._indicator._monitorsChangedId);

        this._indicator?.destroy();
        this._indicator = null;
    }
}
