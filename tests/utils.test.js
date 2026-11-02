import System from 'system';
import GLib from 'gi://GLib';
import {sanitizeMatugenColor} from '../lib/theming.js';
import {buildSummarySnapshot, redactSummaryError} from '../lib/summary.js';
import {
    runShell,
    classifySubprocessExit,
    hasMixedPrivilegeCommand,
    getSourceConfigurationState,
    parseSourceTimeouts,
    parseExitCodeList,
    parseSourceExitCodes,
    runWorkerSafely,
    cancelAllShellCommands,
    getPollingIntervalMinutes,
    getNextSourceCheckAt,
    getSecurityNotificationDelta,
    parseSecurityAdvisories,
    mapPool,
    classifyResult,
    filterIgnoredPackages,
    parseSources,
    parseUpdateCommands,
    parseIntervals,
    updateDailyHistory,
    getUpdatableSources,
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

function testSummarySnapshot() {
    const checkedAt = Date.parse('2026-10-29T12:30:00.000Z');
    const snapshot = buildSummarySnapshot({
        results: [
            {name: 'DNF', status: 'ok', count: 2, cached: false},
            {name: 'Flatpak', status: 'error', count: 0, cached: true,
                message: 'token=secret-value /home/alice/.config/app'},
        ],
        sourcePolls: new Map([['DNF', checkedAt]]),
        total: 2, securityCount: 1, lastCheck: '12:30',
        busy: false, rebootRequired: true, offline: false,
        onBattery: true, networkMetered: false, quietHoursActive: true, failed: true,
    });
    equal(snapshot.version, 1, 'summary schema version should remain stable');
    equal(snapshot.total, 2, 'summary should preserve total count');
    equal(snapshot.securityCount, 1, 'summary should preserve security count');
    equal(snapshot.sources[0].lastChecked, '2026-10-29T12:30:00.000Z',
        'summary should serialize last-check timestamps as ISO strings');
    equal(snapshot.sources[0].error, '', 'successful sources should not publish error text');
    assert(snapshot.sources[1].error.includes('token=[REDACTED]'),
        'summary should redact token-like values');

    const cancelledSnapshot = buildSummarySnapshot({
        results: [{name: 'Cargo', status: 'cancelled', count: 0}],
        total: 0, failed: false,
    });
    equal(cancelledSnapshot.cancelled, true,
        'summary should expose cancelled checks distinctly');
    equal(cancelledSnapshot.failed, false,
        'cancelled checks should not mark the summary as failed');
    equal(cancelledSnapshot.sources[0].error, '',
        'cancelled checks should not publish a failure message');

    const errorSnapshot = buildSummarySnapshot({
        results: [{name: 'DNF', status: 'error', count: 0, message: 'command failed', details: 'password=hidden'}],
        total: 0, failed: true,
    });
    assert(!JSON.stringify(errorSnapshot).includes('password=hidden'),
        'published summaries must not include expanded diagnostic details');
    assert(snapshot.sources[1].error.includes('/home/[USER]'),
        'summary should redact home directory names');
    assert(!snapshot.sources[1].error.includes('secret-value') &&
        !snapshot.sources[1].error.includes('/home/alice'),
        'summary must not retain raw secrets or usernames');
    assert(redactSummaryError('authorization: Bearer123').includes('[REDACTED]'),
        'summary should redact authorization values');
    const bearerError = redactSummaryError('authorization: Bearer abc.def.ghi');
    assert(bearerError.includes('authorization=[REDACTED]') &&
        !bearerError.includes('abc.def.ghi'),
        'summary should redact the full bearer credential, not only the Bearer scheme');
    const queryError = redactSummaryError(
        'request failed: https://api.example.test/v1?access_token=secret123&region=eu&client_secret=hidden456'
    );
    assert(queryError.includes('access_token=[REDACTED]') &&
        queryError.includes('client_secret=[REDACTED]') &&
        queryError.includes('region=eu') &&
        !queryError.includes('secret123') && !queryError.includes('hidden456'),
        'summary should redact query credentials while preserving unrelated parameters');
    const credentials = [
        ['ghp_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
        ['github_pat_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
        ['AIza', '123456789012345678901234567890123'].join(''),
        ['AKIA', '1234567890ABCDEF'].join(''),
        ['xoxb-', '123456789012-123456789012-abcdefghijklmnop'].join(''),
        ['sk_live_', '1234567890abcdefghijkl'].join(''),
        ['eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTYifQ', '.', 'signaturevalue123'].join(''),
    ];
    for (const credential of credentials) {
        const redacted = redactSummaryError(`diagnostic ${credential} still available`);
        assert(!redacted.includes(credential) && redacted.includes('[REDACTED]'),
            'summary should redact common credential formats');
    }
    const safeDiagnostic = redactSummaryError('request failed: status=503 region=eu-west-1 retry=2');
    assert(safeDiagnostic.includes('status=503') && safeDiagnostic.includes('region=eu-west-1') &&
        safeDiagnostic.includes('retry=2'),
        'summary should preserve useful non-secret diagnostic values');
}

testSummarySnapshot();

async function main() {
    equal(classifySubprocessExit({exited: true, exitStatus: 0}),
        {status: 'success', exitStatus: 0},
        'terminal process completion should distinguish a successful command');
    equal(classifySubprocessExit({exited: true, exitStatus: 7}),
        {status: 'failed', exitStatus: 7},
        'terminal process completion should preserve non-zero command exit status');
    equal(classifySubprocessExit({signaled: true, termSignal: 15}),
        {status: 'signaled', termSignal: 15},
        'terminal process completion should identify signal termination');
    equal(classifySubprocessExit(), {status: 'unknown'},
        'terminal process completion should remain unknown when the launcher exposes no outcome');

    for (const command of [
        'doas dnf upgrade -y && flatpak update -y',
        'sudo dnf upgrade -y; npm update',
        'pkexec dnf upgrade -y | tee update.log',
        'env sudo dnf upgrade -y && flatpak update -y',
        'UPDATE_MODE=system doas dnf upgrade -y; flatpak update -y',
    ])
        assert(hasMixedPrivilegeCommand(command),
            `background mode should reject composed elevated commands: ${command}`);
    for (const command of [
        'doas dnf upgrade -y',
        'sudo flatpak update -y',
        'dnf upgrade -y',
        'printf "doas dnf" ',
    ])
        assert(!hasMixedPrivilegeCommand(command),
            `simple or non-elevated commands should remain allowed: ${command}`);

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

    equal(getSourceConfigurationState([], new Set()), 'empty',
        'source configuration should identify an empty source list');
    equal(getSourceConfigurationState(['malformed', '|missing-name', 'missing-command|'], new Set()), 'invalid',
        'source configuration should identify entries that cannot be parsed');
    equal(getSourceConfigurationState(['DNF|dnf check-update', 'Flatpak|flatpak remote-ls --updates'],
        new Set(['DNF', 'Flatpak'])), 'disabled',
    'source configuration should identify when every valid source is disabled');
    equal(getSourceConfigurationState(['DNF|dnf check-update', 'Flatpak|flatpak remote-ls --updates'],
        new Set(['DNF'])), 'ready',
    'source configuration should remain ready when at least one valid source is enabled');

    equal(validateSourceBackup({
        format: 'update-checker-sources',
        version: 1,
        sources: [
            {name: ' DNF ', command: ' dnf check-update ', updateCommand: ' dnf upgrade ', intervalMinutes: 30, timeoutSeconds: 240, successExitCodes: '0,100', enabled: false},
            {name: 'Flatpak', command: 'flatpak remote-ls --updates'},
        ],
    }, 60), [
        {name: 'DNF', command: 'dnf check-update', updateCommand: 'dnf upgrade', interval: 30, timeoutSeconds: 240, successExitCodes: '0,100', enabled: false},
        {name: 'Flatpak', command: 'flatpak remote-ls --updates', updateCommand: '', interval: 60, timeoutSeconds: 120, successExitCodes: '', enabled: true},
    ], 'source backup validation should normalize fields and preserve per-source options');

    for (const [payload, expected] of [
        [{format: 'other', version: 1, sources: []}, 'Unsupported backup format'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf'}, {name: 'DNF', command: 'dnf'}]}, 'Duplicate source name'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'Bad|Name', command: 'dnf'}]}, 'names cannot contain'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', intervalMinutes: 4}]}, 'invalid interval'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', enabled: 'no'}]}, 'invalid enabled flag'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', timeoutSeconds: 4}]}, 'invalid timeout'],
        [{format: 'update-checker-sources', version: 1, sources: [{name: 'DNF', command: 'dnf', successExitCodes: '0,256'}]}, 'invalid success exit codes'],
    ]) {
        let error = '';
        try { validateSourceBackup(payload); } catch (e) { error = String(e.message); }
        assert(error.includes(expected), `invalid source backup should be rejected: expected "${expected}", got "${error}"`);
    }

    const historyNow = 1_800_000_000;
    const historyEntry = {
        date: '2027-01-15', timestamp: historyNow, total: 4, securityCount: 1,
        sources: [{name: 'DNF', count: 3}, {name: 'Flatpak', count: 1}],
    };
    equal(updateDailyHistory([], historyEntry, historyNow), [historyEntry],
        'daily history should add a successful snapshot');
    equal(updateDailyHistory([{...historyEntry, total: 2}], historyEntry, historyNow), [historyEntry],
        'daily history should replace the same date rather than duplicate it');
    const oldHistory = Array.from({length: 9}, (_, index) => ({
        date: `2027-01-${String(index + 1).padStart(2, '0')}`,
        timestamp: historyNow - (9 - index) * 24 * 60 * 60,
        total: index, sources: [],
    }));
    const prunedHistory = updateDailyHistory(oldHistory, historyEntry, historyNow);
    assert(prunedHistory.length <= 7 && prunedHistory.every(item => item.timestamp >= historyNow - 7 * 24 * 60 * 60),
        'daily history must prune entries older than seven days and remain bounded');

    equal(getUpdatableSources(
        [{name: 'DNF'}, {name: 'Flatpak'}, {name: 'Cargo'}, {name: 'Broken'}, {name: 'Checking'}],
        [
            {name: 'DNF', status: 'ok', count: 2},
            {name: 'Flatpak', status: 'ok', count: 0},
            {name: 'Cargo', status: 'ok', count: 1},
            {name: 'Broken', status: 'error', count: 0},
            {name: 'Checking', status: 'ok', count: 3, checking: true},
        ],
        new Map([['DNF', 'dnf upgrade'], ['Cargo', 'cargo install-update -a'], ['Broken', 'broken update'], ['Checking', 'check update']])
    ), [
        {name: 'DNF', command: 'dnf upgrade'},
        {name: 'Cargo', command: 'cargo install-update -a'},
    ], 'Update all selection should skip zero-count, failed, checking, and commandless sources');

    equal(getPollingIntervalMinutes(60, [{name: 'DNF'}, {name: 'Flatpak'}],
        new Map([['DNF', 5], ['Flatpak', 15]])), 5,
    'scheduler cadence must honor the shortest configured source interval');

    const scheduleNow = Date.parse('2026-11-02T12:00:00Z');
    const scheduleSources = [{name: 'DNF'}, {name: 'Flatpak'}];
    const scheduleIntervals = new Map([['DNF', 60], ['Flatpak', 15]]);
    const schedulePolls = new Map([
        ['DNF', scheduleNow - 10 * 60 * 1000],
        ['Flatpak', scheduleNow - 5 * 60 * 1000],
    ]);
    equal(getNextSourceCheckAt(scheduleSources, 60, scheduleIntervals, schedulePolls, scheduleNow),
        scheduleNow + 10 * 60 * 1000,
        'next global check should be the earliest per-source due time');
    equal(getNextSourceCheckAt([{name: 'Cargo'}], 30, new Map(), new Map([['Cargo', scheduleNow - 5 * 60 * 1000]]), scheduleNow),
        scheduleNow + 25 * 60 * 1000,
        'sources without overrides should use the global interval');
    equal(getNextSourceCheckAt([{name: 'New'}], 30, new Map(), new Map(), scheduleNow),
        scheduleNow,
        'never-checked sources should be due immediately');
    equal(getNextSourceCheckAt([], 30, new Map(), new Map(), scheduleNow), null,
        'empty source lists should have no next check time');

    equal(getSecurityNotificationDelta(-1, 3, {enabled: true}), 0,
        'initial security count should establish a baseline without notifying');
    equal(getSecurityNotificationDelta(2, 5, {enabled: true}), 3,
        'security notification should report only newly detected updates');
    equal(getSecurityNotificationDelta(5, 5, {enabled: true}), 0,
        'unchanged security counts should not notify twice');
    equal(getSecurityNotificationDelta(5, 2, {enabled: true}), 0,
        'decreased security counts should not notify');
    equal(getSecurityNotificationDelta(2, 5, {enabled: true, quietHours: true}), 0,
        'quiet hours should suppress security notifications');
    equal(getSecurityNotificationDelta(2, 5, {enabled: true, snoozed: true}), 0,
        'notification snooze should suppress security notifications');
    equal(getSecurityNotificationDelta(2, 5, {enabled: true, failed: true}), 0,
        'failed security checks should not notify from an unreliable count');
    equal(getSecurityNotificationDelta(2, 5, {enabled: false}), 0,
        'disabled security notifications should remain silent');

    equal(parseSecurityAdvisories('FEDORA-2026-123\nRHSA-2026:456\nordinary package output\nUSN-2026-789'),
        ['FEDORA-2026-123', 'RHSA-2026:456', 'USN-2026-789'],
        'default advisory matching should support multiple common distribution identifiers');
    equal(parseSecurityAdvisories('APT-2026-22\nAPT-2026-23\nAPT-2026-22', 'APT-\\d+'),
        ['APT-2026-22', 'APT-2026-23'],
        'custom advisory patterns should support other distribution formats and remove duplicates');
    equal(parseSecurityAdvisories('FEDORA-2026-123\nplain output', '['),
        ['FEDORA-2026-123'],
        'invalid custom patterns should fall back to the safe default matcher');


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

    equal([...parseSourceTimeouts(['DNF|90', 'Flatpak|600', 'Bad|4', 'TooLong|601', 'Suffix|30seconds', 'Decimal|5.5', 'broken']).entries()],
        [['DNF', 90], ['Flatpak', 600]],
        'source timeout parsing should accept 5–600 seconds and reject malformed values');

    equal(parseExitCodeList('0, 2, 100, 2'), [0, 2, 100],
        'success exit codes should be trimmed and deduplicated');
    equal(parseExitCodeList(''), [], 'an empty success-code override should use defaults');
    equal(parseExitCodeList('0,256'), null, 'success exit codes above 255 should be rejected');
    equal(parseExitCodeList('0,one'), null, 'non-numeric success exit codes should be rejected');
    equal([...parseSourceExitCodes(['DNF|100', 'Custom|0,2', 'Broken|0,x']).entries()],
        [['DNF', [100]], ['Custom', [0, 2]]],
        'per-source success exit-code mappings should ignore malformed entries');

    equal(classifyResult({
        stdout: 'custom update\n', stderr: '', exitStatus: 2, spawnFailed: false, timedOut: false,
        successExitCodes: [2],
    }), {status: 'ok', count: 1, message: '', lines: ['custom update']},
    'a configured non-zero exit code should accept update output');
    equal(classifyResult({
        stdout: 'custom update\n', stderr: '', exitStatus: 2, spawnFailed: false, timedOut: false,
    }), {status: 'error', count: 0, message: 'Command exited with status 2 after producing output', lines: []},
    'unconfigured non-zero exit codes should remain errors');

    equal(classifyResult({
        stdout: '', stderr: '', exitStatus: 2, spawnFailed: false, timedOut: false,
    }), {status: 'error', count: 0, message: 'Command exited with status 2', lines: []},
    'unconfigured non-zero exit codes without output should remain errors');

    equal(classifyResult({
        stdout: '', stderr: '', exitStatus: -1, spawnFailed: false, timedOut: false, cancelled: true,
    }), {status: 'cancelled', count: 0, message: 'Check cancelled', lines: []},
    'cancelled commands should not be classified as failures');

    const cancellation = await runWorkerSafely(async () => {
        const error = new Error('Operation cancelled');
        error.matches = () => true;
        throw error;
    }, () => ({status: 'error', count: 0, message: 'unexpected worker failure', lines: []}));
    equal(cancellation, {status: 'cancelled', count: 0, message: 'Check cancelled', lines: []},
        'cancelled worker errors should produce a distinct result');



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
    for (const valid of ['#abc', '#123456', 'rgb(12, 34, 56)', 'rgba(12,34,56,0.5)', 'rgba(12, 34, 56, 1)'])
        assert(sanitizeMatugenColor(valid, '#000') === valid,
            `valid Matugen color should be preserved: ${valid}`);
    for (const invalid of [
        'red; background-image: url(evil)',
        'url(https://example.test)',
        'var(--attacker)',
        'rgb(256, 0, 0)',
        'rgba(0, 0, 0, 2)',
        'expression(alert(1))',
        '',
        null,
        123,
    ])
        assert(sanitizeMatugenColor(invalid, '#112233') === '#112233',
            'invalid Matugen color should use the safe fallback');

    const isolatedResults = await mapPool(['ok-1', 'fails', 'ok-2'], 2, async name => {
        return await runWorkerSafely(async () => {
            if (name === 'fails') throw new Error('expected worker failure');
            return {name, status: 'ok'};
        }, error => ({name, status: 'error', message: String(error.message)}));
    });
    equal(isolatedResults, [
        {name: 'ok-1', status: 'ok'},
        {name: 'fails', status: 'error', message: 'expected worker failure'},
        {name: 'ok-2', status: 'ok'},
    ], 'worker failures should be converted locally while sibling results complete');

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

    const cancellationStarted = Date.now();
    const cancellableCommand = runShell('sleep 10');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        cancelAllShellCommands();
        return GLib.SOURCE_REMOVE;
    });
    const cancelled = await cancellableCommand;
    assert(cancelled.cancelled && !cancelled.timedOut,
        'disabling should mark active check commands as cancelled, not timed out');
    assert(Date.now() - cancellationStarted < 3000,
        'cancelled check commands should settle promptly');

    print('All utility tests passed.');
}

main().catch(error => {
    printerr(error.stack ?? String(error));
    System.exit(1);
});
