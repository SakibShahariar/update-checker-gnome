import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {loadMatugenColors, buildMatugenCss} from './theming.js';
import {hexToRgba} from './utils.js';

export function applyMatugenTheme(indicator, {loadStylesheet = true, force = false} = {}) {
        try {
            // force: a shell theme reload (matugen's own user-theme toggle in
            // merge-layout.sh swaps the whole theme) drops stylesheets the
            // extension loaded via load_stylesheet, while the cached
            // _matugenCss makes them look unchanged. Reset that state so the
            // next apply re-loads the stylesheet even if the content is the
            // same as last time.
            if (force && indicator._matugenThemeFile) {
                try {
                    const stage = global.stage;
                    const theme = stage ? St.ThemeContext.get_for_stage(stage)?.get_theme() ?? null : null;
                    if (theme) theme.unload_stylesheet(indicator._matugenThemeFile);
                } catch (e) {}
                indicator._matugenThemeFile = null;
                indicator._matugenCss = null;
            }
            const colors = loadMatugenColors();
            indicator._matugenColors = colors;
            const css = buildMatugenCss(colors);

            // Fixed path — avoid creating a new file (and forced unload/load)
            // on every call. Only touch St.Theme when content actually changed
            // AND the caller asked for a stylesheet load (popup open / matugen
            // file change). Every caller passes loadStylesheet:true.
            const cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'update-checker-matugen.css']);
            const cssChanged = css !== indicator._matugenCss;

            if (loadStylesheet && cssChanged) {
                let theme = null;
                try {
                    const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
                    if (stage) {
                        const ctx = St.ThemeContext.get_for_stage(stage);
                        theme = ctx?.get_theme() ?? null;
                    }
                } catch (e) {}
                if (!theme) {
                    try {
                        const ctx2 = St.ThemeContext.get_for_stage(global.stage);
                        theme = ctx2?.get_theme() ?? null;
                    } catch (e) {}
                }

                // Unload previous only when we are about to load a different one
                if (theme && indicator._matugenThemeFile) {
                    try { theme.unload_stylesheet(indicator._matugenThemeFile); } catch (e) {}
                }

                const ok = GLib.file_set_contents(cachePath, css);
                if (!ok) throw new Error('file_set_contents failed');
                const file = Gio.File.new_for_path(cachePath);
                if (theme) {
                    theme.load_stylesheet(file);
                    indicator._matugenThemeFile = file;
                    try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
                } else {
                    indicator._matugenThemeFile = file;
                }
                indicator._matugenCss = css;
            } else if (cssChanged) {
                // Still remember content so the next full apply can skip if unchanged
                indicator._matugenCss = css;
            }

            // Always apply inline styles — cheap and guarantees visual update
            // even if St.Theme load is delayed/cached. Uses Matugen primary
            // family, never -st-accent-color.
            applyInlineMatugenColors(indicator, colors);

            // Rebuild current results so per-source cards pick up new stylesheet/inline immediately if popup is open
            try {
                if (indicator._lastRenderSources?.length && indicator.menu?.isOpen)
                    indicator._rebuildResultsSection(indicator._lastRenderSources, indicator._lastRenderResults, indicator._lastRenderUpdateCommands);
            } catch (e) {}
        } catch (e) {
            logError(e, 'UpdateChecker matugen theme failed');
        }
    }

export function applyInlineMatugenColors(indicator, c) {
        try {
            if (indicator._headerBox) indicator._headerBox.set_style(`background-color: ${hexToRgba(c.primary_container, 0.55)}; border-color: transparent; border-width: 0;`);
            // Whole popup background — same surface_container token the package-list
            // container uses, kept translucent (unlike the container's opaque fill)
            // so the footer chrome reads as one consistent, on-theme surface instead
            // of the static stylesheet.css gray.
            if (indicator._menuBox) indicator._menuBox.set_style(`background-color: ${hexToRgba(c.surface_container, 0.55)};`);
            // These inline colors are a deliberate fallback, not just an
            // optimization: a user-theme swap (matugen's merge-layout.sh)
            // replaces the whole St.Theme and drops extension-loaded stylesheets,
            // so class-based colors alone can silently revert to static defaults.
            // Re-apply the palette inline on every theme apply so all elements
            // follow the current theme regardless of stylesheet load state.
            if (indicator._headerIconBox) indicator._headerIconBox.set_style(`background-color: ${hexToRgba(c.primary, 0.9)};`);
            if (indicator._headerIcon) indicator._headerIcon.set_style(`color: ${c.on_primary};`);
            if (indicator._headerTitle) indicator._headerTitle.set_style(`color: ${c.on_primary_container};`);
            if (indicator._headerSubtitle) indicator._headerSubtitle.set_style(`color: ${hexToRgba(c.on_primary_container, 0.85)};`);
            if (indicator._headerSubtitle2) indicator._headerSubtitle2.set_style(`color: ${hexToRgba(c.on_primary_container, 0.7)};`);
            if (indicator._refreshButton) indicator._refreshButton.set_style(`color: ${c.on_primary_container};`);
            if (indicator._settingsButton) indicator._settingsButton.set_style(`color: ${c.on_primary_container};`);
            if (indicator._rebootNowBtn) indicator._rebootNowBtn.set_style(`background-color: ${c.primary}; color: ${c.on_primary}; border-color: transparent; border-width: 0;`);
            // Panel icon and the small status glyphs: one owner decides their
            // color, including the on_primary switch while the menu is open.
            try { indicator._applyPanelColors?.(); } catch (e) {}
            // Per-source row widgets are rebuilt on open/theme change with
            // their inline colors (see menu-ui.js and the open handler), which
            // is the reliable path when a theme swap drops loaded stylesheets.
            for (const [, w] of indicator._sourceRowWidgets ?? []) {
                try { if (w.countLabel) w.countLabel.set_style(`background-color: ${c.secondary_container}; color: ${c.on_secondary_container}; border-color: transparent; border-width: 0;`); } catch (e) {}
                try { if (w.runButton) w.runButton.set_style(`background-color: ${c.primary}; color: ${c.on_primary}; border-color: transparent; border-width: 0;`); } catch (e) {}
                try { if (w.updatingLabel) w.updatingLabel.set_style(`color: ${c.on_secondary_container};`); } catch (e) {}
            }
            try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
        } catch (e) {}
    }

export function removeMatugenTheme(indicator) {
        if (indicator._matugenThemeFile) {
            try {
                const theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme();
                if (theme) theme.unload_stylesheet(indicator._matugenThemeFile);
            } catch (e) {}
            indicator._matugenThemeFile = null;
        }
        indicator._matugenCss = null;
        if (indicator._matugenDebounceId) {
            GLib.source_remove(indicator._matugenDebounceId);
            indicator._matugenDebounceId = null;
        }
        if (indicator._matugenMonitor) {
            try { indicator._matugenMonitor.cancel(); } catch (e) {}
            indicator._matugenMonitor = null;
        }
    }

export function setupMatugenMonitor(indicator) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        const file = Gio.File.new_for_path(path);
        try {
            indicator._matugenMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            indicator._matugenDebounceId = null;
            indicator._matugenMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType !== Gio.FileMonitorEvent.CHANGED && eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                    return;
                if (indicator._matugenDebounceId) {
                    GLib.source_remove(indicator._matugenDebounceId);
                    indicator._matugenDebounceId = null;
                }
                indicator._matugenDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    indicator._matugenDebounceId = null;
                    if (!indicator._destroyed)
                        indicator._applyMatugenTheme({loadStylesheet: true});
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            logError(e, 'UpdateChecker matugen monitor failed');
        }
    }

