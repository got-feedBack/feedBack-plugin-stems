// Per-song + default stem persistence (localStorage). No shared module state —
// real-import tested with a storage stub in tests/prefs.test.mjs.

const KARAOKE_KEY = 'stemsKaraokeDefault';
const DEFAULT_MUTED_KEY = 'stemsDefaultMuted'; // JSON array of stem ids
const MUTE_KEY_PREFIX = 'stemsMute:';  // per-song muted stem ids
const VOL_KEY_PREFIX = 'stemsVol:';    // per-song volume overrides (id -> 0..1)

export function karaokeDefault() {
    try { return localStorage.getItem(KARAOKE_KEY) === '1'; }
    catch (_) { return false; }
}
export function setKaraokeDefault(on) {
    try { localStorage.setItem(KARAOKE_KEY, on ? '1' : '0'); } catch (_) {}
}

export function loadDefaultMuted() {
    try {
        const raw = localStorage.getItem(DEFAULT_MUTED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
}
export function saveDefaultMuted(set) {
    try { localStorage.setItem(DEFAULT_MUTED_KEY, JSON.stringify([...set])); }
    catch (_) {}
}

export function loadMuted(filename) {
    if (!filename) return null;
    try {
        const raw = localStorage.getItem(MUTE_KEY_PREFIX + filename);
        if (!raw) return null;
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set(arr) : null;
    } catch (_) { return null; }
}
export function saveMuted(filename, stemStateArr) {
    if (!filename) return;
    const muted = stemStateArr.filter(s => !s.on).map(s => s.id);
    try { localStorage.setItem(MUTE_KEY_PREFIX + filename, JSON.stringify(muted)); }
    catch (_) {}
}

export function loadVolumes(filename) {
    if (!filename) return {};
    try {
        const raw = localStorage.getItem(VOL_KEY_PREFIX + filename);
        const v = raw ? JSON.parse(raw) : {};
        // Must be a plain object: an array/scalar would make saveVolume() stringify
        // an array and silently drop string-keyed volume entries.
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (_) { return {}; }
}
export function saveVolume(filename, id, vol) {
    if (!filename) return;
    try {
        const cur = loadVolumes(filename);
        cur[id] = vol;
        localStorage.setItem(VOL_KEY_PREFIX + filename, JSON.stringify(cur));
    } catch (_) {}
}
