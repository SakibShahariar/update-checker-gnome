import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {getUpdatableSources, getHighImpactUpdateCommands} from './utils.js';

export function refreshUpdateAllItem(indicator) {
    if (!indicator._updateAllItem)
        return;
    const queue = indicator._updateAllQueue;
    if (queue) {
        indicator._updateAllItem.visible = true;
        indicator._updateAllItem.label.set_text(`Update all in progress (${queue.completed}/${queue.items.length})`);
        return;
    }
    const sources = indicator._lastRenderSources ?? [];
    const results = indicator._lastRenderResults ?? [];
    const commands = indicator._lastRenderUpdateCommands ?? new Map();
    const count = getUpdatableSources(sources, results, commands).length;
    indicator._updateAllItem.visible = count > 0;
    indicator._updateAllItem.label.set_text(`Update all available (${count})`);
}

export function runUpdateAll(indicator) {
    if (indicator._destroyed || indicator._checking)
        return Main.notify('Update Checker', 'Wait for the current check to finish before updating all sources.');
    if (indicator._updateAllQueue)
        return Main.notify('Update Checker', 'An Update all queue is already running.');
    if (indicator._updatingSources.size > 0)
        return Main.notify('Update Checker', 'Wait for the current update to finish before starting Update all.');
    const sources = indicator._lastRenderSources ?? [];
    const results = indicator._lastRenderResults ?? [];
    const commands = indicator._lastRenderUpdateCommands ?? new Map();
    const items = getUpdatableSources(sources, results, commands);
    if (items.length === 0)
        return Main.notify('Update Checker', 'No sources have pending updates and a configured update command.');
    if (indicator._settings.get_boolean('confirm-update-all')) {
        const riskyCommands = getHighImpactUpdateCommands(items);
        if (riskyCommands.length > 0) {
            const details = riskyCommands.slice(0, 6).map(item =>
                `• ${item.name}: ${item.command.slice(0, 180)}${item.command.length > 180 ? '…' : ''}`
            ).join('\\n');
            const remaining = riskyCommands.length > 6
                ? `\\n…and ${riskyCommands.length - 6} more high-impact command(s).`
                : '';
            const dialog = new ModalDialog.ModalDialog();
            dialog.contentLayout.add_child(new St.Label({
                text: `Update all will run privileged or potentially destructive commands:\\n\\n${details}${remaining}\\n\\nReview these commands before continuing.`,
                style_class: 'prompt-dialog-description',
                x_expand: true,
            }));
            dialog.setButtons([
                {
                    label: 'Cancel',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                },
                {
                    label: 'Run Update all',
                    action: () => {
                        dialog.close();
                        indicator._beginUpdateAll(items);
                    },
                    default: true,
                    key: Clutter.KEY_Return,
                },
            ]);
            dialog.open();
            return;
        }
    }
    indicator._beginUpdateAll(items);
}

export function beginUpdateAll(indicator, items) {
    if (indicator._destroyed || indicator._checking || indicator._updateAllQueue ||
        indicator._updatingSources.size > 0)
        return Main.notify('Update Checker', 'The update state changed. Run Update all again after current work finishes.');
    indicator._updateAllQueue = {items, index: 0, completed: 0, activeLabel: null};
    indicator._refreshUpdateAllItem();
    indicator._updateSyncIconState();
    indicator._advanceUpdateAllQueue();
}

export function advanceUpdateAllQueue(indicator) {
    const queue = indicator._updateAllQueue;
    if (!queue || indicator._destroyed || indicator._updatingSources.size > 0)
        return;
    if (queue.index >= queue.items.length) {
        const completed = queue.completed;
        const total = queue.items.length;
        indicator._updateAllQueue = null;
        indicator._refreshUpdateAllItem();
        indicator._updateSyncIconState();
        indicator._statusItem.label.set_text(`Update all finished · ${completed}/${total} commands`);
        indicator.checkNow(true);
        return;
    }
    const item = queue.items[queue.index++];
    queue.activeLabel = item.name;
    indicator._statusItem.label.set_text(`Update all ${queue.index}/${queue.items.length}: ${item.name}`);
    indicator._refreshUpdateAllItem();
    indicator._runSourceUpdate(item.command, item.name);
    if (!indicator._updatingSources.has(item.name)) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (indicator._updateAllQueue !== queue || queue.activeLabel !== item.name)
                return GLib.SOURCE_REMOVE;
            queue.activeLabel = null;
            queue.completed++;
            indicator._advanceUpdateAllQueue();
            return GLib.SOURCE_REMOVE;
        });
    }
}

export function cancelUpdateAllQueue(indicator) {
    if (!indicator._updateAllQueue)
        return;
    indicator._updateAllQueue = null;
    indicator._refreshUpdateAllItem();
    indicator._updateSyncIconState();
    indicator._statusItem.label.set_text('Update all cancelled');
    if (indicator._updatingSources.size === 0)
        indicator.checkNow(true);
}
