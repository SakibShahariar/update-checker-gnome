import Gio from 'gi://Gio';
import GLib from 'gi://GLib';



// Run `sh -c command`, resolving with stdout, stderr, and the exit
// status. We never reject on non-zero exit - many tools (e.g. `dnf
// check-update`) exit non-zero simply because updates ARE available -
// so the caller decides what a given exit code/output combo means.
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const activeShellCommands = new Set();

// Terminate the isolated process group, not just the shell: descendants can
// inherit stdout/stderr and otherwise keep communicate() alive.
function killShellProcessGroup(proc) {
    const identifier = proc.get_identifier();
    if (identifier && /^\d+$/.test(identifier)) {
        try {
            const killer = Gio.Subprocess.new(
                ['/usr/bin/kill', '-KILL', '--', '-' + identifier],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            killer.wait_async(null, (killerProc, result) => {
                try {
                    killerProc.wait_finish(result);
                    if (killerProc.get_exit_status() !== 0)
                        proc.force_exit();
                } catch (e) {
                    try { proc.force_exit(); } catch (ignored) {}
                }
            });
            return;
        } catch (e) {
            // Fall back to terminating the shell if the kill helper cannot start.
        }
    }
    try { proc.force_exit(); } catch (e) {}
}

// Called when the extension is disabled so no check command is left running.
export function cancelAllShellCommands() {
    for (const entry of [...activeShellCommands])
        entry.cancel();
}

// Run a shell command with a bounded wait. Some check commands (for
// example, dnf check-update) use a non-zero exit status to report updates,
// so the caller interprets exit status and output together.
export function runShell(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let timeoutId = 0;
        let timedOut = false;
        let cancelled = false;
        let entry = null;
        try {
            // Put each check in its own process group so timeout/teardown can
            // terminate the shell and ordinary child processes together.
            const proc = Gio.Subprocess.new(
                ['/usr/bin/setsid', '/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const cancellable = new Gio.Cancellable();
            const clearTimeout = () => {
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    timeoutId = 0;
                }
            };
            entry = {
                cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    clearTimeout();
                    killShellProcessGroup(proc);
                    cancellable.cancel();
                },
            };
            activeShellCommands.add(entry);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timeoutId = 0;
                timedOut = true;
                killShellProcessGroup(proc);
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, cancellable, (proc_, res) => {
                clearTimeout();
                activeShellCommands.delete(entry);
                try {
                    const [, stdout, stderr] = proc_.communicate_utf8_finish(res);
                    resolve({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitStatus: proc_.get_exit_status(),
                        spawnFailed: false,
                        timedOut,
                        cancelled,
                        timeoutMs,
                    });
                } catch (e) {
                    resolve({
                        stdout: '',
                        stderr: timedOut || cancelled ? '' : String(e),
                        exitStatus: -1,
                        spawnFailed: !timedOut && !cancelled,
                        timedOut,
                        cancelled,
                        timeoutMs,
                    });
                }
            });
        } catch (e) {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            if (entry)
                activeShellCommands.delete(entry);
            resolve({
                stdout: '',
                stderr: String(e),
                exitStatus: -1,
                spawnFailed: true,
                timedOut: false,
                cancelled: false,
                timeoutMs,
            });
        }
    });
}


// Classify a source's result. DNF check-update uses exit status 100
// to indicate that updates are available, so that status remains valid
// when it produces output. For other non-zero statuses, non-empty stdout
// is not enough to declare success: a command may print partial results
// and then fail. An empty result with no stderr remains valid for commands
// whose status 1 means "no matches" (for example, grep -c).

// Run async work over `items` with at most `limit` in flight at once.
export async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await worker(items[idx], idx);
        }
    }
    const n = Math.min(limit, Math.max(1, items.length));
    await Promise.all(Array.from({length: n}, () => run()));
    return results;
}


export function classifyResult({stdout, stderr, exitStatus, spawnFailed, timedOut, timeoutMs}) {
    if (timedOut) {
        const seconds = Math.round((timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS) / 1000);
        return {status: 'error', count: 0, message: `Command timed out after ${seconds} seconds`, lines: []};
    }
    if (spawnFailed || exitStatus === 127) {
        const reason = stripAnsi(stderr).trim().split('\n')[0] || 'command not found';
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    if (exitStatus !== 0 && exitStatus !== 100 && stdout.trim() !== '') {
        const reason = stripAnsi(stderr).trim().split('\n')[0] ||
            `Command exited with status ${exitStatus} after producing output`;
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    if (stdout.trim() === '' && stderr.trim() !== '' && exitStatus !== 0) {
        const reason = stripAnsi(stderr).trim().split('\n')[0];
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    const lines = stripAnsi(stdout).split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return {status: 'ok', count: lines.length, message: '', lines};
}


// Filter exact package/app identifiers from a successful source result. The first
// whitespace-delimited token is the identifier for common DNF, Flatpak, Cargo,
// npm, and CLI output formats. Errors are preserved so ignores never hide a
// broken check or imply that a source is healthy.
export function filterIgnoredPackages(result, ignoredPackages = []) {
    if (!result || result.status !== 'ok' || !Array.isArray(result.lines))
        return result;
    const ignored = new Set(ignoredPackages.map(name => String(name).trim()).filter(Boolean));
    if (ignored.size === 0)
        return result;
    const lines = result.lines.filter(line => !ignored.has((String(line).trim().split(/\s+/)[0] || '')));
    return {...result, count: lines.length, lines};
}


// Choose a timer cadence that can service the shortest configured source interval.
// The per-source cache still decides which sources are actually due on each tick.
export function getPollingIntervalMinutes(globalMinutes, sources, intervals) {
    const fallback = Number.isFinite(globalMinutes) && globalMinutes > 0 ? globalMinutes : 1;
    const effective = sources
        .map(source => intervals.get(source.name) ?? fallback)
        .filter(minutes => Number.isFinite(minutes) && minutes > 0);
    return Math.max(1, Math.min(fallback, ...effective));
}


// Validate a versioned JSON source backup before replacing user configuration.
export function validateSourceBackup(payload, fallbackInterval = 60) {
    if (!payload || payload.format !== 'update-checker-sources' || payload.version !== 1 ||
        !Array.isArray(payload.sources) || payload.sources.length > 100)
        throw new Error('Unsupported backup format or source count (maximum 100).');

    const defaultInterval = Number.isSafeInteger(fallbackInterval) &&
        fallbackInterval >= 5 && fallbackInterval <= 1440 ? fallbackInterval : 60;
    const names = new Set();
    return payload.sources.map((source, index) => {
        if (!source || typeof source.name !== 'string' ||
            typeof source.command !== 'string' ||
            typeof (source.updateCommand ?? '') !== 'string')
            throw new Error(`Source ${index + 1} has invalid fields.`);

        const name = source.name.trim();
        const command = source.command.trim();
        const updateCommand = (source.updateCommand ?? '').trim();
        const interval = source.intervalMinutes ?? defaultInterval;
        if (!name || name.includes('|') || !command)
            throw new Error(`Source ${index + 1} needs a name and check command; names cannot contain |.`);
        if (names.has(name))
            throw new Error(`Duplicate source name: ${name}`);
        names.add(name);
        if (!Number.isSafeInteger(interval) || interval < 5 || interval > 1440)
            throw new Error(`Source “${name}” has an invalid interval (5–1440 minutes required).`);
        if (source.enabled !== undefined && typeof source.enabled !== 'boolean')
            throw new Error(`Source “${name}” has an invalid enabled flag.`);
        return {name, command, updateCommand, interval, enabled: source.enabled !== false};
    });
}


export function parseSources(strv) {
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
export function parseUpdateCommands(strv) {
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
export function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return (str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}


// Truncates with an ellipsis, consistently, everywhere a message could
// otherwise be long enough to stretch the whole popup menu wide. Keep
// this short - it's the character budget for the WHOLE displayed
// string, not just this piece, so callers should account for any
// prefix (icon glyph, "source name - failed:", etc.) they add on top.
export function truncate(str, max) {
    const s = (str || '').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}


export function parseIntervals(strv) {
    const map = new Map();
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1) continue;
        const name = entry.slice(0, idx).trim();
        const rawValue = entry.slice(idx + 1).trim();
        // Reject malformed intervals instead of accepting a numeric prefix.
        if (!/^\d+$/.test(rawValue))
            continue;
        const val = Number(rawValue);
        if (name && Number.isSafeInteger(val) && val >= 5) map.set(name, val);
    }
    return map;
}


export function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


export function lightenHex(hex, amount = 0x14) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    let r = Math.min(255, parseInt(h.slice(0, 2), 16) + amount);
    let g = Math.min(255, parseInt(h.slice(2, 4), 16) + amount);
    let b = Math.min(255, parseInt(h.slice(4, 6), 16) + amount);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
