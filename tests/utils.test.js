import System from 'system';
import {
    runShell,
    classifyResult,
    parseSources,
    parseUpdateCommands,
    parseIntervals,
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

    const updateCommands = parseUpdateCommands([
        'DNF|dnf upgrade',
        'Flatpak|flatpak update',
        'DNF|dnf upgrade --refresh',
    ]);
    equal([...updateCommands.entries()], [
        ['DNF', 'dnf upgrade --refresh'],
        ['Flatpak', 'flatpak update'],
    ], 'update commands should be keyed by source name, with the last duplicate winning');

    equal([...parseIntervals(['DNF|60', 'Cargo|1440', 'Bad|4', 'broken', 'Nope|abc']).entries()],
        [['DNF', 60], ['Cargo', 1440]],
        'interval parsing should reject malformed and too-short intervals');

    equal(classifyResult({
        stdout: '\u001b[32mfoo\u001b[0m\nbar\n',
        stderr: '',
        exitStatus: 100,
        spawnFailed: false,
        timedOut: false,
    }), {status: 'ok', count: 2, message: '', lines: ['foo', 'bar']},
    'non-zero package-manager status with output should still count updates');

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
    assert(truncate('  a long message  ', 8) === 'a long m…',
        'truncation should trim and stay within the requested character budget');
    assert(hexToRgba('#abc', 0.5) === 'rgba(170, 187, 204, 0.5)',
        'three-digit hex colors should expand correctly');
    assert(lightenHex('#f0f0f0') === '#ffffff',
        'lightenHex should clamp channels at white');

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
