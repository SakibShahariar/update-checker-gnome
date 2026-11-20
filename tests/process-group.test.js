// #84: live process-group start/stop integration test.
// Verifies that a subprocess launched under `setsid` (as the extension launches
// check/update commands) can be terminated via a process-group signal — the
// exact mechanism used by runShell's timeout/cancel and by the update stop path.
// This needs real subprocesses, so it runs as its own gjs program with a main
// loop rather than inside the synchronous utils suite.
import System from 'system';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function signalProcessGroup(proc, signal) {
    const identifier = proc.get_identifier();
    if (!identifier || !/^\d+$/.test(identifier))
        return false;
    try {
        const killer = Gio.Subprocess.new(
            ['/usr/bin/kill', `-${signal}`, '--', `-${identifier}`],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        killer.wait_async(null, (k, res) => { try { k.wait_finish(res); } catch (e) {} });
        return true;
    } catch (e) {
        return false;
    }
}

function main() {
    return new Promise((resolve, reject) => {
        // Skip gracefully if the platform lacks the process utilities this
        // integration test relies on (e.g. a minimal CI container without
        // util-linux). The production code handles their absence separately.
        if (!GLib.find_program_in_path('setsid') || !GLib.find_program_in_path('kill')) {
            print('process-group integration test skipped (setsid/kill unavailable).');
            resolve();
            return;
        }
        const loop = GLib.MainLoop.new(null, false);
        const proc = Gio.Subprocess.new(['/usr/bin/setsid', 'sh', '-c', 'sleep 30'],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        const pid = proc.get_identifier();
        if (!pid || !/^\d+$/.test(pid)) {
            try { proc.force_exit(); } catch (e) {}
            reject(new Error('subprocess has no numeric PID'));
            return;
        }
        assert(signalProcessGroup(proc, 'TERM'), 'TERM signal should be dispatched');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const stillAlive = GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
            try { proc.force_exit(); } catch (e) {}
            loop.quit();
            if (stillAlive)
                reject(new Error('process group survived TERM signal'));
            else
                resolve();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
    });
}

main().then(() => {
    print('process-group integration test passed.');
}).catch(error => {
    printerr(error.stack ?? String(error));
    System.exit(1);
});
