import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cleanOldMatugenCache} from './lib/theming.js';
import {Indicator} from './lib/indicator.js';
import {setupNetworkWatch} from './lib/network-watch.js';

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
        this._securityAdvisoryChangedId = this._settings.connect('changed::security-advisory-command', () => {
            this._indicator?.checkNow(true);
        });

        this._networkWatchCleanup = setupNetworkWatch(this);

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
        if (this._securityAdvisoryChangedId) {
            this._settings.disconnect(this._securityAdvisoryChangedId);
            this._securityAdvisoryChangedId = null;
        }
        this._networkWatchCleanup?.();
        this._networkWatchCleanup = null;

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
