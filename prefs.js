import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class UpdateCheckerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- General group ---
        const generalGroup = new Adw.PreferencesGroup({title: 'General'});
        page.add(generalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Check interval (minutes)',
            subtitle: 'How often to re-run all update checks',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 1440, step_increment: 5}),
        });
        settings.bind('check-interval-minutes', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on new updates',
            subtitle: 'Show a notification when the update count increases',
        });
        settings.bind('notify-on-new', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(notifyRow);

        const showZeroRow = new Adw.SwitchRow({
            title: 'Keep icon visible when up to date',
            subtitle: 'Off (default): the panel icon only appears when updates are pending',
        });
        settings.bind('show-zero', showZeroRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(showZeroRow);

        // --- Update script group ---
        const scriptGroup = new Adw.PreferencesGroup({
            title: 'Update Script',
            description: 'Optional: a script to run (in a terminal, so password prompts work) from the panel menu\'s "Run Update Script" item.',
        });
        page.add(scriptGroup);

        const scriptRow = new Adw.EntryRow({title: 'Script path'});
        scriptRow.set_text(settings.get_string('update-script-path'));
        scriptRow.connect('notify::text', () => {
            settings.set_string('update-script-path', scriptRow.get_text());
        });
        scriptGroup.add(scriptRow);

        const browseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse...',
        });
        browseButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: 'Select update script',
                action: Gtk.FileChooserAction.OPEN,
                transient_for: window,
                modal: true,
            });
            chooser.connect('response', (dlg, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = dlg.get_file();
                    if (file) {
                        const path = file.get_path();
                        scriptRow.set_text(path);
                    }
                }
                chooser.destroy();
            });
            chooser.show();
        });
        scriptRow.add_suffix(browseButton);

        const terminalRow = new Adw.EntryRow({title: 'Terminal command'});
        settings.bind('terminal-command', terminalRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        scriptGroup.add(terminalRow);

        // --- Sources group ---
        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Update Sources',
            description: 'One "Name|command" per line. Each command\'s stdout line-count becomes that source\'s update count. See the README for ready-made snippets (cargo, npm, pipx, uv...).',
        });
        page.add(sourcesGroup);

        const textView = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.NONE,
            top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
        });
        const buffer = textView.get_buffer();
        buffer.set_text(settings.get_strv('sources').join('\n'), -1);

        const scroller = new Gtk.ScrolledWindow({
            min_content_height: 180,
            hexpand: true,
        });
        scroller.set_child(textView);

        const frame = new Gtk.Frame();
        frame.set_child(scroller);

        const sourcesRow = new Adw.ActionRow();
        sourcesRow.set_activatable(false);
        sourcesRow.add_css_class('sources-editor-row');

        const applyButton = new Gtk.Button({
            label: 'Save Sources',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => {
            const [ok, start, end] = [true, buffer.get_start_iter(), buffer.get_end_iter()];
            const text = buffer.get_text(start, end, false);
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            settings.set_strv('sources', lines);
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        box.append(frame);
        box.append(applyButton);

        sourcesGroup.add(box);
    }
}
