// Shared plugin state that is a data-structure *container* — never reassigned,
// so it imports cleanly and mutations flow through the imported binding. The
// reassigned scalars (ctx, stemState, masterGain, workletNode, …) still live in
// main.js pending the accessor refactor (next migration step).

// The buffer transport replaces the 6 HTMLMediaElement decoder clocks — playhead
// math runs off the AudioContext clock.
export const transport = {
    playing: false,
    baseOffset: 0,     // playhead (s) captured at baseCtxTime
    baseCtxTime: 0,    // ctx.currentTime when the current run started
    rate: 1,           // uniform AudioBufferSourceNode.playbackRate
    duration: 0,       // max decoded buffer length (s)
};

export const registeredMixParticipantIds = new Set();
export const pointerCleanupHandlers = new Set();
export const claimSnapshots = new Map();  // claimId:stemId -> previous session-only state
