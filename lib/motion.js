import St from 'gi://St';
import Clutter from 'gi://Clutter';

// Keep GNOME Shell-specific animation preferences out of the general
// subprocess and parsing helpers so those helpers can be tested separately.
export function hasMotion() {
    try {
        const stSettings = St.Settings.get();
        if (stSettings && 'enable_animations' in stSettings && stSettings.enable_animations === false)
            return false;
        if (St.ReducedMotion) {
            const {reducedMotion} = stSettings;
            if (reducedMotion === St.ReducedMotion.REDUCE) return false;
        }
    } catch (e) {}
    try {
        const clutterSettings = Clutter.Settings.get_default?.();
        if (clutterSettings && 'enable_animations' in clutterSettings && clutterSettings.enable_animations === false)
            return false;
    } catch (e) {}
    return true;
}

export function shouldAnimate() { return hasMotion(); }
