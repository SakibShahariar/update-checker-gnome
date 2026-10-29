import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    runShell, mapPool, classifyResult, filterIgnoredPackages, parseSources,
    parseUpdateCommands, truncate, parseIntervals,
} from './utils.js';
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

    const disabledSources = new Set(this._settings.get_strv('disabled-sources'));
    const sources = parseSources(this._settings.get_strv('sources'))
        .filter(source => !disabledSources.has(source.name));
    const updateCommands = parseUpdateCommands(this._settings.get_strv('source-update-commands'));

    // Empty sources is misconfigured, not "up to date"
    if (sources.length === 0) {
        this._resultsSection.removeAll();
        this._sourceRowWidgets.clear();
        const warn = new PopupMenu.PopupMenuItem('No sources configured', {reactive: true});
        warn.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, style_class: 'update-checker-warning-icon'}));
        warn.label.add_style_class_name('update-checker-status-line');
        warn.label.set_text(this._settings.get_strv('sources').length > 0
            ? 'All sources are disabled - enable one in Preferences'
            : 'No sources configured - add one in Preferences');
        warn.connect('activate', () => Main.notifyError('Update Checker',
            this._settings.get_strv('sources').length > 0
                ? 'All update sources are disabled. Open Preferences → Update Sources and enable one.'
                : 'No update sources configured. Open Preferences → Update Sources and add one.'));
        this._resultsSection.addMenuItem(warn);
        this._updateResultsScrollHeight();
        this._lastTotal = 0;
        this._lastAnyFailed = true;
        this._setCountBadge('!');
        this._icon.icon_name = 'dialog-warning-symbolic';
        this._updateIconStyle(false);
        this._statusItem.label.set_text('No sources configured');
        this._updateVisibility();
        this._checking = false;
        this._updateSyncIconState();
        this._publishSummary();
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
            results.push({name: src.name, ...cached, cached: true, cacheReason: 'Source interval has not elapsed'});
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
            this._setSourceCheckState(src.name, 'Checking…');
            const raw = await runShell(src.command);
            if (this._destroyed) return;
            const res = filterIgnoredPackages(
                classifyResult(raw), this._settings.get_strv('ignored-packages'));
            this._setSourceCheckState(src.name, raw.timedOut ? 'Timed out' : (res.status === 'error' ? 'Failed' : 'Checked'));
            results.push({name: src.name, ...res});
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
        else
            total += r.count;
    }

    this._rebuildResultsSection(sources, results, updateCommands);

    const anyFailed = failed.length > 0;
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
    let statusText = total === 0 && !anyFailed && !rebootCheckFailed && !securityCheckFailed
        ? `Up to date · checked ${now}`
        : `${now} - ${total} update${total === 1 ? '' : 's'}`;
    if (this._lastSecurityCount > 0)
        statusText += ` · ${this._lastSecurityCount} security`;
    const cachedCount = results.filter(r => r.cached).length;
    if (!anyFailed && cachedCount === 0)
        this._recordDailyHistory(total, results);
    if (cachedCount > 0)
        statusText += ` · ${cachedCount} cached`;
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
        !this._isUpdateNotificationSnoozed() && this._lastNotifiedTotal !== -1 && total > this._lastNotifiedTotal) {
        this._notifyUpdatesAvailable(total);
    }
    this._lastNotifiedTotal = total;
    this._dismissItem.visible = anyFailed || rebootCheckFailed || securityCheckFailed;
    this._checking = false;
    this._updateSyncIconState();
    this._publishSummary();
    this._updateHeaderSubtitle();
}
