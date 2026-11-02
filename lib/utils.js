import Gio from 'gi://Gio';
import GLib from 'gi://GLib';



// Run `sh -c command`, resolving with stdout, stderr, and the exit
// status. We never reject on non-zero exit - many tools (e.g. `dnf
// check-update`) exit non-zero simply because updates ARE available -
// so the caller decides what a given exit code/output combo means.
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// Background mode elevates the complete shell command. Reject chained commands
// with an elevation prefix rather than silently running later user-scoped steps
// (notably Flatpak) as root. Simple privileged commands remain supported.
export function hasMixedPrivilegeCommand(command) {
    const hasElevation = /(?:^|\s)(?:doas|sudo|pkexec)\s+/.test(command);
    const hasShellComposition = /(?:&&|\|\||[;|])/.test(command);
    return hasElevation && hasShellComposition;
}
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


export function redactDiagnosticOutput(value) {
    return String(value ?? '')
        .replace(/([?&](?:password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential|signature|sig|x-amz-credential)=[^&#\s]*)/gi,
            match => match.replace(/=.*/, '=[REDACTED]'))
        .replace(/\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;&?#]+/gi, '$1=[REDACTED]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,})\b/g, '[REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
        .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, 'https://[REDACTED]@')
        .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
        .replace(/\r/g, '')
        .slice(0, 20000);
}

export function classifyResult({stdout, stderr, exitStatus, spawnFailed, timedOut, cancelled, timeoutMs, successExitCodes}) {
    if (cancelled)
        return {status: 'cancelled', count: 0, message: 'Check cancelled', lines: []};

    const stdoutText = stripAnsi(String(stdout ?? ''));
    const stderrText = stripAnsi(String(stderr ?? ''));
    const diagnosticText = [
        stdoutText.trim() ? 'stdout:\n' + stdoutText.trim() : '',
        stderrText.trim() ? 'stderr:\n' + stderrText.trim() : '',
    ].filter(Boolean).join('\n\n');
    const errorResult = message => ({
        status: 'error',
        count: 0,
        message: redactDiagnosticOutput(message).split('\n')[0],
        details: redactDiagnosticOutput(diagnosticText || message),
        lines: [],
    });

    if (spawnFailed)
        return errorResult('Could not start command (is the command installed?)');
    if (timedOut)
        return errorResult('Command timed out after ' +
            Math.ceil((timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS) / 1000) + ' seconds');
    if (exitStatus === 127)
        return errorResult('Command not found (exit 127)');

    const acceptedExitCodes = new Set([0, ...(Array.isArray(successExitCodes) ? successExitCodes : [100])]);
    const noMatches = exitStatus === 1 && stdoutText.trim() === '' && stderrText.trim() === '';
    if (!acceptedExitCodes.has(exitStatus) && !noMatches) {
        const reason = stripAnsi(stderrText).trim().split('\n')[0] ||
            (stdoutText.trim()
                ? 'Command exited with status ' + exitStatus + ' after producing output'
                : 'Command exited with status ' + exitStatus);
        return errorResult(reason);
    }

    const lines = stripAnsi(stdoutText).split('\n').map(line => line.trim()).filter(Boolean);
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

// Return the earliest due time across enabled sources. A source that has
// never been checked is due immediately; the caller formats the timestamp.
export function getNextSourceCheckAt(sources, globalMinutes, intervals, lastPolls, nowMs = Date.now()) {
    if (!Array.isArray(sources) || sources.length === 0)
        return null;
    const fallback = Number.isFinite(globalMinutes) && globalMinutes > 0 ? globalMinutes : 1;
    const dueTimes = sources.map(source => {
        const configured = intervals?.get(source.name);
        const interval = Number.isFinite(configured) && configured > 0 ? configured : fallback;
        const lastPoll = lastPolls?.get(source.name);
        return Number.isFinite(lastPoll) && lastPoll > 0
            ? lastPoll + interval * 60 * 1000
            : nowMs;
    });
    return Math.min(...dueTimes);
}

// Return only newly discovered security updates when notification policy
// allows them. A negative previous count denotes the initial baseline.
export function getSecurityNotificationDelta(previous, current, {
    enabled = false, quietHours = false, snoozed = false, failed = false,
} = {}) {
    if (!enabled || quietHours || snoozed || failed ||
        !Number.isSafeInteger(previous) || previous < 0 ||
        !Number.isSafeInteger(current) || current <= previous)
        return 0;
    return current - previous;
}

const DEFAULT_SECURITY_ADVISORY_PATTERN =
    '(?:FEDORA|RHSA|RHEA|RHBA|ALSA|USN|CVE)[-:]?[0-9]|critical|important|moderate|low|security';

// Extract several distinct advisory lines. Invalid custom regexes safely fall
// back to the built-in distribution-neutral identifiers and severity terms.
export function parseSecurityAdvisories(output, pattern = DEFAULT_SECURITY_ADVISORY_PATTERN, limit = 5) {
    let matcher;
    try {
        matcher = new RegExp(pattern || DEFAULT_SECURITY_ADVISORY_PATTERN, 'i');
    } catch (e) {
        matcher = new RegExp(DEFAULT_SECURITY_ADVISORY_PATTERN, 'i');
    }
    const seen = new Set();
    const max = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 10) : 5;
    return String(output ?? '').split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => {
            if (!line || seen.has(line) || !matcher.test(line))
                return false;
            seen.add(line);
            return true;
        })
        .slice(0, max);
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
        const timeoutSeconds = source.timeoutSeconds ?? 120;
        if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600)
            throw new Error(`Source “${name}” has an invalid timeout (5–600 seconds required).`);
        const successExitCodes = source.successExitCodes ?? '';
        if (typeof successExitCodes !== 'string' ||
            (successExitCodes && parseExitCodeList(successExitCodes) === null))
            throw new Error(`Source “${name}” has invalid success exit codes (use comma-separated values from 0 to 255).`);
        return {name, command, updateCommand, interval, timeoutSeconds, successExitCodes, enabled: source.enabled !== false};
    });
}


// Replace today's snapshot, prune entries older than seven days, and cap storage.
export function updateDailyHistory(history, entry, nowUnix = Math.floor(Date.now() / 1000)) {
    const cutoff = nowUnix - 7 * 24 * 60 * 60;
    const valid = (Array.isArray(history) ? history : []).filter(item =>
        item && typeof item.date === 'string' &&
        Number.isSafeInteger(item.timestamp) && item.timestamp >= cutoff &&
        item.timestamp <= nowUnix && Number.isSafeInteger(item.total) && item.total >= 0 &&
        Array.isArray(item.sources));
    if (!entry || typeof entry.date !== 'string' ||
        !Number.isSafeInteger(entry.timestamp) || entry.timestamp < cutoff ||
        entry.timestamp > nowUnix || !Number.isSafeInteger(entry.total) || entry.total < 0 ||
        !Array.isArray(entry.sources))
        return valid.sort((a, b) => a.timestamp - b.timestamp).slice(-7);
    const index = valid.findIndex(item => item.date === entry.date);
    if (index >= 0)
        valid[index] = entry;
    else
        valid.push(entry);
    return valid.sort((a, b) => a.timestamp - b.timestamp).slice(-7);
}


// Select only sources with a fresh-enough successful positive count and an update command.
export function getUpdatableSources(sources, results, commands) {
    return sources.filter(source => {
        const result = results.find(item => item.name === source.name);
        return result && !result.checking && result.status === 'ok' &&
            Number.isSafeInteger(result.count) && result.count > 0 && commands.has(source.name);
    }).map(source => ({name: source.name, command: commands.get(source.name)}));
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

// Distinguish an empty configuration, malformed source entries, and a
// configuration where every valid source has been intentionally disabled.
export function getSourceConfigurationState(sourceLines, disabledNames) {
    const configuredLines = sourceLines.filter(line => line.trim());
    if (configuredLines.length === 0)
        return 'empty';

    const sources = parseSources(configuredLines);
    if (sources.length === 0)
        return 'invalid';

    return sources.every(source => disabledNames.has(source.name))
        ? 'disabled'
        : 'ready';
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

// Per-source command timeout overrides, stored as "Name|seconds" entries.
export function parseSourceTimeouts(strv) {
    const map = new Map();
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1)
            continue;
        const name = entry.slice(0, idx).trim();
        const rawValue = entry.slice(idx + 1).trim();
        if (!/^\d+$/.test(rawValue))
            continue;
        const seconds = Number(rawValue);
        if (name && Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 600)
            map.set(name, seconds);
    }
    return map;
}


// Parse a comma-separated list of process exit codes (0–255).
export function parseExitCodeList(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.trim();
    if (!text)
        return [];
    const parts = text.split(',').map(part => part.trim());
    if (parts.some(part => !/^\d+$/.test(part)))
        return null;
    const codes = parts.map(Number);
    if (codes.some(code => !Number.isSafeInteger(code) || code < 0 || code > 255))
        return null;
    return [...new Set(codes)];
}

// Per-source success exit-code overrides, stored as "Name|0,100" entries.
export function parseSourceExitCodes(strv) {
    const map = new Map();
    for (const entry of strv) {
        const idx = entry.indexOf('|');
        if (idx === -1)
            continue;
        const name = entry.slice(0, idx).trim();
        const codes = parseExitCodeList(entry.slice(idx + 1));
        if (name && codes && codes.length > 0)
            map.set(name, codes);
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


export async function runWorkerSafely(worker, onError) {
    try {
        return await worker();
    } catch (error) {
        if (typeof error?.matches === 'function' &&
            error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
            return {status: 'cancelled', count: 0, message: 'Check cancelled', lines: []};
        return onError(error);
    }
}
