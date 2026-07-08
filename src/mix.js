// Imperative mix routing: pushes the gains computed by mix-gains.js into the
// worklet, and the per-stem GainNode stand-in that external consumers write to.
// (mix-gains.js is the pure computation; this is the side-effecting worklet post.)
import { S } from './state.js';
import { computeMixGains } from './mix-gains.js';

// Recompute every stem's gain from S.stemState and post them to the worklet.
// No-op unless the worklet is live and ready to receive gain messages.
export function applyMixRouting() {
    if (!(S.useWorklet && S.workletNode && S.workletPostReady)) return;
    const { stemGains, fullGain } = computeMixGains(S.stemState, S.fullTrackIndex >= 0);
    for (let i = 0; i < stemGains.length; i++) {
        try { S.workletNode.port.postMessage({ type: 'gain', index: i, value: stemGains[i] }); } catch (_) {}
    }
    if (S.fullTrackIndex >= 0 && fullGain != null) {
        try { S.workletNode.port.postMessage({ type: 'gain', index: S.fullTrackIndex, value: fullGain }); } catch (_) {}
    }
}

// A stand-in for a per-stem GainNode that forwards volume changes to the
// worklet instead. Exposes the same `.gain.value` / `.connect` / `.disconnect`
// surface so every existing `s.gain.gain.value = …` write and the public
// window.stems API keep working unchanged in worklet mode.
export function makeStemGainHandle(index) {
    let value = 0;
    const gain = {};
    Object.defineProperty(gain, 'value', {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(nv) {
            const num = Number(nv);
            value = Number.isFinite(num) ? num : 0;
            // With a pristine full-mix track loaded, every stem change must
            // re-evaluate unity routing (which also flips the full track), so
            // route through applyMixRouting; it posts the authoritative gain
            // for this and every other track. Without a full mix, keep the
            // original direct per-stem post (byte-identical behaviour).
            if (S.fullTrackIndex >= 0) {
                // applyMixRouting recomputes every gain from S.stemState. The
                // internal toggle/volume paths set S.stemState first, but an
                // EXTERNAL direct `gain.value = v` write doesn't — so reflect
                // a positive write into the authoritative volume here, else
                // routing would ignore it. (A 0 write is left to setMuted,
                // which can distinguish "muted" from "0% volume".)
                if (value > 0 && S.stemState[index]) S.stemState[index].vol = value;
                applyMixRouting();
            } else if (S.workletPostReady && S.workletNode) {
                try { S.workletNode.port.postMessage({ type: 'gain', index, value }); } catch (_) {}
            }
        },
    });
    // connect/disconnect are no-ops: external consumers (e.g. stem_mixer)
    // may call them on the "gain node", but mixing now lives in the worklet.
    return { gain, connect() {}, disconnect() {} };
}
