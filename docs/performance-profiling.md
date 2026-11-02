# Performance profiling

Use this procedure to compare Update Checker changes on the same machine. It is a measurement guide, not a performance target: record the GNOME Shell version, distribution, hardware, power state, network state, source configuration, and commit SHA with every result.

## Before comparing

1. Use the same machine, user session, display scale, power mode, network, and source configuration for both revisions.
2. Keep package-manager metadata warm and avoid running system updates during a measurement.
3. Close unrelated high-load applications. Do not compare a cold first launch against a warmed-up run.
4. Record the exact commit SHA and repeat each scenario three times. Compare medians, not the best run.
5. Do not run update commands as part of the benchmark. Use checks and menu interaction only.

Record the environment:

```sh
gnome-shell --version
uname -a
lscpu | sed -n '1,20p'
```

## Identify and sample GNOME Shell

Find the current Shell process:

```sh
PID=$(pgrep -n -x gnome-shell)
test -n "$PID" || { echo "GNOME Shell process not found" >&2; exit 1; }
printf 'GNOME Shell PID: %s\n' "$PID"
```

Sample CPU, resident memory, and context switches for five minutes (requires the `sysstat` package):

```sh
pidstat -h -u -r -w -p "$PID" 1 300 | tee "update-checker-pidstat-$(date +%Y%m%d-%H%M%S).log"
```

For aggregate process counters, run this in a second terminal (requires `perf` and permission to attach to GNOME Shell):

```sh
sudo perf stat -p "$PID" -e task-clock,context-switches,cpu-migrations,page-faults -- sleep 300
```

Treat context switches as a scheduling-activity proxy, **not** as an exact timer-wakeup count. If wakeups are a specific regression target, capture a GNOME Shell session with Sysprof on the same machine and compare its scheduling/wakeup timeline. Sysprof availability and event permissions vary by distribution and kernel; record unavailable counters instead of substituting a different metric.

## Count spawned commands

For a short, controlled measurement window, attach `strace` to GNOME Shell and count process/exec activity:

```sh
sudo strace -f -c -e trace=process -p "$PID"
```

Interact with Update Checker for the chosen scenario, then stop `strace` with Ctrl+C to print its summary. This tracing adds overhead, so use it only for command-count comparisons and do not use the traced run for CPU timing. The process syscall summary includes forks/clones and exec attempts; inspect an unaggregated `execve` trace if the exact executable list is needed.

## Count menu rebuilds

The menu builder emits a diagnostic log line for each results-section rebuild. Count it for the current boot:

```sh
journalctl --user -b --no-pager | grep -F 'UpdateChecker rebuildResults:' | wc -l
```

For a live window, note the start time, perform the scenario, then count only log entries after that time:

```sh
START=$(date --iso-8601=seconds)
# Perform the scenario, then:
journalctl --user --since "$START" --no-pager | grep -F 'UpdateChecker rebuildResults:' | wc -l
```

If the session does not expose these messages through the user journal, mark the metric unavailable; do not infer a zero rebuild count.

## Repeatable scenarios

Run each scenario for the same duration on both revisions, after a short warm-up:

| Scenario | Procedure | Main observations |
|---|---|---|
| Idle | Leave the panel menu closed for 5 minutes; do not press Check now. | Shell CPU, RSS, context switches/wakeup timeline, unexpected command activity. |
| Scheduled/manual check | Trigger Check now five times, allowing each check to finish before the next. | Check duration, spawned commands, CPU, peak RSS. |
| Menu interaction | Open and close the menu 20 times; expand and collapse one source on each open. | Menu rebuild count, CPU, interaction responsiveness, RSS. |
| Many sources | Configure the same 10–15 lightweight test sources on both revisions and run one check. | Peak RSS, check duration, command count, menu rebuild count. |

Use harmless commands that produce deterministic output for test sources, for example:

```sh
printf 'example-package 1.0 2.0\n'
```

Do not use real package-manager update commands as fixtures.

## Results table

Keep one row per run and retain the raw logs with the commit SHA:

| Commit | Scenario | Run | CPU (avg) | Peak RSS | Context switches | Wakeups (Sysprof) | Exec/process activity | Menu rebuilds |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `<sha>` | Idle | 1 | | | | | | |
| `<sha>` | Check now | 1 | | | | | | |
| `<sha>` | Menu interaction | 1 | | | | | | |
| `<sha>` | Many sources | 1 | | | | | | |

Report units and sampling interval. Compare medians across three runs and investigate large differences before attributing them to the extension. A lower command count is not automatically better if checks become stale or less reliable; correctness and update freshness remain constraints.

## Interpretation and limitations

- CPU and RSS are process measurements; they include GNOME Shell work unrelated to this extension. Keep the session otherwise quiet and compare paired runs.
- Context switches, scheduler wakeups, and timer expirations are different measurements. Never label one as another.
- `strace` changes timing and can add substantial overhead. Keep its results separate from CPU/latency runs.
- Menu rebuild counts are meaningful only when the diagnostic log is available and the same interaction script is followed.
- Compare the same GNOME Shell major version. A result from one Shell release does not establish compatibility or performance on another.
- Do not add a performance optimization solely because a metric moved. Confirm the user-visible behavior and regression tests remain correct.
