import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runShell, classifyResult, truncate} from './utils.js';

    // Runs the reboot-required check on its own (local-only, works
    // offline). Updates the reboot icon/menu item/notification, and
    // returns whether the check itself failed (as opposed to "not
    // needed") - state otherwise lives on the instance so both the
    // normal and offline-shortcut paths in checkNow() can share indicator.
    export async function checkReboot(indicator) {
        const checkRebootEnabled = indicator._settings.get_boolean('check-reboot-required');
        const rebootCommand = indicator._settings.get_string('reboot-check-command');

        let rebootRequired = false;
        let rebootCheckFailed = false;
        let rebootMessage = '';

        if (checkRebootEnabled && rebootCommand) {
            const raw = await runShell(rebootCommand);
            const r = classifyResult(raw);
            if (r.status === 'ok' && r.count > 0) {
                rebootRequired = true;
                rebootMessage = raw.stdout.trim().split('\n')[0];
            } else if (r.status === 'error') {
                // Visible instead of silent: a failed reboot-check
                // command is "unknown", not "not needed" - and the
                // person should be able to tell the difference.
                rebootCheckFailed = true;
                rebootMessage = r.message;
            }
        }

        indicator._lastRebootRequired = rebootRequired;
        indicator._rebootIcon.visible = rebootRequired;
        indicator._rebootItem.visible = rebootRequired || rebootCheckFailed;
        indicator._rebootNowBtn.visible = rebootRequired;
        indicator._rebootFullMessage = rebootMessage || '';
        if (rebootRequired) {
            indicator._rebootItem.label.set_text(`⟳ ${truncate(rebootMessage || 'Reboot required', 55)}`);
            indicator._rebootItem.tooltip_text = rebootMessage || 'Reboot required';
        } else if (rebootCheckFailed) {
            indicator._rebootItem.label.set_text(`⚠ Reboot check failed: ${truncate(rebootMessage, 35)}`);
            indicator._rebootItem.tooltip_text = rebootMessage || '';
        } else {
            indicator._rebootItem.tooltip_text = '';
        }

        if (indicator._settings.get_boolean('notify-on-new') && !indicator._inQuietHours() &&
            rebootRequired && !indicator._lastNotifiedReboot) {
            Main.notify('Reboot required', rebootMessage || 'A reboot is needed to finish applying updates.');
        }
        indicator._lastNotifiedReboot = rebootRequired;
        indicator._updateVisibility();

        return rebootCheckFailed;
    }

    // Runs the security-update check. Network-dependent (like the main
    // sources), so this is only ever called from checkNow()'s online
    // path - never while offline. The count is informational only and
    // deliberately NOT added to the main total, since security updates
    // are already included in it (this is a subset, not an addition).
    export async function checkSecurity(indicator) {
        const enabled = indicator._settings.get_boolean('check-security-updates');
        const command = indicator._settings.get_string('security-check-command');
        const advisoryCommand = indicator._settings.get_string('security-advisory-command');

        indicator._securityAdvisoryItem.visible = false;
        let count = 0;
        let failed = false;
        let message = '';

        if (enabled && command) {
            const raw = await runShell(command);
            const r = classifyResult(raw);
            if (r.status === 'ok') {
                count = r.count;
            } else {
                failed = true;
                message = r.message;
            }
        }

        indicator._lastSecurityCount = count;
        if (enabled && count > 0 && advisoryCommand) {
            try {
                const advisoryResult = await runShell(advisoryCommand, 30_000);
                if (!advisoryResult.spawnFailed && !advisoryResult.timedOut && advisoryResult.exitStatus === 0) {
                    const advisoryLine = (advisoryResult.stdout || '').split('\n')
                        .map(line => line.trim())
                        .find(line => line && /(?:FEDORA|RHSA|RHEA|RHBA|ALSA|USN|CVE)[-:]?\d|\b(?:critical|important|moderate|low|security)\b/i.test(line));
                    if (advisoryLine) {
                        indicator._securityAdvisoryItem.label.set_text('ℹ ' + truncate(advisoryLine, 72));
                        indicator._securityAdvisoryItem.tooltip_text = advisoryLine;
                        indicator._securityAdvisoryItem.visible = true;
                    }
                }
            } catch (e) {
                // Advisory metadata is supplementary; never turn an otherwise
                // successful security count into a failed check.
                log('UpdateChecker advisory lookup failed: ' + e);
            }
        }
        indicator._securityIcon.visible = count > 0;
        indicator._securityItem.visible = count > 0 || failed;
        indicator._securityFullMessage = failed ? (message || '') : '';
        if (count > 0) {
            indicator._securityItem.label.set_text(
                `🛡 ${count} security update${count === 1 ? '' : 's'} pending`);
            indicator._securityItem.tooltip_text = '';
        } else if (failed) {
            indicator._securityItem.label.set_text(`⚠ Security check failed: ${truncate(message, 35)}`);
            indicator._securityItem.tooltip_text = message || '';
        } else {
            indicator._securityItem.tooltip_text = '';
        }

        return failed;
    }

