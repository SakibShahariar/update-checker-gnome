import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runShell, hasMixedPrivilegeCommand, classifySubprocessExit, canUpdateIndicatorUi, setSourceRowUpdating, invalidateUpdateSourceCache, requestTrackedStop, clearTrackedStopTimeout, getElapsedSeconds} from './utils.js';
import {incrementPerformanceCounter, recordUpdateDuration} from './performance-counters.js';

// User-triggered update process lifecycle. All state remains owned by the
// Indicator instance; this module centralizes process launching and stopping.
    export function runInTerminal(indicator, command, key) {
        const term = indicator._settings.get_string('terminal-command');
        const fullCommand = `${term} sh -c ${GLib.shell_quote(command)}`;
        indicator._launchTracked(fullCommand, key);
    }

    export function launchTracked(indicator, fullCommand, key) {
        if (indicator._updatingSources.has(key)) {
            Main.notify('Update Checker', 'Already running - check the open terminal window.');
            return;
        }
        try {
            const [ok, argv] = GLib.shell_parse_argv(fullCommand);
            if (!ok)
                throw new Error('Could not parse terminal command');
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            incrementPerformanceCounter('commandsSpawned');
            incrementPerformanceCounter('updatesStarted');
            const entry = {proc, isTerminal: true, startTime: GLib.get_monotonic_time()};
            indicator._updatingSources.set(key, entry);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(key, true, '', 'terminal');
            proc.wait_async(null, (proc_, res) => {
                let outcome = {status: 'unknown'};
                try {
                    proc_.wait_finish(res);
                    const exited = proc_.get_if_exited();
                    const signaled = proc_.get_if_signaled();
                    outcome = classifySubprocessExit({
                        exited,
                        exitStatus: exited ? proc_.get_exit_status() : null,
                        signaled,
                        termSignal: signaled ? proc_.get_term_sig() : null,
                    });
                } catch (e) {
                    // Keep the outcome unknown if the launcher could not be waited.
                }
                clearTrackedStopTimeout(entry, GLib.source_remove);
                recordUpdateDuration((GLib.get_monotonic_time() - entry.startTime) / 1000);
                // A terminal launcher must wait for its child command (the default
                // GNOME Terminal configuration uses --wait) for this result to
                // represent the actual update rather than only window creation.
                if (!canUpdateIndicatorUi(indicator) || indicator._updatingSources.get(key) !== entry)
                    return;
                if (outcome.status === 'failed')
                    Main.notifyError('Update command failed', 'Terminal command exited with status ' + outcome.exitStatus + '.');
                else if (outcome.status === 'signaled')
                    Main.notifyError('Update command interrupted', 'Terminal command was terminated by signal ' + outcome.termSignal + '.');
                indicator._updatingSources.delete(key);
                indicator._updateSyncIconState();
                indicator._setRowUpdating(key, false);
                // Only re-check if nothing else is still in flight -
                // checkNow() already guards this itself, but skip the
                // call entirely rather than let it early-return for no
                // visible reason.
                if (indicator._updatingSources.size === 0) {
                    // Terminal updates (including per-source and the
                    // generic script) don't have a single source name
                    // to invalidate, so force a full manual re-check
                    // to bypass the per-source interval cache (same
                    // bug as the pkexec background path above).
                    invalidateUpdateSourceCache(indicator, key);
                    const queue = indicator._updateAllQueue;
                    if (queue && queue.activeLabel === key) {
                        queue.activeLabel = null;
                        queue.completed++;
                        indicator._advanceUpdateAllQueue();
                    } else {
                        indicator.checkNow(true);
                    }
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
    export function setRowUpdating(indicator, name, isUpdating, elapsedText, mode = 'background') {
        if (!canUpdateIndicatorUi(indicator))
            return;
        return setSourceRowUpdating(indicator._sourceRowWidgets.get(name), isUpdating, elapsedText, mode);
    }

    export function stopSourceUpdate(indicator, label) {
        const entry = indicator._updatingSources.get(label);
        if (!entry || entry.stopped)
            return;

        // The tracked process is a session leader, so signal the entire
        // update process group rather than only the shell/pkexec wrapper.
        // This prevents package managers from continuing after the UI says
        // the update was stopped.
        const signalGroup = (signal) => {
            const identifier = entry.proc.get_identifier();
            if (!identifier || !/^\d+$/.test(identifier))
                return;
            try {
                const killer = Gio.Subprocess.new(
                    ['/usr/bin/kill', `-${signal}`, '--', `-${identifier}`],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
                );
                killer.wait_async(null, (killerProc, result) => {
                    try { killerProc.wait_finish(result); } catch (e) {}
                });
            } catch (e) {
                // Completion callback still owns UI cleanup; a failed signal
                // must not make the extension throw from a button handler.
            }
        };

        // Keep the delayed force-kill tied to the same tracked entry so a
        // completed update cannot signal a reused process identifier.
        requestTrackedStop(
            entry,
            (delayMs, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            () => indicator._updatingSources.get(label) === entry,
            signal => signalGroup(signal),
            2000
        );
    }

    export function stopAllUpdates(indicator) {
        for (const label of [...indicator._updatingSources.keys()])
            stopSourceUpdate(indicator, label);
    }


    export function runInBackground(indicator, command, label) {
        if (indicator._updatingSources.has(label)) {
            Main.notify(`${label} update already running`, 'Wait for it to finish first.');
            return;
        }

        const connectivity = Gio.NetworkMonitor.get_default().get_connectivity();
        // This is an explicit user action, so allow LIMITED connectivity:
        // package repositories may still be reachable even when GNOME's
        // connectivity probe cannot confirm full internet access. Keep
        // rejecting LOCAL/NONE and captive-portal states with a clear message.
        const canAttemptUpdate = connectivity === Gio.NetworkConnectivity.FULL ||
            connectivity === Gio.NetworkConnectivity.LIMITED;
        if (!canAttemptUpdate) {
            const reason = connectivity === Gio.NetworkConnectivity.PORTAL
                ? 'The network requires sign-in before updates can run.'
                : 'No usable internet connection detected.';
            Main.notifyError(`${label} update not started`, reason);
            return;
        }

        if (hasMixedPrivilegeCommand(command) && !indicator._settings.get_boolean('bypass-mixed-privilege-command')) {
            Main.notifyError(
                `${label} update not started`,
                'Background mode would elevate the entire chained command. Split privileged and user-scoped steps into separate sources or use terminal mode.');
            return;
        }

        // Background mode has no terminal to prompt for a password, so any
        // doas/sudo prefix is stripped and the whole line is re-run under
        // pkexec instead (graphical, PolicyKit-mediated auth). NOTE: this
        // Mixed privileged/unprivileged shell commands are rejected above.
        // A remaining privilege prefix applies to this single source command.
        const hasPrivilege = /\b(?:doas|sudo|pkexec)\s+/.test(command);
        const cleaned = command.replace(/\b(?:doas|sudo|pkexec)\s+/g, '');
        const argv = hasPrivilege ? ['pkexec', 'sh', '-c', cleaned] : ['sh', '-c', cleaned];

        Main.notify(`Updating ${label}...`, 'Running in background.');
        try {
            // Isolate each background update in its own session/process group
            // so Stop Updating can terminate the package manager and its children.
            const proc = Gio.Subprocess.new(
                ['/usr/bin/setsid', ...argv],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            incrementPerformanceCounter('commandsSpawned');
            incrementPerformanceCounter('updatesStarted');

            const entry = {
                proc,
                startTime: GLib.get_monotonic_time(),
                isTerminal: false,
                stopped: false,
                tickId: null,
                stopTimeoutId: null,
            };
            indicator._updatingSources.set(label, entry);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(label, true, '0s', 'background');

            entry.tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                if (!canUpdateIndicatorUi(indicator)) {
                    entry.tickId = null;
                    return GLib.SOURCE_REMOVE;
                }
                const elapsed = getElapsedSeconds(entry.startTime, GLib.get_monotonic_time());
                indicator._setRowUpdating(label, true, `${elapsed}s`, 'background');
                return GLib.SOURCE_CONTINUE;
            });

            proc.communicate_utf8_async(null, null, (proc_, res) => {
                if (entry.tickId) {
                    GLib.source_remove(entry.tickId);
                    entry.tickId = null;
                }
                clearTrackedStopTimeout(entry, GLib.source_remove);
                let ok = false, stderr = '';
                try {
                    const [, , errOut] = proc_.communicate_utf8_finish(res);
                    stderr = errOut ?? '';
                    ok = proc_.get_exit_status() === 0;
                } catch (e) {
                    stderr = String(e);
                }
                recordUpdateDuration((GLib.get_monotonic_time() - entry.startTime) / 1000);
                // Guard: indicator may have been destroyed while update was running
                if (!canUpdateIndicatorUi(indicator))
                    return;
                indicator._updatingSources.delete(label);
                indicator._updateSyncIconState();
                indicator._setRowUpdating(label, false);
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
                invalidateUpdateSourceCache(indicator, label);
                const queue = indicator._updateAllQueue;
                if (queue && queue.activeLabel === label) {
                    queue.activeLabel = null;
                    queue.completed++;
                    indicator._advanceUpdateAllQueue();
                } else {
                    indicator.checkNow(true);
                }
            });
        } catch (e) {
            indicator._updatingSources.delete(label);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(label, false);
            Main.notifyError('Update Checker', `Could not run update: ${e.message}`);
        }
    }

    export function runSourceUpdate(indicator, command, label) {
        if (indicator._settings.get_boolean('background-updates'))
            indicator._runInBackground(command, label);
        else
            indicator._runInTerminal(command, label);
    }

    export function runUpdateScript(indicator) {
        const path = indicator._settings.get_string('update-script-path');
        if (!path)
            return;
        const term = indicator._settings.get_string('terminal-command');
        const fullCommand = `${term} sh -c ${GLib.shell_quote(path)}`;
        indicator._launchTracked(fullCommand, '__script__');
    }

