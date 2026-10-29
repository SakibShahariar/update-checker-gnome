import System from 'system';
import {
    runShell,
    getPollingIntervalMinutes,
    mapPool,
    classifyResult,
    filterIgnoredPackages,
    parseSources,
    parseUpdateCommands,
    parseIntervals,
    validateSourceBackup,
    stripAnsi,
    truncate,
    hexToRgba,
    lightenHex,
} from '../lib/utils.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function equal(actual, expected, message) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
    equal(parseSources([
        ' DNF | dnf check-update ',
        'invalid',
        '|missing-name',
        'missing-command| ',
        'Custom|printf "a|b"',
    ]), [
        {name: 'DNF', command: 'dnf check-update'},
        {name: 'Custom', command: 'printf "a|b"'},
    ], 'source parsing should trim fields, reject malformed entries, and preserve later pipes');

    equal(validateSourceBackup({
        format: 'update-checker-sources',
        version: 1,
        sources: [
            {name: ' DNF ', command: ' dnf check-update ', updateCommand: ' dnf upgrade ', intervalMinutes: 30, enabled: false},
            {name: 'Flatpak', command: 'flatpak remote-ls --updates'},
        ],
    }, 60), [
        {name: 'DNF', command: 'dnf check-update', updateCommand: 'dnf upgrade', interval: 30, enabled: false},
        {name: 'Flatpak', command: 'flatpak remote-ls --updates', updateCommand: '', interval: 60, enabled: true},
    ], 'source backup validation should normalize fields and preserve per-source options');

    for (const [payload, expected] of [
        [{format: 'other', version: 1, sources: []}, 'Unsupported backup format'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf'}, {name: 'DNF', command: 'dnf'}]}, 'Duplicate source name'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'Bad|Name', command: 'dnf'}]}, 'names cannot contain'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', intervalMinutes: 4}]}, 'invalid interval'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', enabled: 'no'}]}, 'invalid enabled flag'],
    ]) {
        let error = '';
        try { validateSourceBackup(payload); } catch (e) { error = String(e.message); }
        assert(error.includes(expected), `invalid source backup should be rejected: expected "${expected}", got "${error}"`);
    }

    equal(getPollingIntervalMinutes(60, [{name: 'DNF'}, {name: 'Flatpak'}],
        new Map([['DNF', 5], ['Flatpak', 15]])), 5,
    'scheduler cadence must honor the shortest configured source interval');

    equal(getPollingIntervalMinutes(60, [{name: 'DNF'}, {name: 'Flatpak'}],
        new Map([['DNF', 120]])), 60,
    'global interval remains the maximum polling cadence when source intervals are longer');

    equal(getPollingIntervalMinutes(60, [], new Map()), 60,
    'scheduler should fall back to the global interval when no sources are configured');

    const updateCommands = parseUpdateCommands([
        'DNF|dnf upgrade',
        'Flatpak|flatpak update',
        'DNF|dnf upgrade --refresh',
    ]);
    equal([...updateCommands.entries()], [
        ['DNF', 'dnf upgrade --refresh'],
        ['Flatpak', 'flatpak update'],
    ], 'update commands should be keyed by source name, with the last duplicate winning');

    equal([...parseIntervals(['DNF|60', 'Cargo|1440', 'Bad|4', 'broken', 'Nope|abc', 'Suffix|60minutes', 'Decimal|5.5']).entries()],
        [['DNF', 60], ['Cargo', 1440]],
        'interval parsing should reject malformed and too-short intervals');

    // Representative one-line-per-update output from the default DNF filter
    // and Flatpak remote-ls command. These fixtures model filtered stdout.
    const dnfFixture = [
        'bash.x86_64 5.2.26-3.fc43 updates',
        'kernel-core.x86_64 6.17.12-300.fc43 updates',
        'firefox.x86_64 145.0-1.fc43 updates',
    ].join('\n') + '\n';
    const dnfFixtureResult = classifyResult({
        stdout: dnfFixture, stderr: '', exitStatus: 100, spawnFailed: false, timedOut: false,
    });
    equal(dnfFixtureResult, {
        status: 'ok', count: 3, message: '', lines: dnfFixture.trim().split('\n'),
    }, 'DNF filtered package rows should count one update per output line');
    equal(filterIgnoredPackages(dnfFixtureResult, ['bash.x86_64']), {
        status: 'ok', count: 2, message: '', lines: [
            'kernel-core.x86_64 6.17.12-300.fc43 updates',
            'firefox.x86_64 145.0-1.fc43 updates',
        ],
    }, 'ignoring a DNF package should remove only its exact first-token identifier and recalculate count');

    const flatpakFixture = [
        'org.mozilla.firefox stable flathub 145.0',
        'org.gnome.Calculator stable flathub 49.1',
    ].join('\n') + '\n';
    equal(classifyResult({
        stdout: flatpakFixture, stderr: '', exitStatus: 0, spawnFailed: false, timedOut: false,
    }), {
        status: 'ok', count: 2, message: '', lines: flatpakFixture.trim().split('\n'),
    }, 'Flatpak remote-ls update rows should count one app per output line');

    equal(classifyResult({
        stdout: '\u001b[32mfoo\u001b[0m\nbar\n',
        stderr: '',
        exitStatus: 100,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'ok', count: 2, message: '', lines: ['foo', 'bar']},
    'non-zero package-manager status with output should still count updates');

    equal(classifyResult({
        stdout: 'partial update list\\n',
        stderr: 'repository metadata download failed',
        exitStatus: 2,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'error', count: 0, message: 'repository metadata download failed', lines: []},
    'partial stdout from a failed command must not be counted as pending updates');

    equal(classifyResult({
        stdout: 'partial update list\\n',
        stderr: '',
        exitStatus: 2,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'error', count: 0, message: 'Command exited with status 2 after producing output', lines: []},
    'failed commands without stderr must still not make partial stdout look successful');

    equal(classifyResult({
        stdout: '',
        stderr: '',
        exitStatus: 1,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'ok', count: 0, message: '', lines: []},
    'empty no-match results remain valid for commands that use status 1 for no matches');

    equal(filterIgnoredPackages(
        {status: 'ok', count: 3, message: '', lines: ['firefox.x86_64 1 2', 'org.example.App stable 2', 'kernel-core.x86_64 3 4']},
        ['firefox.x86_64', 'org.example.App']
    ), {status: 'ok', count: 1, message: '', lines: ['kernel-core.x86_64 3 4']},
    'ignored identifiers should be removed exactly and the count recalculated');

    const sourceError = {status: 'error', count: 0, message: 'network unavailable', lines: []};
    assert(filterIgnoredPackages(sourceError, ['anything']) === sourceError,
        'ignored identifiers must not hide source errors');
    equal(filterIgnoredPackages(
        {status: 'ok', count: 1, message: '', lines: ['firefox.x86_64 1 2']},
        ['firefox']
    ), {status: 'ok', count: 1, message: '', lines: ['firefox.x86_64 1 2']},
    'ignore matching must be exact rather than matching package-name prefixes');

    equal(classifyResult({
        stdout: '',
        stderr: '\u001b[31mnetwork unavailable\u001b[0m',
        exitStatus: 1,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'error', count: 0, message: 'network unavailable', lines: []},
    'stderr-only failures should be reported');

    equal(classifyResult({
        stdout: 'stale result',
        stderr: '',
        exitStatus: -1,
        spawnFailed: false,
        timedOut: true,
        timeoutMs: 2500,
    }), {status: 'error', count: 0, message: 'Command timed out after 3 seconds', lines: []},
    'timeouts must not be presented as an empty update list');

    assert(stripAnsi('\u001b[1;31mred\u001b[0m') === 'red',
        'ANSI escapes should be stripped');
    assert(truncate('  a long message  ', 8) === 'a long …',
        'truncation should trim and stay within the requested character budget');
    assert(hexToRgba('#abc', 0.5) === 'rgba(170, 187, 204, 0.5)',
        'three-digit hex colors should expand correctly');
    assert(lightenHex('#f0f0f0') === '#ffffff',
        'lightenHex should clamp channels at white');

    let activeWorkers = 0;
    let peakWorkers = 0;
    const mapped = await mapPool([1, 2, 3, 4, 5], 2, async value => {
        activeWorkers++;
        peakWorkers = Math.max(peakWorkers, activeWorkers);
        await Promise.resolve();
        activeWorkers--;
        return value * 2;
    });
    equal(mapped, [2, 4, 6, 8, 10],
        'mapPool should preserve input order and return every worker result');
    assert(peakWorkers === 2,
        'mapPool should respect its configured concurrency limit');

    const ok = await runShell("printf 'first\\nsecond\\n'");
    assert(!ok.spawnFailed && !ok.timedOut && ok.exitStatus === 0,
        'runShell should complete a successful command');
    equal(ok.stdout, 'first\nsecond\n', 'runShell should capture stdout');

    const failed = await runShell("printf 'expected failure' >&2; exit 2");
    assert(!failed.spawnFailed && failed.exitStatus === 2,
        'runShell should preserve non-zero exit statuses');
    assert(failed.stderr.includes('expected failure'),
        'runShell should capture stderr');

    const started = Date.now();
    const timed = await runShell('sleep 10', 100);
    const elapsed = Date.now() - started;
    assert(timed.timedOut, 'runShell should mark a long-running command as timed out');
    assert(elapsed < 3000,
        `timed-out commands should settle promptly (took ${elapsed}ms)`);

    print('All utility tests passed.');
}

main().catch(error => {
    printerr(error.stack ?? String(error));
    System.exit(1);
});
