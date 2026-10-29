// Pure snapshot builder: kept separate from Shell UI so the published
// summary contract and redaction rules can be regression-tested.
export function redactSummaryError(value) {
    return String(value ?? '')
        .replace(/\b(password|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, 'https://[REDACTED]@')
        .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
        .slice(0, 160);
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
        sources,
    };
}
