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

// The reassigned mutable scalars (audio graph, worklet + decode flags, current
// song). Grouped in one object `S` because ES imports are read-only bindings —
// a plain `export let` can't be reassigned from main.js, but `S.x = …` can.
// (ctx is exported as `audioCtx` to avoid the capability-command `ctx` params.)
export const S = {
    audioCtx: null,                 // shared AudioContext (reused across songs)
    masterGain: null,               // sums every stem; driven by the Song fader
    analyserNode: null,             // tap off masterGain for audio-reactive plugins
    songFaderBridgeInstalled: false,
    priorSetMasterVolume: undefined,
    stemState: [],                  // [{ id, url, default, buffer, source, gain, on, vol, btn, volFill }]
    wired: false,                   // playSong hooks installed
    container: null,                // UI container in #player-controls
    currentFilename: null,
    currentSongKey: null,
    pollHandle: null,
    readySignature: null,
    sloppakActive: false,           // true while a sloppak owns #audio transport
    buffersReady: false,            // true once all stems are decoded + graphed
    pendingPlay: false,             // a play() arrived before buffers were ready
    pendingPlayResolvers: [],       // resolve fns for #audio.play() promises awaiting a deferred start
    loadGeneration: 0,              // bumped on every song change / teardown
    abortController: null,          // aborts in-flight stem fetches
    overlayEl: null,                // "Decoding stems…" loading overlay
    workletNode: null,              // the 'stem-mixer' source node (worklet mode)
    workletReady: false,            // audioWorklet.addModule() resolved
    workletModulePromise: null,     // in-flight addModule() (memoised)
    useWorklet: false,              // this song is using the worklet path
    workletWarned: false,           // logged the legacy-mode fallback once
    workletPostReady: false,        // safe to post 'gain' (after 'load' sent)
    workletLatencyOutSamples: 0,    // WSOLA output latency (output samples)
    latencyOffsetSec: 0,            // that latency expressed in song time
    fullTrackIndex: -1,
};

// #audio transport-shim state (reassigned scalars → container, same reason as S).
// Captured core descriptors + native play/pause, and the install/usable guards.
// Read across the transport layer + onSongReady, so it lives here, not module-
// private to the (future) shims module.
export const SH = {
    shimsInstalled: false,       // re-entry guard (prevents recapture/double-define)
    shimsUsable: false,          // critical shims (currentTime + play + pause) all succeeded
    coreCurrentTimeDesc: null,
    corePausedDesc: null,
    coreDurationDesc: null,
    coreNativePlay: null,
    coreNativePause: null,
};

// Streaming-path state (reassigned scalars → container, same reason as S). The
// bounded-window streaming pump feeds the worklet ahead of its read frontier;
// these track that path. Read across transport + onWorkletMessage + onSongReady.
export const ST = {
    streaming: false,          // this song is using the streaming path
    streamTracks: [],          // [{ url, nch, byteAlign, totalFrames, reader, leftover, done, skipBytes }]
    streamSampleRate: 0,
    streamTotalSamples: 0,     // transport length in samples (max stem)
    jsWriteFrontier: 0,        // next absolute sample the pump will append
    pumpStop: false,
    lastWorkletPos: 0,         // worklet read frontier (samples), via 'pos'
    posWaiter: null,           // resolve fn for a pump await on next 'pos'
    streamSeekToken: 0,        // invalidates a superseded seek refetch
};
