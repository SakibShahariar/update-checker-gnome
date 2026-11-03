import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    runShell, mapPool, classifyResult, filterIgnoredPackages, boundResultLines, parseSources,
    parseUpdateCommands, truncate, parseIntervals, runWorkerSafely, getSourceConfigurationState,
    parseSourceTimeouts, parseSourceExitCodes, parseSourceOutputFormats, getSecurityNotificationDelta, applySourceJitter,
    getEventDrivenSourceIntervals, getAdaptiveSourceIntervals,
} from './utils.js';
import {getWatchedSourceNames} from './network-watch.js';
import {shouldAnimate} from './motion.js';

// Check orchestration remains bound to the indicator instance for state,
// settings, and UI callbacks while keeping the polling flow out of its class.
export async function checkSources(manual = false) {
    if (this._checking)
        return;
    if (this._updateAllQueue) {
        if (manual)
            Main.notify('Update Checker', 'Update all is running; counts will refresh when the queue finishes.');
        return;
    }
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
            try {
                this._statusItem.label.set_text('Update running — check skipped');
                this._headerSubtitle?.set_text('Update running — check skipped');
            } catch (e) {}
            Main.notify(
                'Update Checker',
                'An update command is still running — counts will refresh automatically when it finishes.'
            );
        }
        return;
    }
    if (!manual) {
        const pausedOnBattery = this._settings.get_boolean('skip-on-battery') && this._isOnBattery();
        const pausedOnMetered = this._settings.get_boolean('skip-on-metered') && this._isNetworkMetered();
        if (pausedOnBattery || pausedOnMetered) {
            const reason = pausedOnBattery ? 'battery' : 'metered network';
            this._statusItem.label.set_text('Paused on ' + reason);
            this._headerSubtitle?.set_text('Background checks paused on ' + reason);
            this._markResultsCached('Background checks paused on ' + reason);
            this._publishSummary();
            return;
        }
    }
    this._checking = true;
    this._updateSyncIconState();
    this._publishSummary();
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
        if (this._destroyed) return;
        this._markResultsCached('Network is offline');
        const when = this._lastCheckTimeStr ?? 'last check';
        let countPart = this._lastTotal >= 0 ? ` (${this._lastTotal} update${this._lastTotal === 1 ? '' : 's'}` : '';
        if (this._lastTotal >= 0 && this._lastSecurityCount > 0)
            countPart += `, ${this._lastSecurityCount} security`;
        if (countPart)
            countPart += ')';
        this._statusItem.label.set_text(
            truncate(`Offline - showing results from ${when}${countPart}`, 55));
        this._checking = false;
        this._updateSyncIconState();
        this._publishSummary();
        this._updateHeaderSubtitle();
        return;
    }

    this._offlineItem.visible = false;
    this._statusItem.label.set_text('Checking...');
    this._updateHeaderSubtitle();

    const sourceLines = this._settings.get_strv('sources');
    const disabledSources = new Set(this._settings.get_strv('disabled-sources'));
    const configuredSources = parseSources(sourceLines);
    const sources = configuredSources.filter(source => !disabledSources.has(source.name));
    const sourceConfigurationState = getSourceConfigurationState(sourceLines, disabledSources);
    const updateCommands = parseUpdateCommands(this._settings.get_strv('source-update-commands'));

    // Empty, malformed, and fully disabled configurations need different
    // guidance; none of them should be presented as an up-to-date system.
    if (sourceConfigurationState !== 'ready') {
        this._resultsSection.removeAll();
        this._sourceRowWidgets.clear();
        const guidance = {
            empty: {
                label: 'No sources configured — add one in Sources settings',
                detail: 'Add an update source using a name and check command.',
            },
            invalid: {
                label: 'No valid sources — check source configuration',
                detail: 'Each source must use Name|command format with both fields filled in.',
            },
            disabled: {
                label: 'All sources disabled — enable one in Sources settings',
                detail: 'Enable at least one source to resume automatic and manual checks.',
            },
        }[sourceConfigurationState];
        const warn = new PopupMenu.PopupMenuItem(guidance.label, {reactive: true});
        warn.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, style_class: 'update-checker-warning-icon'}));
        warn.label.add_style_class_name('update-checker-status-line');
        warn.accessible_name = guidance.label + '. Activate to open source settings.';
        warn.label.tooltip_text = guidance.detail;
        warn.connect('activate', () => {
            this._settings.set_string('preferences-target-page', 'sources');
            this._ext.openPreferences();
        });
        this._resultsSection.addMenuItem(warn);
        this._updateResultsScrollHeight();
        this._lastTotal = 0;
        this._lastAnyFailed = true;
        this._setCountBadge('!');
        this._icon.icon_name = 'dialog-warning-symbolic';
        this._updateIconStyle(false);
        this._statusItem.label.set_text({
            empty: 'No sources configured',
            invalid: 'Source configuration invalid',
            disabled: 'All sources disabled',
        }[sourceConfigurationState]);
        this._updateVisibility();
        this._checking = false;
        this._updateSyncIconState();
        this._publishSummary();
        this._updateHeaderSubtitle();
        return;
    }

    const currentNames = new Set(sources.map(s => s.name));
    for (const name of this._expandedSources.keys()) {
        if (!currentNames.has(name))
            this._expandedSources.delete(name);
    }

    let total = 0;
    const failed = [];
    const results = [];

    // Per-source intervals: skip source if its interval hasn't elapsed (unless manual)
    const configuredIntervals = parseIntervals(this._settings.get_strv('source-intervals'));
    const globalMinutes = this._settings.get_int('check-interval-minutes');
    const watchedSources = getWatchedSourceNames(this._ext?._activeDbWatchPaths, sources);
    const baseIntervals = getEventDrivenSourceIntervals(globalMinutes, sources, configuredIntervals, watchedSources);
    let intervals = baseIntervals;
    if (this._settings.get_boolean('adaptive-check-intervals')) {
        try {
            const history = JSON.parse(this._settings.get_string('history-json') || '[]');
            intervals = getAdaptiveSourceIntervals(baseIntervals, history, configuredIntervals);
        } catch (e) {
            // Invalid optional history falls back to configured polling.
            intervals = baseIntervals;
        }
    }
    const sourceTimeouts = parseSourceTimeouts(this._settings.get_strv('source-timeouts'));
    const sourceExitCodes = parseSourceExitCodes(this._settings.get_strv('source-success-exit-codes'));
    const sourceOutputFormats = parseSourceOutputFormats(this._settings.get_strv('source-output-formats'));
    const nowMs = Date.now();
    const toPoll = [];
    for (const src of sources) {
        const iv = intervals.get(src.name) ?? globalMinutes;
        const last = this._lastSourcePoll.get(src.name) ?? 0;
        const cached = this._lastSourceResults.get(src.name);
        if (!manual && cached && (nowMs - last) < iv * 60 * 1000) {
            results.push({
                name: src.name,
                ...cached,
                ...(cached.details ? {details: cached.details} : {}),
                outputFormat: sourceOutputFormats.get(src.name) ?? 'auto',
                cached: true,
                cacheReason: 'Source interval has not elapsed',
            });
        } else {
            toPoll.push(src);
        }
    }

    // Publish queued/cached states before starting workers so reopening the
    // menu mid-check still shows what each source is doing.
    for (const src of sources) {
        const cachedResult = results.find(result => result.name === src.name);
        this._setSourceCheckState(src.name, cachedResult ? 'Cached' : 'Queued');
    }
    const displayResults = sources.map(src => {
        const current = results.find(result => result.name === src.name);
        if (current) return current;
        const previous = this._lastSourceResults.get(src.name);
        return {
            ...(previous ?? {status: 'ok', count: 0, message: '', lines: []}),
            outputFormat: sourceOutputFormats.get(src.name) ?? 'auto',
            name: src.name,
            cached: !!previous,
            checking: true,
        };
    });
    this._lastRenderSources = sources;
    this._lastRenderResults = displayResults;
    this._lastRenderUpdateCommands = updateCommands;
    this._rebuildResultsSection(sources, displayResults, updateCommands);

    // Run all sources, the reboot check, and the security check
    // concurrently. Cap concurrent source checks to keep CPU/IO bounded.
    const [, rebootCheckFailed, securityCheckFailed] = await Promise.all([
        mapPool(toPoll, 3, async (src) => {
            const jitter = await applySourceJitter(
                manual,
                Math.random,
                delayMs => new Promise(resolve => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                }),
                () => this._destroyed ||
                    this._settings.get_strv('disabled-sources').includes(src.name) ||
                    !parseSources(this._settings.get_strv('sources')).some(current =>
                        current.name === src.name && current.command === src.command),
                500
            );
            if (jitter.cancelled || this._destroyed)
                return;
            this._setSourceCheckState(src.name, 'Checking…');
            let timedOut = false;
            let cancelled = false;
            const res = await runWorkerSafely(async () => {
                const timeoutMs = (sourceTimeouts.get(src.name) ?? 120) * 1000;
                const raw = await runShell(src.command, timeoutMs);
                if (this._destroyed) return null;
                timedOut = raw.timedOut;
                cancelled = raw.cancelled;
                return {
                    ...boundResultLines(filterIgnoredPackages(
                        classifyResult({...raw, successExitCodes: sourceExitCodes.get(src.name)}),
                        this._settings.get_strv('ignored-packages'))),
                    outputFormat: sourceOutputFormats.get(src.name) ?? 'auto',
                };
            }, error => ({
                status: 'error',
                count: 0,
                message: String(error?.message ?? error),
                lines: [],
            }));
            if (this._destroyed || res === null) return;
            this._setSourceCheckState(src.name,
                cancelled || res.status === 'cancelled' ? 'Cancelled'
                    : timedOut ? 'Timed out' : (res.status === 'error' ? 'Failed' : 'Checked'));
            results.push({
                name: src.name,
                ...res,
                ...(res.details ? {details: res.details} : {}),
            });
            if (cancelled || res.status === 'cancelled')
                return;
            this._lastSourcePoll.set(src.name, nowMs);
            this._lastSourceResults.set(src.name, res);
        }),
        this._checkReboot(),
        this._checkSecurity(),
    ]);
    if (this._destroyed) return;

    // For cached sources, ensure poll time stays as last (don't update)

    // Cache for expand/collapse without re-querying commands
    this._lastRenderSources = sources;
    this._lastRenderResults = results;
    this._lastRenderUpdateCommands = updateCommands;

    // Compute total/failed before rendering (render hides ok+0 but total still counts hidden? No — hidden are 0 anyway)
    for (const src of sources) {
        const r = results.find(x => x.name === src.name) ??
            {status: 'error', count: 0, message: 'no result', lines: []};
        if (r.status === 'error')
            failed.push(src.name);
        else if (r.status !== 'cancelled')
            total += r.count;
    }

    this._rebuildResultsSection(sources, results, updateCommands);

    const anyFailed = failed.length > 0;
    const cancelledCount = results.filter(result => result.status === 'cancelled').length;
    const anyCancelled = cancelledCount > 0;
    const prevTotal = this._lastTotal;
    const prevFailed = this._lastAnyFailed;
    this._lastTotal = total;
    this._lastAnyFailed = anyFailed;
    this._updateVisibility();
    // Show count; append ! when some sources failed so stale success isn't implied
    this._setCountBadge(
        total > 0 ? (anyFailed ? `${total}!` : `${total}`) : (anyFailed ? '!' : '')
    );

    if (total > 0) {
        // Keep the recolorable symbolic glyph; urgency is shown via primary color
        this._icon.icon_name = 'software-update-available-symbolic';
        this._updateIconStyle(true);
    } else if (anyFailed) {
        this._icon.icon_name = 'dialog-warning-symbolic';
        this._updateIconStyle(false);
    } else {
        this._icon.icon_name = 'software-update-available-symbolic';
        this._updateIconStyle(false);
    }

    // Energetic: panel icon pulse when new total appears or increases
    if (total > 0 && total !== prevTotal) {
        this._animatePanelPulse();
    } else if (anyFailed && !prevFailed) {
        // Pulse on first failure too
        try {
            if (shouldAnimate()) {
                this._icon.set_pivot_point(0.5, 0.5);
                this._icon.ease({scale_x: 1.2, scale_y: 1.2, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._icon.ease({scale_x: 1, scale_y: 1, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_BOUNCE})});
            }
        } catch (e) {}
    }

    const now = GLib.DateTime.new_now_local().format('%H:%M');
    this._lastCheckTimeStr = now;
    let statusText = total === 0 && !anyFailed && !anyCancelled && !rebootCheckFailed && !securityCheckFailed
        ? `Up to date · checked ${now}`
        : `${now} - ${total} update${total === 1 ? '' : 's'}`;
    if (this._lastSecurityCount > 0)
        statusText += ` · ${this._lastSecurityCount} security`;
    const cachedCount = results.filter(r => r.cached).length;
    if (!anyFailed && !anyCancelled && cachedCount === 0)
        this._recordDailyHistory(total, results);
    if (cachedCount > 0)
        statusText += ` · ${cachedCount} cached`;
    if (anyFailed)
        statusText += ` · ${failed.length} failed`;
    if (anyCancelled)
        statusText += ` · ${cancelledCount} cancelled`;
    if (rebootCheckFailed)
        statusText += ' · reboot ⚠';
    if (securityCheckFailed)
        statusText += ' · security ⚠';
    // Hard cap regardless of phrasing - however many of the above
    // are true at once, this can never be the thing that stretches
    // the popup wide. Full detail is always one click away on the
    // individual failed items anyway.
    this._statusItem.label.set_text(truncate(statusText, 55));

    const quietHours = this._inQuietHours();
    const snoozed = this._isUpdateNotificationSnoozed();
    const notificationAllowed = !quietHours && !snoozed;
    const newSecurityCount = getSecurityNotificationDelta(
        this._lastNotifiedSecurityCount,
        this._lastSecurityCount,
        {
            enabled: this._settings.get_boolean('notify-security-only'),
            quietHours,
            snoozed,
            failed: securityCheckFailed,
        }
    );
    const securityNotificationSent = newSecurityCount > 0;
    if (securityNotificationSent)
        this._notifySecurityUpdates(newSecurityCount, this._lastSecurityCount, total);
    if (!securityCheckFailed)
        this._lastNotifiedSecurityCount = this._lastSecurityCount;

    if (!securityNotificationSent && this._settings.get_boolean('notify-on-new') &&
        notificationAllowed && this._lastNotifiedTotal !== -1 && total > this._lastNotifiedTotal) {
        this._notifyUpdatesAvailable(total);
    }
    this._lastNotifiedTotal = total;
    this._dismissItem.visible = anyFailed || rebootCheckFailed || securityCheckFailed;
    this._checking = false;
    this._updateSyncIconState();
    this._publishSummary();
    this._updateHeaderSubtitle();
}
