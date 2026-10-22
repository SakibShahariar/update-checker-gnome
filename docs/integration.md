# Integration: machine-readable status

Update Checker publishes a JSON snapshot through the existing GSettings key `summary-json`. This is intended for read-only consumers such as panel extensions; integrations should not write to this key or duplicate package-manager checks.

## Read the snapshot

The schema ID is `org.gnome.shell.extensions.update-checker`, with path `/org/gnome/shell/extensions/update-checker/`.

```sh
gsettings get org.gnome.shell.extensions.update-checker summary-json
```

The schema must be installed and compiled on the system, as it is for the extension itself. The value is a JSON string, so consumers should parse it as JSON after reading the GSettings string.

## Version 1 fields

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Schema version; currently `1`. |
| `total` | number | Total pending updates. `-1` means a full check has not completed yet. |
| `securityCount` | number | Number of security updates, already included in `total`. |
| `lastCheck` | string | Localized display time for the most recent check, or an empty string if not available. |
| `busy` | boolean | True while checks or tracked background update actions are active. |
| `rebootRequired` | boolean | Whether the configured reboot check reports a required reboot. |
| `offline` | boolean | Whether the extension currently considers the system offline. |
| `failed` | boolean | Whether the latest recorded source/check state contains a failure. |

## Consumer guidance

- Treat the value as a snapshot, not a transactional or event-driven API. It can change while checks run.
- Handle missing keys and malformed JSON defensively; older installations may not publish this snapshot.
- Check `version` before depending on fields and ignore fields your consumer does not use.
- Do not add `securityCount` to `total`; security updates are already included.
- Treat `total: -1` as “not checked yet,” not as zero updates.
- Keep consumers read-only. The extension owns this setting and overwrites it when publishing status.
