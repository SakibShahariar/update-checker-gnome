import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cleanOldMatugenCache} from './lib/theming.js';
import {Indicator} from './lib/indicator.js';
import {setupNetworkWatch, getWatchedSourceNames} from './lib/network-watch.js';
import {parseSources, parseIntervals, getPollingIntervalMinutes, getEventDrivenSourceIntervals, getAdaptiveSourceIntervals, cancelAllShellCommands, createDebouncer} from './lib/utils.js';

export default class UpdateCheckerExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings = this.getSettings();
        this._preferenceCheckDebouncer = createDebouncer(
            (delay, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            sourceId => GLib.source_remove(sourceId),
            750,
            () => {
                if (this._indicator?._checking) {
                    this._preferenceCheckDebouncer.schedule();
                    return;
                }
                // An active update or Update all queue performs its own final
                // re-check after completion, using the latest preferences.
                if (this._indicator?._updatingSources?.size || this._indicator?._updateAllQueue)
                    return;
                this._indicator?.checkNow(true);
            }
        );
        this._timeoutId = null;
        this._registerCheckNowKeybinding();
        this._shortcutChangedId = this._settings.connect('changed::check-now-shortcut', () => {
            if (this._checkNowKeybindingRegistered)
                Main.wm.removeKeybinding('check-now-shortcut');
            this._checkNowKeybindingRegistered = false;
            this._registerCheckNowKeybinding();
        });

        this._scheduleTimer();
        this._sourceIntervalsChangedId = this._settings.connect(
            'changed::source-intervals', () => {
                this._scheduleTimer();
                this._preferenceCheckDebouncer.schedule();
            }
        );
        this._settingsChangedId = this._settings.connect(
            'changed::check-interval-minutes', () => {
                this._scheduleTimer();
                this._preferenceCheckDebouncer.schedule();
            }
        );
        this._adaptiveCheckChangedId = this._settings.connect(
            'changed::adaptive-check-intervals', () => {
                this._scheduleTimer();
                this._preferenceCheckDebouncer.schedule();
            }
        );
        this._showZeroChangedId = this._settings.connect(
            'changed::show-zero', () => this._indicator._updateVisibility()
        );
        // Coalesce rapid source/command edits into one refresh after the user
        // pauses editing. The callback reads the final settings state.
        this._sourcesChangedId = this._settings.connect('changed::sources', () => {
            this._scheduleTimer();
            this._preferenceCheckDebouncer.schedule();
        });
        this._updateCmdsChangedId = this._settings.connect('changed::source-update-commands', () => {
            this._preferenceCheckDebouncer.schedule();
        });
        this._sourceOutputFormatsChangedId = this._settings.connect('changed::source-output-formats', () => {
            this._preferenceCheckDebouncer.schedule();
        });
        this._ignoredPackagesChangedId = this._settings.connect('changed::ignored-packages', () => {
            this._indicator?._lastSourcePoll.clear();
            this._indicator?._lastSourceResults.clear();
            this._preferenceCheckDebouncer.schedule();
        });
        this._securityAdvisoryChangedId = this._settings.connect('changed::security-advisory-command', () => {
            this._preferenceCheckDebouncer.schedule();
        });
        this._disabledSourcesChangedId = this._settings.connect('changed::disabled-sources', () => {
            if (!this._preferenceCheckDebouncer.flush())
                this._indicator?.checkNow(true);
        });
        this._powerPolicyChangedIds = [
            this._settings.connect('changed::skip-on-battery', () => this._indicator?.checkNow()),
            this._settings.connect('changed::skip-on-metered', () => this._indicator?.checkNow()),
        ];

        this._networkWatchCleanup = setupNetworkWatch(this);
        this._scheduleTimer();
        this._watchPackageDbChangedId = this._settings.connect('changed::watch-package-db', () => {
            this._networkWatchCleanup?.();
            this._networkWatchCleanup = setupNetworkWatch(this);
            this._scheduleTimer();
        });

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

    _registerCheckNowKeybinding() {
        const accelerator = this._settings.get_string('check-now-shortcut').trim();
        if (!accelerator)
            return;
        try {
            Main.wm.addKeybinding(
                'check-now-shortcut',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this._indicator?.checkNow(true)
            );
            this._checkNowKeybindingRegistered = true;
        } catch (error) {
            Main.notifyError('Update Checker shortcut',
                `Could not register the Check now shortcut: ${error.message}`);
        }
    }

    _scheduleTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const globalMinutes = this._settings.get_int('check-interval-minutes');
        const sources = parseSources(this._settings.get_strv('sources'));
        const configuredIntervals = parseIntervals(this._settings.get_strv('source-intervals'));
        const watchedSources = getWatchedSourceNames(this._activeDbWatchPaths, sources);
        const baseIntervals = getEventDrivenSourceIntervals(globalMinutes, sources, configuredIntervals, watchedSources);
        let intervals = baseIntervals;
        if (this._settings.get_boolean('adaptive-check-intervals')) {
            try {
                const history = JSON.parse(this._settings.get_string('history-json') || '[]');
                intervals = getAdaptiveSourceIntervals(baseIntervals, history, configuredIntervals);
            } catch (e) {
                // Corrupt optional history must never prevent normal polling.
                intervals = baseIntervals;
            }
        }
        const minutes = getPollingIntervalMinutes(globalMinutes, sources, intervals);
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                this._indicator.checkNow();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._indicator?._updateScheduleDisplay();
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
        if (this._shortcutChangedId) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = null;
        }
        if (this._checkNowKeybindingRegistered) {
            Main.wm.removeKeybinding('check-now-shortcut');
            this._checkNowKeybindingRegistered = false;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._adaptiveCheckChangedId) {
            this._settings.disconnect(this._adaptiveCheckChangedId);
            this._adaptiveCheckChangedId = null;
        }
        if (this._showZeroChangedId) {
            this._settings.disconnect(this._showZeroChangedId);
            this._showZeroChangedId = null;
        }
        if (this._sourceIntervalsChangedId) {
            this._settings.disconnect(this._sourceIntervalsChangedId);
            this._sourceIntervalsChangedId = null;
        }
        if (this._sourcesChangedId) {
            this._settings.disconnect(this._sourcesChangedId);
            this._sourcesChangedId = null;
        }
        if (this._updateCmdsChangedId) {
            this._settings.disconnect(this._updateCmdsChangedId);
            this._updateCmdsChangedId = null;
        }
        if (this._sourceOutputFormatsChangedId) {
            this._settings.disconnect(this._sourceOutputFormatsChangedId);
            this._sourceOutputFormatsChangedId = null;
        }
        if (this._ignoredPackagesChangedId) {
            this._settings.disconnect(this._ignoredPackagesChangedId);
            this._ignoredPackagesChangedId = null;
        }
        if (this._securityAdvisoryChangedId) {
            this._settings.disconnect(this._securityAdvisoryChangedId);
            this._securityAdvisoryChangedId = null;
        }
        if (this._disabledSourcesChangedId) {
            this._settings.disconnect(this._disabledSourcesChangedId);
            this._disabledSourcesChangedId = null;
        }
        if (this._watchPackageDbChangedId) {
            this._settings.disconnect(this._watchPackageDbChangedId);
            this._watchPackageDbChangedId = null;
        }
        // Do not start a new check while the extension is tearing down.
        this._preferenceCheckDebouncer?.cancel();
        this._preferenceCheckDebouncer = null;
        for (const id of this._powerPolicyChangedIds ?? [])
            this._settings.disconnect(id);
        this._powerPolicyChangedIds = [];
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
        // Mark destroyed before cancelling so in-flight continuations can
        // avoid touching widgets/settings that are being torn down.
        if (this._indicator)
            this._indicator._destroyed = true;
        cancelAllShellCommands();

        this._settings = null;

        if (this._indicator?._monitorsChangedId)
            Main.layoutManager.disconnect(this._indicator._monitorsChangedId);

        this._indicator?.destroy();
        this._indicator = null;
    }
}
