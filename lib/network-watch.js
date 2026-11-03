import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseSources} from './utils.js';

export function sourceNamesForDatabasePath(path, sources) {
    const kind = path.includes('flatpak') ? 'flatpak' :
        (path.includes('rpm') || path.includes('libdnf')) ? 'rpm' : null;
    if (!kind)
        return sources.map(source => source.name);
    const pattern = kind === 'flatpak' ? /\bflatpak\b/i : /\b(?:dnf|dnf5|yum|rpm)\b/i;
    return sources.filter(source => pattern.test(source.command)).map(source => source.name);
}


// Own the network reconnect debounce and package-database watches separately
// from the extension lifecycle. The returned disposer must run on disable.
export function setupNetworkWatch(extension, dependencies = {}) {
        const networkMonitor = dependencies.networkMonitor ?? Gio.NetworkMonitor.get_default();
        const buildFilenamev = dependencies.buildFilenamev ?? GLib.build_filenamev;
        const getHomeDir = dependencies.getHomeDir ?? GLib.get_home_dir;
        const fileForPath = dependencies.fileForPath ?? (path => Gio.File.new_for_path(path));
        const monitorFlags = dependencies.monitorFlags ?? Gio.FileMonitorFlags.NONE;
        const timeoutAddSeconds = dependencies.timeoutAddSeconds ?? GLib.timeout_add_seconds;
        const sourceRemove = dependencies.sourceRemove ?? GLib.source_remove;
        const priorityDefault = dependencies.priorityDefault ?? GLib.PRIORITY_DEFAULT;
        const sourceRemoveReturn = dependencies.sourceRemoveReturn ?? sourceRemoveReturn;
        const connectivityFull = dependencies.connectivityFull ?? Gio.NetworkConnectivity.FULL;
        let active = true;
        const isAlive = () => active && extension._indicator && !extension._indicator._destroyed;
        // When connectivity comes back after being offline, refresh
        // automatically - but not instantly. The interface can report
        // "available" a moment before DNS/routing actually work (right
        // after reconnecting), so checking immediately can produce a
        // real but misleading "failed to download metadata" error. Wait
        // a few seconds for things to settle first, and if it flaps
        // offline again before that timer fires, cancel rather than
        // check on a connection that's already gone again.
        extension._networkMonitor = networkMonitor;
        extension._networkDebounceId = null;
        const scheduleReconnectCheck = () => {
            if (!isAlive())
                return;
            if (extension._networkDebounceId) {
                sourceRemove(extension._networkDebounceId);
                extension._networkDebounceId = null;
            }
            // Going offline: drop any pending DB-watch check so reconnect
            // does not flush a queue of deferred ticks at once.
            if (extension._networkMonitor.get_connectivity() !== connectivityFull) {
                if (extension._dbDebounceId) {
                    sourceRemove(extension._dbDebounceId);
                    extension._dbDebounceId = null;
                }
                return;
            }
            extension._networkDebounceId = timeoutAddSeconds(
                priorityDefault, 5, () => {
                    extension._networkDebounceId = null;
                    if (isAlive() && extension._networkMonitor &&
                        extension._networkMonitor.get_connectivity() === connectivityFull)
                        extension._indicator.checkNow();
                    return sourceRemoveReturn;
                }
            );
        };
        extension._networkChangedId = extension._networkMonitor.connect(
            'network-changed', () => scheduleReconnectCheck());
        // Belt-and-braces: 'network-changed' is documented around the
        // coarser network-available property, so also watch the
        // connectivity property directly in case a captive-portal login
        // completing (PORTAL -> FULL, with network-available true the
        // whole time) doesn't fire the former on its own.
        extension._connectivityChangedId = extension._networkMonitor.connect(
            'notify::connectivity', () => scheduleReconnectCheck());

        // Watch DNF's and Flatpak's own state directories directly, so
        // an update run ANY way - your own terminal, another tool, this
        // extension - triggers a fresh check, not just the scheduled
        // timer. A single package operation touches these directories
        // several times in a row, so this is debounced the same way as
        // the network-reconnect check above: wait a few seconds after
        // the LAST change before actually checking.
        extension._dbWatchPaths = [
            '/usr/lib/sysimage/libdnf5', // dnf5 state (modern Fedora)
            '/var/lib/rpm',              // traditional rpmdb location
            '/var/lib/flatpak',          // system-wide Flatpak installs
            buildFilenamev([getHomeDir(), '.local/share/flatpak']),
        ];
        extension._dbMonitors = [];
        extension._dbDebounceId = null;
        if (extension._settings.get_boolean('watch-package-db')) {
            for (const path of extension._dbWatchPaths) {
                try {
                    const monitor = fileForPath(path).monitor_directory(
                        monitorFlags, null);
                    monitor.connect('changed', () => {
                        if (!isAlive())
                            return;
                        // Skip scheduling if offline or an update is running - checkNow()
                        // would just early-return anyway (and we avoid waking the disk
                        // for nothing). The update's own completion already triggers
                        // a fresh check, so nothing is lost.
                        if (extension._indicator._updatingSources.size > 0)
                            return;
                        if (extension._networkMonitor.get_connectivity() !== connectivityFull)
                            return;
                        if (extension._dbDebounceId)
                            sourceRemove(extension._dbDebounceId);
                        extension._dbDebounceId = timeoutAddSeconds(
                            priorityDefault, 4, () => {
                                extension._dbDebounceId = null;
                                // Re-check lifecycle and state at fire time too.
                                if (!isAlive())
                                    return sourceRemoveReturn;
                                if (extension._indicator._updatingSources.size > 0)
                                    return sourceRemoveReturn;
                                if (extension._networkMonitor.get_connectivity() !== connectivityFull)
                                    return sourceRemoveReturn;
                                // Invalidate only package sources related to the watched
                                // database. Unknown source commands are left cached; the
                                // regular schedule/manual refresh remains the fallback.
                                const sources = parseSources(extension._settings.get_strv('sources'));
                                const affected = sourceNamesForDatabasePath(path, sources);
                                for (const name of affected) {
                                    extension._indicator._lastSourcePoll.delete(name);
                                    extension._indicator._lastSourceResults.delete(name);
                                }
                                if (affected.length > 0)
                                    extension._indicator.checkNow();
                                return sourceRemoveReturn;
                            }
                        );
                    });
                    extension._dbMonitors.push(monitor);
                } catch (e) {
                    // Path doesn't exist or isn't watchable on this
                    // system - harmless, just skip it.
                }
            }
        }

 
    return () => {
        active = false;
        if (extension._networkChangedId) {
            extension._networkMonitor.disconnect(extension._networkChangedId);
            extension._networkChangedId = null;
        }
        if (extension._connectivityChangedId) {
            extension._networkMonitor.disconnect(extension._connectivityChangedId);
            extension._connectivityChangedId = null;
        }
        if (extension._networkDebounceId) {
            sourceRemove(extension._networkDebounceId);
            extension._networkDebounceId = null;
        }
        extension._networkMonitor = null;

        if (extension._dbDebounceId) {
            sourceRemove(extension._dbDebounceId);
            extension._dbDebounceId = null;
        }
        for (const monitor of extension._dbMonitors ?? [])
            monitor.cancel();
        extension._dbMonitors = [];
    };
}
