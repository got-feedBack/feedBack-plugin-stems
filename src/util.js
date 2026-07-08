// Pure, state-free helpers. No DOM / no module state — real-import tested in
// tests/util.test.mjs.

// Clamp a volume to [0, 1]; null for non-finite input (so callers can reject it).
export function clampVolume(volume) {
    const numeric = Number(volume);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(1, numeric));
}

// Coerce common non-boolean inputs ('false', '0', '', null) to false so external
// callers can't accidentally mute by passing a string.
export function coerceBool(v) {
    if (v === 'false' || v === '0' || v === '' || v == null) return false;
    return Boolean(v);
}

// FNV-1a → base36. Used to derive a stable, non-reversible key from a legacy
// filename for redacted capability payloads.
export function hashString(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

// True for stem ids that name a guitar part (guitar/rhythm/lead/dist), for the
// 'guitar' capability selector.
export function isGuitarStemId(id) {
    return /(^|[-_\s])(guitars?|rhythm|lead|dist|distortion)([-_\s]|$)/i.test(String(id || ''));
}
