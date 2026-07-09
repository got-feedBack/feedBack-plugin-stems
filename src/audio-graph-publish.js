// Publish the live audio graph (context + masterGain) on
// window.slopsmith.stems.audioGraph so the host shell can observe/re-route
// the stem mix — e.g. the desktop renderer-bus feeder taps masterNode when
// the output device is exclusive-style (feedBack Phase 2). Deliberately
// deployment-agnostic: this plugin only says "here is my master"; what the
// host does with it is the host's business.
import { S } from './state.js';

export function publishAudioGraph() {
    if (!window.slopsmith || !window.slopsmith.stems
            || typeof window.slopsmith.stems !== 'object') return;
    if (!S.audioCtx || !S.masterGain) return;
    window.slopsmith.stems.audioGraph = { context: S.audioCtx, masterNode: S.masterGain };
}

// Retract only if the published graph is still ours: the AudioContext is
// reused across songs, so identity is the masterGain node, not the context.
// A newer graph published between our build and teardown must not be
// clobbered. Call BEFORE S.masterGain is nulled.
export function retractAudioGraph() {
    const g = window.slopsmith?.stems?.audioGraph;
    if (g && S.masterGain && g.masterNode === S.masterGain) {
        delete window.slopsmith.stems.audioGraph;
    }
}
