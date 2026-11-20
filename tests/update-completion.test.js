// #84: live end-to-end test of the real background update-completion path.
// Drives the ACTUAL runInBackground() from updates.js with a real setsid
// subprocess and a mock indicator, verifying: entry tracked, process runs,
// completion fires, poll/result cache invalidated, and checkNow triggered.
// GNOME Shell's Main module is stubbed via a registered GResource so updates.js
// can be imported outside the shell. Skips gracefully if tooling is missing.
import System from 'system';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

// Register a minimal GNOME Shell Main stub (notify / notifyError) before importing
// updates.js, which does `import * as Main from 'resource:///org/gnome/shell/ui/main.js'`.
function registerMainStub() {
    const src = 'export const notify = () => {}; export const notifyError = () => {};';
    const tmpDir = GLib.dir_make_tmp(null);
    const srcFile = GLib.build_filenamev([tmpDir, 'main.js']);
    GLib.file_set_contents(srcFile, src);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gresources><gresource prefix="/org/gnome/shell/ui"><file>main.js</file></gresource></gresources>`;
    const xmlFile = GLib.build_filenamev([tmpDir, 'stub.gresource.xml']);
    const outFile = GLib.build_filenamev([tmpDir, 'stub.gresource']);
    GLib.file_set_contents(xmlFile, xml);
    const proc = Gio.Subprocess.new(
        ['/usr/bin/glib-compile-resources', xmlFile, `--target=${outFile}`, `--sourcedir=${tmpDir}`],
        Gio.SubprocessFlags.NONE);
    proc.wait(null);
    if (proc.get_exit_status() !== 0)
        throw new Error('failed to compile Main stub resource');
    Gio.resources_register(Gio.Resource.load(outFile));
}

async function main() {
    if (!GLib.find_program_in_path('setsid') || !GLib.find_program_in_path('glib-compile-resources')) {
        print('update-completion integration test skipped (tooling unavailable).');
        return;
    }
    registerMainStub();
    const {runInBackground} = await import('../lib/updates.js');

    return new Promise((resolve, reject) => {
        const loop = GLib.MainLoop.new(null, false);
        let checkNowCalls = 0;
        const indicator = {
            _destroyed: false,
            _updatingSources: new Map(),
            _sourceRowWidgets: new Map([['Test', {}]]),  // canUpdateIndicatorUi needs it
            _lastSourcePoll: new Map([['Test', 12345]]),
            _lastSourceResults: new Map([['Test', {status: 'ok', count: 9}]]),
            _updateAllQueue: null,
            _settings: {get_boolean: () => false, get_string: () => ''},
            _updateSyncIconState: () => {},
            _setRowUpdating: () => {},
            checkNow: () => { checkNowCalls++; },
            _advanceUpdateAllQueue: () => {},
        };
        // A fast, harmless real subprocess. No privilege prefix -> runs as user.
        runInBackground(indicator, 'true', 'Test');

        assert(indicator._updatingSources.has('Test'),
            'runInBackground should track the entry before the process completes');

        // Poll until the completion callback has run (cache invalidated).
        let waited = 0;
        const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            waited += 100;
            const done = indicator._lastSourcePoll.size === 0 && checkNowCalls > 0;
            if (!done && waited < 5000)
                return GLib.SOURCE_CONTINUE;
            GLib.source_remove(pollId);
            try {
                assert(done, 'completion should invalidate cache and trigger checkNow');
                assert(!indicator._updatingSources.has('Test'),
                    'completion should remove the tracked entry');
                assert(checkNowCalls >= 1, 'completion should trigger a re-check');
                print('update-completion integration test passed.');
                resolve();
            } catch (e) {
                reject(e);
            }
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
    });
}

main().catch(error => {
    printerr(error.stack ?? String(error));
    System.exit(1);
});
