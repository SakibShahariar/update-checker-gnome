import GLib from 'gi://GLib';

const EMPTY_COUNTERS = () => ({
    checksStarted: 0,
    checksCompleted: 0,
    commandsSpawned: 0,
    menuRebuilds: 0,
    updatesStarted: 0,
    updatesCompleted: 0,
    updateDurationLastMs: 0,
    updateDurationTotalMs: 0,
    updateDurationMaxMs: 0,
});

let enabled = false;
let settings = null;
let counters = EMPTY_COUNTERS();
let publishSourceId = null;

function publish() {
    if (!settings)
        return;
    try {
        settings.set_string('performance-counters-json', JSON.stringify(counters));
    } catch (e) {
        // Instrumentation must never interfere with normal extension behavior.
    }
}

function schedulePublish() {
    if (!enabled || !settings || publishSourceId !== null)
        return;
    publishSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        publishSourceId = null;
        if (enabled)
            publish();
        return GLib.SOURCE_REMOVE;
    });
}

// Counters are session-local and aggregate-only. Disabling collection flushes
// the last snapshot but leaves it available for an opt-in diagnostics report.
export function configurePerformanceCounters(shouldEnable, settingsObject = null) {
    if (settingsObject)
        settings = settingsObject;
    if (publishSourceId !== null) {
        GLib.source_remove(publishSourceId);
        publishSourceId = null;
    }
    const nextEnabled = shouldEnable === true;
    if (nextEnabled && !enabled)
        counters = EMPTY_COUNTERS();
    enabled = nextEnabled;
    publish();
}

export function incrementPerformanceCounter(name, amount = 1) {
    if (!enabled || !Object.prototype.hasOwnProperty.call(counters, name) ||
        !Number.isFinite(amount) || amount <= 0)
        return;
    counters[name] += Math.round(amount);
    schedulePublish();
}

export function recordUpdateDuration(durationMs) {
    if (!enabled || !Number.isFinite(durationMs) || durationMs < 0)
        return;
    const duration = Math.round(durationMs);
    counters.updatesCompleted++;
    counters.updateDurationLastMs = duration;
    counters.updateDurationTotalMs += duration;
    counters.updateDurationMaxMs = Math.max(counters.updateDurationMaxMs, duration);
    schedulePublish();
}

export function getPerformanceCountersSnapshot() {
    return {...counters};
}
