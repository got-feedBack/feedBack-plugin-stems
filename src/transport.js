// The buffer transport + #audio shims — the top of the playback engine.
//
// Playhead math runs off the AudioContext clock (never an <audio> element, so
// it can't drift from the stems). transportPlay/Pause/Seek/rate drive either a
// buffer-source-per-stem graph or, in worklet mode, the single stem-mixer node;
// streaming mode delegates seeks/refills to streaming.js. installAudioShims
// makes the core <audio id="audio"> element's play/pause/currentTime/duration
// delegate to this transport whenever a sloppak is active (else to core).
//
// Upper layer: imports state + audio-ctx + streaming, and is imported by main.js
// (+ injected into streaming.js as its startPendingPlay/onWorkletMessage seam).
import { S, SH, ST, transport } from './state.js';
import { resumeCtx, updateLatencyOffset } from './audio-ctx.js';
import { repositionStream, streamOffsetBuffered } from './streaming.js';

// Scheduling lead for AudioBufferSourceNode.start(). Every stem's start() is
// given the SAME `when` so all sources begin on the identical sample; the small
// lead guarantees `when` is still in the future for all of them.
const START_LEAD = 0.03;

export function onWorkletMessage(e) {
    const msg = e && e.data;
    if (!msg) return;
    if (msg.type === 'ready') {
        if (msg.latencyOutSamples > 0) S.workletLatencyOutSamples = msg.latencyOutSamples;
        updateLatencyOffset();
    } else if (msg.type === 'ended') {
        handleNaturalEnd();
    } else if (msg.type === 'pos') {
        // Streaming backpressure: the worklet reports its read frontier so
        // the pump can top the bounded window up ahead of it.
        if (typeof msg.pos === 'number') {
            ST.lastWorkletPos = msg.pos;
            // Re-baseline the transport clock to the worklet's AUTHORITATIVE
            // read frontier. Without this, an under-run stall (worklet holds
            // pos, main clock keeps advancing off AudioContext.currentTime)
            // would leave the highway permanently ahead by the stall duration
            // once audio resumes. Re-baselining every ~20 ms also freezes the
            // highway during a stall (each urgent 'pos' resets it to the held
            // pos), so it stays in sync. Steady playback is a near-no-op (both
            // clocks track the audio clock at the same rate).
            if (ST.streaming && transport.playing && S.audioCtx && ST.streamSampleRate > 0) {
                transport.baseOffset = msg.pos / ST.streamSampleRate;
                transport.baseCtxTime = S.audioCtx.currentTime;
            }
        }
        if (ST.posWaiter) { const r = ST.posWaiter; ST.posWaiter = null; try { r(); } catch (_) {} }
    }
}

// Derive the playhead from the AudioContext clock — never from an
// <audio> element, so it cannot drift from the stems it shares `S.audioCtx`.
// "Raw" = the input read frontier, before WSOLA latency compensation.
function transportPlayheadRaw() {
    const dur = transport.duration;
    if (!transport.playing || !S.audioCtx) {
        return Math.max(0, Math.min(transport.baseOffset, dur > 0 ? dur : transport.baseOffset));
    }
    const elapsed = Math.max(0, S.audioCtx.currentTime - transport.baseCtxTime);
    const t = transport.baseOffset + elapsed * transport.rate;
    return Math.max(0, dur > 0 ? Math.min(t, dur) : t);
}

// The position the rest of slopsmith (incl. the highway) sees via the
// #audio.currentTime shim. In worklet mode while playing, shift the raw
// read frontier back by the WSOLA latency so the highway tracks what is
// actually heard. Paused/stopped and legacy mode return the raw value.
export function transportPlayhead() {
    const raw = transportPlayheadRaw();
    if (!S.useWorklet || !transport.playing || S.latencyOffsetSec <= 0) return raw;
    const dur = transport.duration;
    const t = raw - S.latencyOffsetSec;
    return Math.max(0, dur > 0 ? Math.min(t, dur) : t);
}

// Stop + release every active source node. Detaching `onended` first
// means the natural-end handler never fires for an intentional stop.
export function stopSources() {
    if (S.useWorklet) {
        // The worklet node lives for the whole song; just tell it to stop
        // advancing and go silent. It is disconnected/disposed in teardown().
        if (S.workletNode) {
            try { S.workletNode.port.postMessage({ type: 'stop' }); } catch (_) {}
        }
        return;
    }
    for (const s of S.stemState) {
        const src = s.source;
        if (!src) continue;
        try { src.onended = null; } catch (_) {}
        try { src.stop(); } catch (_) {}
        try { src.disconnect(); } catch (_) {}
        s.source = null;
    }
}

// Drive the worklet source from `offset`. The worklet flushes its WSOLA
// state and begins advancing its single read pointer, so all stems stay
// sample-locked by construction (one mix, one stretch).
function workletStartSources(offset) {
    if (!S.workletNode) return;
    const dur = transport.duration;
    const startAt = Math.max(0, dur > 0 ? Math.min(offset, dur) : offset);
    try {
        S.workletNode.port.postMessage({ type: 'start', offset: startAt, rate: transport.rate });
    } catch (_) {}
    transport.baseOffset = startAt;
    transport.baseCtxTime = S.audioCtx.currentTime;
    // Begin from the start position unless we're already at the very end;
    // a too-late offset just makes the worklet post 'ended' on the next
    // quantum, which flips playing back to false.
    transport.playing = dur <= 0 || startAt < dur;
    updateLatencyOffset();
}

// (Re)create one AudioBufferSourceNode per stem, all started at one
// shared `when` so they are sample-locked, playing from `offset`.
function startSources(offset) {
    if (!S.audioCtx) return;
    if (S.useWorklet) { workletStartSources(offset); return; }
    stopSources();
    const when = S.audioCtx.currentTime + START_LEAD;
    let longest = null;
    let longestDur = -1;
    for (const s of S.stemState) {
        if (!s.buffer) continue;
        const startOffset = Math.max(0, Math.min(offset, s.buffer.duration));
        // Seeking to/past a stem's end: the buffer is exhausted there and
        // `start(when, offset >= buffer.duration)` can throw on stricter
        // runtimes. Skip starting; nothing to play for this stem.
        if (startOffset >= s.buffer.duration) continue;
        const src = S.audioCtx.createBufferSource();
        src.buffer = s.buffer;
        try { src.playbackRate.value = transport.rate; } catch (_) {}
        src.connect(s.gain);
        try {
            src.start(when, startOffset);
        } catch (e) {
            // start() rejected — drop this node so we don't leave a
            // connected-but-never-started source dangling (its onended
            // would never fire, and a later stopSources() would throw).
            console.warn('[stems] start() failed for', s.id, e);
            try { src.disconnect(); } catch (_) {}
            continue;
        }
        s.source = src;
        if (s.buffer.duration > longestDur) { longestDur = s.buffer.duration; longest = src; }
    }
    transport.baseOffset = offset;
    transport.baseCtxTime = when;
    // "playing" only if at least one source actually started — covers a
    // seek-to-end where every stem is exhausted at `offset`.
    transport.playing = longest != null;
    // Natural end-of-song fires on the longest stem only.
    if (longest) {
        longest.onended = () => { handleNaturalEnd(); };
    }
}

// Settle every promise returned by a deferred #audio.play() — whether
// the deferred play finally started or was cancelled — so awaiting
// callers never hang.
export function flushPendingPlayResolvers() {
    if (S.pendingPlayResolvers.length === 0) return;
    const resolvers = S.pendingPlayResolvers;
    S.pendingPlayResolvers = [];
    for (const resolve of resolvers) {
        try { resolve(); } catch (_) {}
    }
}

export function transportPlay() {
    resumeCtx();
    if (!S.buffersReady) { S.pendingPlay = true; return; }
    if (transport.playing) { flushPendingPlayResolvers(); return; }
    let offset = transportPlayhead();
    if (transport.duration > 0 && offset >= transport.duration - 0.001) offset = 0;
    // Streaming: if the window doesn't cover this offset (replay from 0 after
    // EOF, or the pump has drained), refetch from here before starting. The
    // worklet stalls to silence until the refill reaches `offset`, then plays.
    if (ST.streaming && !streamOffsetBuffered(offset)) {
        transport.baseOffset = offset;
        repositionStream(offset);
    }
    startSources(offset);
    // startSources may have skipped every stem (all exhausted at offset).
    // Only fire `play` if playback actually began.
    if (transport.playing) dispatchAudioEvent('play');
    flushPendingPlayResolvers();
}

function transportPause() {
    S.pendingPlay = false;
    flushPendingPlayResolvers();
    if (!transport.playing) return;
    const ph = transportPlayhead();
    stopSources();
    transport.baseOffset = ph;
    transport.playing = false;
    dispatchAudioEvent('pause');
}

// A user STOP is NOT a song end. Core emits `playback:stopped` from its
// _stop command handler (static/capabilities/playback.js:880) on a manual
// STOP — a `stop` is a user-priority action, distinct from `playback:ended`
// which core only emits at genuine song end (transportEvent('ended') <-
// song:ended bridge, playback.js:1018/1074). A manual stop must therefore
// NOT destroy the stem graph: the session can resume. Halt our sources and
// freeze the playhead, but PRESERVE the decoded buffers, gain graph and
// mixer UI so a resume/replay re-locks instantly instead of re-fetching.
// Full teardown() stays reserved for playback:ended and the new-song-load /
// screen-leave paths.
export function lightStop() {
    S.pendingPlay = false;
    flushPendingPlayResolvers();
    if (!transport.playing) return;
    const ph = transportPlayhead();
    stopSources();
    transport.baseOffset = ph;
    transport.playing = false;
}

function transportSeek(t) {
    const dur = transport.duration;
    let target = Number(t);
    if (!Number.isFinite(target)) return;
    target = Math.max(0, dur > 0 ? Math.min(target, dur) : target);
    if (ST.streaming) {
        // Streaming: flush the bounded window and refetch every track from
        // the target (repositionStream posts the worklet 'seek'). Re-baseline
        // the clock; works whether or not we're currently playing.
        transport.baseOffset = target;
        transport.baseCtxTime = S.audioCtx ? S.audioCtx.currentTime : 0;
        repositionStream(target);
    } else if (S.useWorklet) {
        // Tell the worklet to move its read pointer and flush WSOLA state
        // so no stale stretched audio bleeds across the seek. Re-baseline
        // the clock; works whether or not we're currently playing.
        if (S.workletNode) {
            try { S.workletNode.port.postMessage({ type: 'seek', offset: target }); } catch (_) {}
        }
        transport.baseOffset = target;
        transport.baseCtxTime = S.audioCtx ? S.audioCtx.currentTime : 0;
    } else if (transport.playing) {
        // Stop + recreate all sources at the new offset so they relock.
        startSources(target);
    } else {
        transport.baseOffset = target;
    }
    // Mirror HTMLMediaElement's async seeking/seeked so listeners that
    // attach right after writing currentTime still receive them.
    Promise.resolve().then(() => {
        dispatchAudioEvent('seeking');
        dispatchAudioEvent('seeked');
    });
}

function setTransportRate(r) {
    const rate = Number(r);
    if (!Number.isFinite(rate) || rate <= 0) return;
    if (transport.rate === rate) return;
    if (transport.playing && S.audioCtx) {
        // Re-baseline so the playhead stays continuous across the change.
        // Use the RAW frontier (not latency-compensated): the new latency
        // offset is re-applied forward, so capturing the compensated value
        // here would double-count it and jump the reported time.
        transport.baseOffset = transportPlayheadRaw();
        transport.baseCtxTime = S.audioCtx.currentTime;
    }
    transport.rate = rate;
    if (S.useWorklet) {
        if (S.workletNode) {
            try { S.workletNode.port.postMessage({ type: 'rate', rate }); } catch (_) {}
        }
        updateLatencyOffset();
    } else {
        for (const s of S.stemState) {
            if (s.source) {
                try { s.source.playbackRate.value = rate; } catch (_) {}
            }
        }
    }
}

function handleNaturalEnd() {
    if (!S.sloppakActive) return;
    transport.baseOffset = transport.duration;
    transport.playing = false;
    stopSources();
    dispatchAudioEvent('ended');
}

function dispatchAudioEvent(type) {
    const core = document.getElementById('audio');
    if (!core) return;
    try { core.dispatchEvent(new Event(type)); } catch (_) {}
}

// ── #audio transport shims ──
// Installed once. Each member delegates to the captured core implementation
// when no sloppak is active, so archive songs and the JUCE desktop path behave
// exactly as before. Shim state (SH.shimsInstalled/SH.shimsUsable + captured
// core descriptors) lives in the SH container in state.js.

export function nativeCorePaused(core) {
    try {
        if (SH.corePausedDesc && SH.corePausedDesc.get) return SH.corePausedDesc.get.call(core);
        return core.paused;
    } catch (_) { return true; }
}
export function nativeCorePause(core) {
    try {
        if (typeof SH.coreNativePause === 'function') SH.coreNativePause();
        else core.pause();
    } catch (_) {}
}
export function nativeCoreTime(core) {
    try {
        if (SH.coreCurrentTimeDesc && SH.coreCurrentTimeDesc.get) {
            const t = Number(SH.coreCurrentTimeDesc.get.call(core));
            return Number.isFinite(t) ? Math.max(0, t) : 0;
        }
        const t = Number(core.currentTime);
        return Number.isFinite(t) ? Math.max(0, t) : 0;
    } catch (_) { return 0; }
}

export function installAudioShims() {
    if (SH.shimsInstalled) return;
    const core = document.getElementById('audio');
    if (!core) return;  // #audio not in DOM yet — retry-able from onSongReady().

    // From this point we begin mutating `core`: capture descriptors and
    // attempt shims. Flip the re-entry guard NOW so a retry call doesn't
    // recapture our own shimmed descriptors (which would self-recurse on
    // delegation). `SH.shimsUsable` separately tracks whether the critical
    // shims actually succeeded; onSongReady() gates the transport on that.
    SH.shimsInstalled = true;

    SH.coreCurrentTimeDesc = Object.getOwnPropertyDescriptor(core, 'currentTime')
        || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    SH.corePausedDesc = Object.getOwnPropertyDescriptor(core, 'paused')
        || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
    SH.coreDurationDesc = Object.getOwnPropertyDescriptor(core, 'duration')
        || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
    SH.coreNativePlay = core.play.bind(core);
    SH.coreNativePause = core.pause.bind(core);

    // Track success of the three CRITICAL shims (currentTime + play + pause).
    // Without all three the transport can't drive the highway, so onSongReady()
    // refuses to take over. `paused` and `duration` are useful but not gating.
    let ctOk = false, playOk = false, pauseOk = false;

    // Each shim is installed independently and defensively: Object.defineProperty
    // can throw on some runtimes, and a single failure must not abort the rest
    // of plugin init. A member that fails to shim simply keeps native behaviour.
    if (SH.coreCurrentTimeDesc && SH.coreCurrentTimeDesc.get) {
        try {
            Object.defineProperty(core, 'currentTime', {
                configurable: true,
                get() {
                    if (S.sloppakActive) return transportPlayhead();
                    return SH.coreCurrentTimeDesc.get.call(this);
                },
                set(v) {
                    if (S.sloppakActive) { transportSeek(v); return; }
                    if (SH.coreCurrentTimeDesc.set) SH.coreCurrentTimeDesc.set.call(this, v);
                },
            });
            ctOk = true;
        } catch (e) { console.warn('[stems] currentTime shim install failed:', e); }
    }
    if (SH.corePausedDesc && SH.corePausedDesc.get) {
        try {
            Object.defineProperty(core, 'paused', {
                configurable: true,
                get() {
                    if (S.sloppakActive) return !transport.playing;
                    return SH.corePausedDesc.get.call(this);
                },
            });
        } catch (e) { console.warn('[stems] paused shim install failed:', e); }
    }
    if (SH.coreDurationDesc && SH.coreDurationDesc.get) {
        try {
            Object.defineProperty(core, 'duration', {
                configurable: true,
                get() {
                    if (S.sloppakActive && transport.duration > 0) return transport.duration;
                    return SH.coreDurationDesc.get.call(this);
                },
            });
        } catch (e) { console.warn('[stems] duration shim install failed:', e); }
    }
    // play/pause are installed with Object.defineProperty rather than a plain
    // `core.play = fn` assignment. iOS WebKit exposes HTMLMediaElement.play /
    // .pause as non-writable, so the assignment throws "Attempted to assign to
    // readonly property" in this plugin's strict-mode (ES module) context —
    // which left playOk/pauseOk false, so onSongReady() refused the takeover
    // and the browser played only stems[0] (single stem, dead mixer sliders).
    // Chromium/Electron silently allow the assignment, so this only bit on iOS.
    // Defining an OWN property on the instance sidesteps the prototype's
    // writability and works on both engines — matching the currentTime/paused/
    // duration shims above, which already use defineProperty.
    try {
        Object.defineProperty(core, 'play', {
            configurable: true,
            writable: true,
            value: function () {
                if (S.sloppakActive) {
                    transportPlay();
                    // Resolve immediately if playback actually started; otherwise
                    // return a promise that settles when the deferred play starts
                    // (or is cancelled), matching HTMLMediaElement.play()'s
                    // "resolves once playback begins" contract.
                    if (transport.playing || !S.pendingPlay) return Promise.resolve();
                    return new Promise((resolve) => { S.pendingPlayResolvers.push(resolve); });
                }
                return SH.coreNativePlay();
            },
        });
        playOk = true;
    } catch (e) { console.warn('[stems] play shim install failed:', e); }
    try {
        Object.defineProperty(core, 'pause', {
            configurable: true,
            writable: true,
            value: function () {
                if (S.sloppakActive) { transportPause(); return; }
                return SH.coreNativePause();
            },
        });
        pauseOk = true;
    } catch (e) { console.warn('[stems] pause shim install failed:', e); }
    // The slopsmith speed slider writes #audio.playbackRate; mirror it
    // onto every live buffer source.
    core.addEventListener('ratechange', () => {
        if (S.sloppakActive) setTransportRate(core.playbackRate);
    });

    SH.shimsUsable = ctOk && playOk && pauseOk;
}
