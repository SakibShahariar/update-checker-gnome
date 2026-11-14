import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {truncate, hexToRgba, parseIntervals, getNextSourceCheckAt, parsePackageOutputLine} from './utils.js';
import {incrementPerformanceCounter} from './performance-counters.js';
import {hasMotion, shouldAnimate} from './motion.js';
import {loadMatugenColors} from './theming.js';

const MAX_VISIBLE = 8;
const PAGE_SIZE = 50;

// Builds per-source menu rows against the owning indicator instance. This is
// a presentation-only extraction; existing state and callbacks stay on it.
export function rebuildResultsSection(sources, results, updateCommands) {
    incrementPerformanceCounter('menuRebuilds');
    log(`UpdateChecker rebuildResults: ${sources.length} sources, palette=${this._matugenColors ? 'cached' : 'fresh-read'}`);
    this._resultsSection.removeAll();
    this._sourceRowWidgets.clear();
    const c = this._matugenColors || loadMatugenColors();
    const compactRows = this._settings.get_boolean('compact-source-rows');
    const globalInterval = this._settings.get_int('check-interval-minutes');
    const sourceIntervals = parseIntervals(this._settings.get_strv('source-intervals'));

    const SOURCE_ICONS = {
        'DNF': 'system-software-install-symbolic',
        'Flatpak': 'application-x-addon-symbolic',
        'Firmware (fwupd)': 'computer-symbolic',
        'Cargo': 'application-x-cargo-symbolic',
        'npm (global)': 'application-x-npm-symbolic',
        'uv tools': 'application-x-python-symbolic',
    };
    const getIcon = n => SOURCE_ICONS[n] || 'package-x-generic-symbolic';

    for (const src of sources) {
        const r = results.find(x => x.name === src.name) ??
            {status: 'error', count: 0, message: 'no result', lines: []};
        const updateCommand = updateCommands.get(src.name);
        const canUpdate = !r.checking && r.status === 'ok' && r.count > 0 && !!updateCommand;

        // Keep the built-in Flatpak and optional firmware sections
        // visible after a successful check, including an explicit zero.
        // Other custom sources retain the compact hide-zero behavior.
        if (r.status === 'ok' && r.count === 0 &&
            !['Flatpak', 'Firmware (fwupd)'].includes(src.name))
            continue;

        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: ''});
        const headerBox = new St.BoxLayout({x_expand: true, style_class: 'update-checker-section-header'});
        const accent = new St.Widget({style_class: 'update-checker-accent'});
        accent.set_style(`background-color: ${c.primary};`);
        const secIcon = new St.Icon({icon_name: getIcon(src.name), icon_size: 16, style_class: 'update-checker-section-icon', y_align: Clutter.ActorAlign.CENTER});
        secIcon.set_style(`color: ${c.secondary};`);
        const titleLabel = new St.Label({text: src.name, style_class: 'update-checker-section-title', y_align: Clutter.ActorAlign.CENTER});
        titleLabel.set_style(`color: ${c.on_surface};`);
        // Muted relative last-checked time from the per-source poll map.
        let lastCheckedLabel = null;
        const lastMs = this._lastSourcePoll.get(src.name);
        if (lastMs) {
            const ageSeconds = Math.max(0, Math.floor((Date.now() - lastMs) / 1000));
            let relative;
            if (ageSeconds < 60)
                relative = 'just now';
            else if (ageSeconds < 3600)
                relative = `${Math.floor(ageSeconds / 60)}m ago`;
            else if (ageSeconds < 86400)
                relative = `${Math.floor(ageSeconds / 3600)}h ago`;
            else
                relative = `${Math.floor(ageSeconds / 86400)}d ago`;

            const dt = GLib.DateTime.new_from_unix_local(Math.floor(lastMs / 1000));
            const localTime = dt ? dt.format('%Y-%m-%d %H:%M') : '';
            const nextAt = getNextSourceCheckAt(
                [src], globalInterval, sourceIntervals, this._lastSourcePoll, Date.now());
            const nextTime = nextAt <= Date.now()
                ? 'now'
                : (GLib.DateTime.new_from_unix_local(Math.floor(nextAt / 1000))?.format('%H:%M') ?? 'later');
            lastCheckedLabel = new St.Label({
                text: `${relative} · next ${nextTime}`,
                style_class: 'update-checker-package-version',
                y_align: Clutter.ActorAlign.CENTER,
            });
            lastCheckedLabel.tooltip_text = localTime
                ? `Last checked at ${localTime}. Next check at ${nextTime}.`
                : `Next check at ${nextTime}.`;
            lastCheckedLabel.accessible_name = `Last checked ${relative}. Next check at ${nextTime}.`;
            lastCheckedLabel.set_style(`color: ${c.on_surface_variant || c.secondary}; font-size: 0.85em;`);
        } else {
            const nextAt = getNextSourceCheckAt(
                [src], globalInterval, sourceIntervals, this._lastSourcePoll, Date.now());
            const nextTime = nextAt <= Date.now()
                ? 'now'
                : (GLib.DateTime.new_from_unix_local(Math.floor(nextAt / 1000))?.format('%H:%M') ?? 'later');
            lastCheckedLabel = new St.Label({
                text: `next ${nextTime}`,
                style_class: 'update-checker-package-version',
                y_align: Clutter.ActorAlign.CENTER,
            });
            lastCheckedLabel.tooltip_text = `Next check at ${nextTime}.`;
            lastCheckedLabel.accessible_name = `Next check at ${nextTime}`;
            lastCheckedLabel.set_style(`color: ${c.on_surface_variant || c.secondary}; font-size: 0.85em;`);
        }
        const badgeText = r.checking ? '…'
            : r.status === 'error' ? '!'
                : r.status === 'cancelled' ? '–' : `${r.count}`;
        const countLabel = new St.Label({text: badgeText, style_class: 'update-checker-badge', y_align: Clutter.ActorAlign.CENTER});
        countLabel.accessible_name = r.checking
            ? `${src.name} check in progress`
            : r.status === 'error'
                ? `${src.name} check failed`
                : r.status === 'cancelled'
                    ? `${src.name} check cancelled`
                    : `${src.name}: ${r.count} pending updates`;
        if (r.cached) {
            countLabel.tooltip_text = r.cacheReason
                ? `Cached result: ${r.cacheReason}`
                : 'Cached result from the previous check';
            countLabel.accessible_name += ', cached';
        }
        countLabel.set_style(`background-color: ${c.secondary_container}; color: ${c.on_secondary_container}; border-color: transparent; border-width: 0;`);
        headerBox.add_child(accent);
        headerBox.add_child(secIcon);
        headerBox.add_child(titleLabel);
        if (lastCheckedLabel && !compactRows)
            headerBox.add_child(lastCheckedLabel);
        const checkState = this._sourceCheckStates.get(src.name) ?? '';
        const checkStateLabel = new St.Label({
            text: checkState,
            visible: !compactRows && !!checkState && checkState !== 'Cached',
            style_class: 'update-checker-package-version',
            y_align: Clutter.ActorAlign.CENTER,
        });
        checkStateLabel.set_style(`color: ${c.on_surface_variant || c.secondary}; font-size: 0.85em;`);
        headerBox.add_child(checkStateLabel);
        if (r.cached && !compactRows) {
            const cachedLabel = new St.Label({
                text: 'Cached',
                style_class: 'update-checker-package-version',
                y_align: Clutter.ActorAlign.CENTER,
            });
            cachedLabel.tooltip_text = r.cacheReason
                ? `Cached result: ${r.cacheReason}.`
                : 'This result was reused from the previous check; this source was not checked in this cycle.';
            cachedLabel.accessible_name = r.cacheReason
                ? `Cached result; ${r.cacheReason}`
                : 'Cached result; source not checked in this cycle';
            cachedLabel.set_style(`color: ${c.on_surface_variant || c.secondary}; font-size: 0.85em;`);
            headerBox.add_child(cachedLabel);
        }
        headerBox.add_child(countLabel);
        const spacer = new St.Widget({x_expand: true});
        headerBox.add_child(spacer);
        let runButton = null;
        const updatingLabel = new St.Label({text: 'Updating…', style_class: 'update-checker-updating-label', visible: false, y_align: Clutter.ActorAlign.CENTER});
        updatingLabel.set_style(`color: ${c.on_secondary_container};`);
        const stopButton = new St.Button({can_focus: true,style_class: 'update-checker-stop-icon', visible: false, child: new St.Icon({icon_name: 'process-stop-symbolic', icon_size: 14})});
        stopButton.set_style(`color: ${c.error};`);
        this._setTooltip(stopButton, `Stop updating ${src.name}`);
        stopButton.accessible_name = `Stop updating ${src.name}`;
        stopButton.connect('clicked', () => this._stopSourceUpdate(src.name));
        if (canUpdate) {
            runButton = new St.Button({can_focus: true,style_class: 'update-checker-update-button', y_align: Clutter.ActorAlign.CENTER});
            runButton.set_style(`background-color: ${c.primary}; color: ${c.on_primary}; border-color: transparent; border-width: 0;`);
            const btnBox = new St.BoxLayout({style_class: 'update-checker-update-button-box', y_align: Clutter.ActorAlign.CENTER});
            btnBox.add_child(new St.Icon({icon_name: 'software-update-available-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            const backgroundMode = this._settings.get_boolean('background-updates');
            const modeName = backgroundMode ? 'Background' : 'Terminal';
            btnBox.add_child(new St.Label({text: `Update · ${modeName}`, style_class: 'update-checker-update-button-label', y_align: Clutter.ActorAlign.CENTER}));
            runButton.set_child(btnBox);
            runButton.accessible_name = `Update ${src.name} in ${modeName.toLowerCase()} mode`;
            this._setTooltip(runButton, backgroundMode
                ? `Run ${src.name} in background; privileged commands use graphical authentication.`
                : `Run ${src.name} in the configured terminal with interactive authentication.`);
            runButton.connect('clicked', () => this._runSourceUpdate(updateCommand, src.name));
            this._bindButtonStates(runButton, c => this._primaryButtonStates(c));
            headerBox.add_child(runButton);
        }
        headerBox.add_child(updatingLabel);
        headerBox.add_child(stopButton);
        headerItem.add_child(headerBox);
        this._resultsSection.addMenuItem(headerItem);
        this._sourceRowWidgets.set(src.name, {countLabel, runButton, updatingLabel, stopButton, checkStateLabel});
        const existingUpdate = this._updatingSources.get(src.name);
        if (existingUpdate)
            this._setRowUpdating(src.name, true, '', existingUpdate.isTerminal ? 'terminal' : 'background');
        // Energetic: badge bounce + button hover scale (delay-based, no GLib source to leak)
        if (hasMotion()) {
            this._animateBounceIn(countLabel, {startOpacity: 0, delay: 80});
            if (runButton)
                this._addButtonHoverScale(runButton);
            // Header slide-in per source
            this._fadeSlideIn(headerItem);
        }

        const containerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: ''});
        const containerBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'update-checker-container'});
        containerBox.set_style(`background-color: transparent; border-color: transparent; border-width: 0;`);
        if (r.status === 'cancelled') {
            const cancelledBox = new St.BoxLayout({style_class: 'update-checker-container-empty', x_expand: true});
            cancelledBox.set_style(`color: ${c.on_surface_variant};`);
            cancelledBox.add_child(new St.Icon({icon_name: 'process-stop-symbolic', icon_size: 16}));
            const cancelledLabel = new St.Label({text: 'Check cancelled', style_class: 'update-checker-status-line'});
            cancelledLabel.accessible_name = `${src.name} check cancelled`;
            cancelledBox.add_child(cancelledLabel);
            const retryButton = new St.Button({
                label: 'Retry',
                can_focus: true,
                style_class: 'update-checker-refresh-button',
            });
            retryButton.accessible_name = `Retry check for ${src.name}`;
            retryButton.connect('clicked', () => this.checkNow(true));
            cancelledBox.add_child(retryButton);
            containerBox.add_child(cancelledBox);
        } else if (r.status === 'error') {
            const errBox = new St.BoxLayout({style_class: 'update-checker-container-empty', x_expand: true});
            errBox.set_style(`color: ${c.on_surface_variant};`);
            errBox.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, style_class: ''}));
            const fullError = r.message || 'Unknown error';
            const detailsText = r.details || fullError;
            const errLabel = new St.Label({text: truncate(fullError, 50), style_class: 'update-checker-status-line'});
            errLabel.tooltip_text = fullError;
            errBox.add_child(errLabel);
            const clickable = new St.Button({can_focus: true,child: errBox, x_expand: true});
            clickable.accessible_name = `${src.name} check failed. Show error details`;
            this._setTooltip(clickable, `${src.name} check failed: ${fullError}`);
            clickable.connect('clicked', () => Main.notifyError(`${src.name} check failed`, r.message || 'Unknown error'));

            const detailsLabel = new St.Label({
                text: detailsText,
                style_class: 'update-checker-error-details',
                visible: false,
                x_expand: true,
            });
            detailsLabel.clutter_text.line_wrap = true;
            detailsLabel.accessible_name = `Redacted command output and standard error for ${src.name}`;
            const errorActions = new St.BoxLayout({x_expand: true, style_class: 'update-checker-error-actions'});
            const retryButton = new St.Button({can_focus: true,
                label: 'Retry',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'update-checker-refresh-button',
            });
            retryButton.accessible_name = `Retry check for ${src.name}`;
            this._setTooltip(retryButton, `Retry ${src.name} now`);
            retryButton.connect('clicked', () => this.checkNow(true));
            const editButton = new St.Button({can_focus: true,
                label: 'Edit',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'update-checker-refresh-button',
            });
            editButton.accessible_name = `Edit ${src.name} source settings`;
            this._setTooltip(editButton, `Open settings to edit ${src.name}`);
            editButton.connect('clicked', () => this._ext.openPreferences());
            const detailsButtonLabel = new St.Label({text: 'Details'});
            const detailsButton = new St.Button({
                can_focus: true,
                child: detailsButtonLabel,
                style_class: 'update-checker-refresh-button',
            });
            detailsButton.accessible_name = `Show full redacted diagnostics for ${src.name}`;
            detailsButton.connect('clicked', () => {
                detailsLabel.visible = !detailsLabel.visible;
                detailsButtonLabel.set_text(detailsLabel.visible ? 'Hide details' : 'Details');
            });
            const copyButton = new St.Button({
                can_focus: true,
                child: new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14}),
                style_class: 'update-checker-refresh-button',
            });
            copyButton.accessible_name = `Copy redacted diagnostics for ${src.name}`;
            this._setTooltip(copyButton, 'Copy redacted stdout and stderr');
            copyButton.connect('clicked', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, detailsText);
            });
            errorActions.add_child(clickable);
            errorActions.add_child(detailsButton);
            errorActions.add_child(copyButton);
            errorActions.add_child(retryButton);
            errorActions.add_child(editButton);
            containerBox.add_child(errorActions);
            containerBox.add_child(detailsLabel);
        } else if (r.count === 0) {
            const emptyBox = new St.BoxLayout({style_class: 'update-checker-container-empty', x_expand: true, orientation: Clutter.Orientation.VERTICAL});
            emptyBox.set_style('spacing: 2px;');
            const emptyRow = new St.BoxLayout({style_class: '', x_align: Clutter.ActorAlign.CENTER});
            emptyRow.set_style('spacing: 6px;');
            emptyRow.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16}));
            const okLabel = new St.Label({text: 'All up to date', style_class: 'update-checker-package-name'});
            okLabel.set_style(`color: ${c.on_surface};`);
            emptyRow.add_child(okLabel);
            emptyBox.add_child(emptyRow);
            const hintLabel = new St.Label({text: `${src.name} checks are automatic`, style_class: '', x_align: Clutter.ActorAlign.CENTER});
            hintLabel.set_style(`color: ${hexToRgba(c.on_surface_variant, 0.8)}; font-size: 0.85em;`);
            emptyBox.add_child(hintLabel);
            containerBox.add_child(emptyBox);
        } else {
            const visibleCount = Math.min(r.lines.length,
                this._expandedSources.get(src.name) ?? MAX_VISIBLE);
            const isFullyExpanded = visibleCount >= r.lines.length;
            const hasMore = r.lines.length > MAX_VISIBLE;
            const linesToShow = r.lines.slice(0, visibleCount);
            for (let idx = 0; idx < linesToShow.length; idx++) {
                const line = linesToShow[idx];
                const {name: pkgName, version} = parsePackageOutputLine(line, r.outputFormat ?? 'auto');
                const rowBox = new St.BoxLayout({style_class: '', x_expand: true});
                rowBox.set_style('spacing: 8px;');
                const nameLabel = new St.Label({text: truncate(pkgName, 42), style_class: 'update-checker-package-name', x_expand: true});
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                nameLabel.set_style(`color: ${c.on_surface};`);
                rowBox.add_child(nameLabel);
                if (version) {
                    const verLabel = new St.Label({text: truncate(version, 24), style_class: 'update-checker-package-version', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.END});
                    verLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    verLabel.set_style(`color: ${c.secondary};`);
                    rowBox.add_child(verLabel);
                }
                const row = rowBox;
                row.style_class = 'update-checker-package-row';
                if (hasMotion()) {
                    this._fadeSlideIn(row, {translationY: -4, delay: idx * 35});
                }
                containerBox.add_child(row);
            }
            if (r.truncated) {
                const limitLabel = new St.Label({
                    text: `Showing ${r.lines.length} of ${r.count} updates to limit retained output.`,
                    style_class: 'update-checker-package-version',
                    x_expand: true,
                });
                limitLabel.set_style(`color: ${c.on_surface_variant}; font-size: 0.85em;`);
                limitLabel.accessible_name = `Only the first ${r.lines.length} update lines are retained; the full count is ${r.count}.`;
                containerBox.add_child(limitLabel);
            }
            if (hasMore) {
                const remaining = r.lines.length - visibleCount;
                const nextPage = Math.min(PAGE_SIZE, remaining);
                const btnLabel = isFullyExpanded ? 'Show less' : `Show more (${nextPage})`;
                const iconName = isFullyExpanded ? 'go-up-symbolic' : 'go-down-symbolic';
                const toggleBtn = new St.Button({can_focus: true,style_class: 'update-checker-expand-button', x_expand: true});
                toggleBtn.set_style(`background-color: ${hexToRgba(c.surface_container_high, 0.85)}; color: ${c.on_surface_variant};`);
                const btnBox = new St.BoxLayout({x_expand: true, style_class: 'update-checker-update-button-box'});
                btnBox.add_child(new St.Icon({icon_name: iconName, icon_size: 12, y_align: Clutter.ActorAlign.CENTER}));
                btnBox.add_child(new St.Label({text: btnLabel, y_align: Clutter.ActorAlign.CENTER}));
                toggleBtn.set_child(btnBox);
                toggleBtn.accessible_name = isFullyExpanded
                    ? `Collapse ${src.name} package list`
                    : `Show the next ${nextPage} ${src.name} updates`;
                this._setTooltip(toggleBtn, isFullyExpanded
                    ? `Show fewer ${src.name} updates`
                    : `Show the next ${nextPage} updates`);
                toggleBtn.connect('clicked', () => this._toggleSourceExpanded(src.name));
                this._bindButtonStates(toggleBtn, c => ({
                    base: hexToRgba(c.surface_container_high, 0.85),
                    hover: hexToRgba(c.secondary_container, 0.85),
                    active: hexToRgba(c.outline_variant, 0.85),
                    color: c.on_surface_variant,
                }));
                if (hasMotion()) this._addButtonHoverScale(toggleBtn);
                containerBox.add_child(toggleBtn);
            }
        }
        // All sources' containers live inside the single _resultsScroller
        // ScrollView, so the expanded list scrolls as one capped region.
        containerItem.add_child(containerBox);
        this._resultsSection.addMenuItem(containerItem);
        if (shouldAnimate()) {
            this._fadeSlideIn(containerItem, {translationY: -4, duration: 200});
        }
    }

    this._updateResultsScrollHeight();
}
