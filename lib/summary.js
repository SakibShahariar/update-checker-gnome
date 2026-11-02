// Pure snapshot builder: kept separate from Shell UI so the published
// summary contract and redaction rules can be regression-tested.
export function redactSummaryError(value) {
    return String(value ?? '')
        .replace(/([?&](?:password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential|signature|sig|x-amz-credential)=[^&#\\s]*)/gi,
            match => match.replace(/=.*/, '=[REDACTED]'))
        .replace(/\\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|apikey|authorization|credential)\\b\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s,;&?#]+/gi, '$1=[REDACTED]')
        .replace(/\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,})\\b/g, '[REDACTED]')
        .replace(/\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\b/g, '[REDACTED]')
        .replace(/https?:\\/\\/[^/\\s:@]+:[^@\\s/]+@/gi, 'https://[REDACTED]@')
        .replace(/\\/home\\/[^/\\s]+/g, '/home/[USER]')
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
