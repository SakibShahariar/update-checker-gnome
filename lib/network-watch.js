import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Own the network reconnect debounce and package-database watches separately
// from the extension lifecycle. The returned disposer must run on disable.
export function setupNetworkWatch(extension) {
        // When connectivity comes back after being offline, refresh
        // automatically - but not instantly. The interface can report
        // "available" a moment before DNS/routing actually work (right
        // after reconnecting), so checking immediately can produce a
        // real but misleading "failed to download metadata" error. Wait
        // a few seconds for things to settle first, and if it flaps
        // offline again before that timer fires, cancel rather than
        // check on a connection that's already gone again.
        extension._networkMonitor = Gio.NetworkMonitor.get_default();
        extension._networkDebounceId = null;
        const scheduleReconnectCheck = () => {
            if (extension._networkDebounceId) {
                GLib.source_remove(extension._networkDebounceId);
                extension._networkDebounceId = null;
            }
            // Going offline: drop any pending DB-watch check so reconnect
            // does not flush a queue of deferred ticks at once.
            if (extension._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
                if (extension._dbDebounceId) {
                    GLib.source_remove(extension._dbDebounceId);
                    extension._dbDebounceId = null;
                }
                return;
            }
            extension._networkDebounceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 5, () => {
                    extension._networkDebounceId = null;
                    if (extension._networkMonitor.get_connectivity() === Gio.NetworkConnectivity.FULL)
                        extension._indicator.checkNow();
                    return GLib.SOURCE_REMOVE;
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
            GLib.build_filenamev([GLib.get_home_dir(), '.local/share/flatpak']),
        ];
        extension._dbMonitors = [];
        extension._dbDebounceId = null;
        if (extension._settings.get_boolean('watch-package-db')) {
            for (const path of extension._dbWatchPaths) {
                try {
                    const monitor = Gio.File.new_for_path(path).monitor_directory(
                        Gio.FileMonitorFlags.NONE, null);
                    monitor.connect('changed', () => {
                        // Skip scheduling if offline or an update is running - checkNow()
                        // would just early-return anyway (and we avoid waking the disk
                        // for nothing). The update's own completion already triggers
                        // a fresh check, so nothing is lost.
                        if (extension._indicator._updatingSources.size > 0)
                            return;
                        if (extension._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                            return;
                        if (extension._dbDebounceId)
                            GLib.source_remove(extension._dbDebounceId);
                        extension._dbDebounceId = GLib.timeout_add_seconds(
                            GLib.PRIORITY_DEFAULT, 4, () => {
                                extension._dbDebounceId = null;
                                // Re-check guards at fire time too (state may have changed)
                                if (extension._indicator._updatingSources.size > 0)
                                    return GLib.SOURCE_REMOVE;
                                if (extension._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                                    return GLib.SOURCE_REMOVE;
                                // DB changed externally (e.g. dnf in your own terminal):
                                // force a full refresh bypassing per-source interval
                                // cache, otherwise the 60m cache would hide the change
                                // until the next scheduled tick / manual "Check Now".
                                extension._indicator._lastSourcePoll.clear();
                                extension._indicator._lastSourceResults.clear();
                                extension._indicator.checkNow();
                                return GLib.SOURCE_REMOVE;
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
        if (extension._networkChangedId) {
            extension._networkMonitor.disconnect(extension._networkChangedId);
            extension._networkChangedId = null;
        }
        if (extension._connectivityChangedId) {
            extension._networkMonitor.disconnect(extension._connectivityChangedId);
            extension._connectivityChangedId = null;
        }
        if (extension._networkDebounceId) {
            GLib.source_remove(extension._networkDebounceId);
            extension._networkDebounceId = null;
        }
        extension._networkMonitor = null;

        if (extension._dbDebounceId) {
            GLib.source_remove(extension._dbDebounceId);
            extension._dbDebounceId = null;
        }
        for (const monitor of extension._dbMonitors ?? [])
            monitor.cancel();
        extension._dbMonitors = [];
    };
}
