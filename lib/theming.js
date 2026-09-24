import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {hexToRgba, lightenHex} from './utils.js';

/** Remove legacy timestamped matugen CSS files from older builds. */
export function cleanOldMatugenCache(prefix) {
    try {
        const dir = Gio.File.new_for_path(GLib.get_user_cache_dir());
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.startsWith(prefix) && /^.+-\d+\.css$/.test(name)) {
                try { dir.get_child(name).delete(null); } catch (e) {}
            }
        }
        enumerator.close(null);
    } catch (e) {}
}


export function loadMatugenColors() {
    // Fallback matches current ~/.config/matugen/matugen-colors.css (dark) — never use -st-accent-color
    const fallback = {
        background: '#131314',
        error: '#ffb4ab',
        error_container: '#93000a',
        on_error_container: '#ffdad6',
        on_primary: '#29313c',
        on_primary_container: '#dbe3f1',
        on_secondary_container: '#dfe2eb',
        on_surface: '#e4e2e3',
        on_surface_variant: '#c8c6c7',
        on_tertiary_container: '#d6e4f7',
        outline: '#919092',
        outline_variant: '#474748',
        primary: '#bfc7d5',
        primary_container: '#3f4753',
        secondary: '#c3c7cf',
        secondary_container: '#42474e',
        surface: '#131314',
        surface_container: '#1f2021',
        surface_container_high: '#2a2a2b',
        tertiary: '#bac8db',
        tertiary_container: '#3b4858',
    };
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return fallback;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return fallback;
        const text = new TextDecoder().decode(contents);
        const map = {};
        const re = /--([\w_]+)\s*:\s*([^;]+);/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            map[m[1]] = m[2].trim();
        }
        const get = (k) => map[k] || fallback[k];
        return {
            background: get('background'),
            error: get('error'),
            error_container: get('error_container'),
            on_error_container: get('on_error_container'),
            on_primary: get('on_primary'),
            on_primary_container: get('on_primary_container'),
            on_secondary_container: get('on_secondary_container'),
            on_surface: get('on_surface'),
            on_surface_variant: get('on_surface_variant'),
            on_tertiary_container: get('on_tertiary_container'),
            outline: get('outline'),
            outline_variant: get('outline_variant'),
            primary: get('primary'),
            primary_container: get('primary_container'),
            secondary: get('secondary'),
            secondary_container: get('secondary_container'),
            surface: get('surface'),
            surface_container: get('surface_container'),
            surface_container_high: get('surface_container_high'),
            tertiary: get('tertiary'),
            tertiary_container: get('tertiary_container'),
        };
    } catch (e) {
        return fallback;
    }
}


export function buildMatugenCss(c) {
    // Mirrors stylesheet.css but with live Matugen hex values — GNOME: no outline borders (was KDE-like)
    return `
.update-checker-header-card { background-color: ${hexToRgba(c.primary_container, 0.85)}; border-color: transparent; border-width: 0; }
.update-checker-header-icon-box { background-color: ${hexToRgba(c.primary, 0.9)}; }
.update-checker-header-icon { color: ${c.on_primary}; }
.update-checker-header-title { color: ${c.on_primary_container}; }
.update-checker-header-subtitle { color: ${hexToRgba(c.on_primary_container, 0.85)}; }
.update-checker-refresh-button { color: ${c.on_primary_container}; }
.update-checker-refresh-button:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.update-checker-refresh-button:active { background-color: ${hexToRgba(c.primary, 0.22)}; }
.update-checker-accent { background-color: ${c.primary}; }
.update-checker-section-title { color: ${c.on_surface}; }
.update-checker-section-icon { color: ${c.secondary}; }
.update-checker-badge { background-color: ${hexToRgba(c.secondary_container, 0.85)}; border-color: transparent; border-width: 0; color: ${c.on_secondary_container}; }
.update-checker-update-button { background-color: ${c.primary}; border-color: transparent; border-width: 0; color: ${c.on_primary}; }
.update-checker-update-button:hover { background-color: ${lightenHex(c.primary, 0x14)}; }
.update-checker-update-button:active { background-color: ${lightenHex(c.primary, 0x22)}; }
.update-checker-container { background-color: ${hexToRgba(c.surface_container, 0.85)}; border-color: transparent; border-width: 0; }
.update-checker-container-empty { color: ${c.on_surface_variant}; }
.update-checker-package-row:hover { background-color: ${hexToRgba(c.surface_container_high, 0.85)}; }
.update-checker-package-name { color: ${c.on_surface}; }
.update-checker-package-version { color: ${c.secondary}; }
.update-checker-security-icon, .update-checker-warning-icon, .update-checker-stop-icon { color: ${c.error}; }
.update-checker-reboot-icon { color: ${c.primary}; }
.update-checker-offline-icon { color: ${c.secondary}; }
.update-checker-updating-label { color: ${c.on_secondary_container}; }
.update-checker-syncing-icon { color: ${c.primary}; }
.update-checker-menu .popup-menu-item { border-radius: 8px; margin: 1px 4px; padding-left: 8px; padding-right: 8px; border-color: transparent; border-width: 0; }
.update-checker-menu .popup-menu-item:hover, .update-checker-menu .popup-menu-item:selected, .update-checker-menu .popup-menu-item:focus { background-color: ${hexToRgba(c.surface_container_high, 0.85)}; }
.update-checker-expand-button { background-color: ${hexToRgba(c.surface_container_high, 0.85)}; color: ${c.on_surface_variant}; }
.update-checker-expand-button:hover { background-color: ${hexToRgba(c.secondary_container, 0.85)}; }
.update-checker-expand-button:active { background-color: ${hexToRgba(c.outline_variant, 0.85)}; }
`;
}
