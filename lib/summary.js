// Pure snapshot builder: kept separate from Shell UI so the published
// summary contract and redaction rules can be regression-tested.
export function redactSummaryError(value) {
    return String(value ?? '')
        .replace(/([?&](?:password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential|signature|sig|x-amz-credential)=[^&#\s]*)/gi,
            match => match.replace(/=.*/, '=[REDACTED]'))
        .replace(/\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;&?#]+/gi, '$1=[REDACTED]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,})\b/g, '[REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
        .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, 'https://[REDACTED]@')
        .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
        .slice(0, 160);
}

// Build a shareable diagnostics report from non-secret summary/settings data.
// Per-source status and failure details are opt-in; commands and raw output are
// never accepted as inputs to this formatter.
export function buildDiagnosticsReport({
    extensionVersion = 'unknown',
    shellVersion = 'unknown',
    summary = {},
    globalInterval = 60,
    sources = [],
    intervals = new Map(),
    policies = {},
    includeSourceDetails = false,
    includePerformanceCounters = false,
    performanceCounters = {},
} = {}) {
    const yesNo = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
    const lines = [
        'Update Checker diagnostics',
        `Extension version: ${extensionVersion}`,
        `GNOME Shell version: ${shellVersion}`,
        `Last check: ${summary.lastCheck || 'not available'}`,
        `Total updates: ${Number.isFinite(summary.total) && summary.total >= 0 ? summary.total : 'unknown'}`,
        `Security updates: ${summary.securityCount ?? 'unknown'}`,
        `Offline: ${yesNo(summary.offline)}`,
        `On battery: ${yesNo(summary.onBattery)}`,
        `Network metered: ${yesNo(summary.networkMetered)}`,
        `Quiet hours active: ${yesNo(summary.quietHoursActive)}`,
        `Check busy: ${yesNo(summary.busy)}`,
        `Any check failed: ${yesNo(summary.failed)}`,
        `Reboot required: ${yesNo(summary.rebootRequired)}`,
        `Global check interval: ${globalInterval} minutes`,
        `Pause on battery policy: ${policies.skipOnBattery ? 'enabled' : 'disabled'}`,
        `Pause on metered network policy: ${policies.skipOnMetered ? 'enabled' : 'disabled'}`,
        `Quiet hours: ${policies.quietHoursEnabled ? 'enabled' : 'disabled'} (${policies.quietHoursStart ?? 0}:00–${policies.quietHoursEnd ?? 0}:00)`,
        `Security check enabled: ${policies.securityCheckEnabled ? 'yes' : 'no'}`,
        `Reboot check enabled: ${policies.rebootCheckEnabled ? 'yes' : 'no'}`,
        `Configured sources: ${sources.length}`,
    ];
    if (includeSourceDetails) {
        lines.push('', 'Sources (commands and raw output intentionally omitted):');
        for (const source of sources) {
            const detail = (Array.isArray(summary.sources) ? summary.sources : []).find(item => item.name === source.name) || {};
            const interval = intervals.get(source.name) ?? globalInterval;
            const cached = detail.cached ? ', cached' : '';
            lines.push(`- ${String(source.name).slice(0, 80)}: every ${interval} min; status ${detail.status || 'not checked'}; updates ${detail.count ?? 'unknown'}; last checked ${detail.lastChecked || 'unknown'}${cached}`);
            if (detail.status === 'error' && detail.error)
                lines.push(`  Error summary: ${redactSummaryError(detail.error).slice(0, 160)}`);
        }
    }
    if (includePerformanceCounters) {
        const count = key => Number.isSafeInteger(performanceCounters?.[key]) &&
            performanceCounters[key] >= 0 ? performanceCounters[key] : 0;
        lines.push(
            '',
            'Performance counters (aggregate only; no commands or paths recorded):',
            `Checks started: ${count('checksStarted')}`,
            `Checks completed: ${count('checksCompleted')}`,
            `Commands spawned: ${count('commandsSpawned')}`,
            `Menu rebuilds: ${count('menuRebuilds')}`,
            `Updates started: ${count('updatesStarted')}`,
            `Updates completed: ${count('updatesCompleted')}`,
            `Update duration (ms): last ${count('updateDurationLastMs')}; total ${count('updateDurationTotalMs')}; max ${count('updateDurationMaxMs')}`
        );
    }
    return lines.join('\n');
}

export function buildSummarySnapshot(state) {
    const sources = (state.results ?? []).map(result => ({
        name: result.name,
        status: result.status,
        count: result.count,
        cached: result.cached === true,
        lastChecked: state.sourcePolls?.has(result.name)
            ? new Date(state.sourcePolls.get(result.name)).toISOString() : '',
        error: result.status === 'error' ? redactSummaryError(result.message) : '',
    }));
    return {
        version: 1,
        total: state.total,
        securityCount: state.securityCount,
        lastCheck: state.lastCheck ?? '',
        busy: state.busy === true,
        rebootRequired: state.rebootRequired === true,
        offline: state.offline === true,
        onBattery: state.onBattery === true,
        networkMetered: state.networkMetered === true,
        quietHoursActive: state.quietHoursActive === true,
        failed: state.failed === true,
        cancelled: sources.some(source => source.status === 'cancelled'),
        sources,
    };
}
