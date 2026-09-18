import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';



// Run `sh -c command`, resolving with stdout, stderr, and the exit
// status. We never reject on non-zero exit - many tools (e.g. `dnf
// check-update`) exit non-zero simply because updates ARE available -
// so the caller decides what a given exit code/output combo means.
export function runShell(command) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc_, res) => {
                try {
                    const [, stdout, stderr] = proc_.communicate_utf8_finish(res);
                    resolve({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitStatus: proc_.get_exit_status(),
                        spawnFailed: false,
                    });
                } catch (e) {
                    resolve({stdout: '', stderr: String(e), exitStatus: -1, spawnFailed: true});
                }
            });
        } catch (e) {
            resolve({stdout: '', stderr: String(e), exitStatus: -1, spawnFailed: true});
        }
    });
}


// Classify a source's result. We deliberately don't treat "non-zero
// exit" alone as failure, since plenty of check-only commands (dnf,
// grep -c, etc.) use non-zero to mean "found something", not "broke".
// Only two things get flagged as a real error:
//  - the shell couldn't even run the command (missing binary: exit 127,
//    or the subprocess failed to spawn at all)
//  - the command produced no stdout AND wrote to stderr AND exited
//    non-zero - i.e. it looks like it broke, not like it found nothing

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


export function classifyResult({stdout, stderr, exitStatus, spawnFailed}) {
    if (spawnFailed || exitStatus === 127) {
        const reason = stripAnsi(stderr).trim().split('\n')[0] || 'command not found';
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    if (stdout.trim() === '' && stderr.trim() !== '' && exitStatus !== 0) {
        const reason = stripAnsi(stderr).trim().split('\n')[0];
        return {status: 'error', count: 0, message: reason, lines: []};
    }
    const lines = stripAnsi(stdout).split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return {status: 'ok', count: lines.length, message: '', lines};
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
        const val = parseInt(entry.slice(idx + 1).trim(), 10);
        if (name && Number.isFinite(val) && val >= 5) map.set(name, val);
    }
    return map;
}


export function sparkline(values) {
    if (!values || values.length === 0) return '';
    const blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    return values.map(v => blocks[Math.round(((v - min) / range) * (blocks.length - 1))]).join('');
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


export function hasMotion() {
    try {
        const stSettings = St.Settings.get();
        if (stSettings && 'enable_animations' in stSettings && stSettings.enable_animations === false)
            return false;
        if (St.ReducedMotion) {
            const {reducedMotion} = stSettings;
            if (reducedMotion === St.ReducedMotion.REDUCE) return false;
        }
    } catch (e) {}
    try {
        const clutterSettings = Clutter.Settings.get_default?.();
        if (clutterSettings && 'enable_animations' in clutterSettings && clutterSettings.enable_animations === false)
            return false;
    } catch (e) {}
    return true;
}

export function shouldAnimate() { return hasMotion(); }
