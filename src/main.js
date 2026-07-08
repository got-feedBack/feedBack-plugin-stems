import { computeMixGains } from './mix-gains.js';
import { parseWavHeader, pcm16ToFloat32 } from './wav-pcm.js';
import {
    karaokeDefault, setKaraokeDefault,
    loadDefaultMuted, saveDefaultMuted,
    loadMuted, saveMuted, loadVolumes, saveVolume,
} from './prefs.js';
import {
    S, transport, registeredMixParticipantIds, pointerCleanupHandlers, claimSnapshots,
} from './state.js';

(function () {
    'use strict';

    /* ======================================================================
     *  Stems Toggle Plugin — sample-locked playback
     *  For sloppak songs with multiple stems, every stem is fetched and
     *  decoded once into an AudioBuffer, then played through an
     *  AudioBufferSourceNode. All sources are start()-ed at the same
     *  AudioContext time, so the stems — and the note highway that clocks
     *  off them — are sample-exact and cannot drift.
     *
     *  The core <audio id="audio"> element is no longer used as an audio
     *  source. Instead its play/pause/currentTime/duration/paused members
     *  are shimmed to drive the buffer transport, and the transport
     *  dispatches the matching media events so the rest of slopsmith keeps
     *  working unchanged. archive songs (no stems) and the JUCE desktop path
     *  are left completely untouched — the shims delegate to core when no
     *  sloppak is active.
     * ====================================================================== */

    const OFF_CLASS = 'px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded-md text-[11px] text-gray-400 transition';
    const ON_CLASS  = 'px-2 py-1 bg-accent/30 hover:bg-accent/40 rounded-md text-[11px] text-accent-light transition';

    // Persistence keys + load/save helpers → src/prefs.js (imported above).
    const COMMON_STEMS = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'];
    const DRAG_THRESHOLD_PX = 4;
    const KEYBOARD_VOLUME_STEP = 0.02;
    const KEYBOARD_VOLUME_STEP_LARGE = 0.1;
    const PRIMARY_BUTTON_MASK = 1;
    // Scheduling lead for AudioBufferSourceNode.start(). Every stem's start()
    // is given the SAME `when` so all 6 sources begin on the identical sample;
    // the small lead guarantees `when` is still in the future for all of them.
    const START_LEAD = 0.03;

    // Base URL of this plugin's served assets, e.g. "/api/plugins/stems/".
    // Worklet from our own assets/ (no CDN). From src/main.js, assets/ is one
    // level up; import.meta.url is the module URL (currentScript is null here).
    const WORKLET_URL = new URL('../assets/stretch-worklet.js', import.meta.url).href;

    // ── Plugin state ──
    // The Song-fader bridge (window.slopsmith.stems.setMasterVolume) is a
    // shared global. Track whether WE installed it and snapshot whatever was
    // there first, so teardown() restores the prior value instead of blindly
    // deleting another plugin's hook.
    // Pending poll fallback for the cold-load race. Tracked at module
    // scope so teardown() can cancel it whenever the previous play is
    // abandoned (new song, or leaving the player).
    // transport + the Set/Map state containers → src/state.js (imported above).

    // ── Pitch-preserving time-stretch worklet ──
    // When available, a single AudioWorkletNode ('stem-mixer') OWNS every
    // stem's PCM and acts as the source: it mixes all stems and WSOLA-stretches
    // the single mix so the speed slider changes tempo without pitch (matching
    // archive's HTMLMediaElement.preservesPitch). When unavailable, we fall back
    // to today's AudioBufferSourceNode-per-stem path (speed couples pitch).
                                       // 0 = unknown → no compensation until the
                                       // worklet's 'ready' message reports it.
    // Pristine full-mix track (feedBack#580 / core #583). When a sloppak ships
    // a pre-separation `original_audio` mixdown, we load it as one extra worklet
    // track and play IT instead of the lossy demucs recombination whenever every
    // stem is on at 100% ("unity"); the moment any stem is muted/attenuated we
    // cross to the separated stems. Worklet path only; -1 = no full-mix track.

    // --- computeMixGains (pure; node-testable, see tests/mix-routing.test.mjs) ---
    // Given each stem's {on, vol} and whether a pristine full-mix track is
    // loaded, return the worklet gains. At unity (a full mix is present AND every
    // stem is on at ~100%) the full mix plays alone and the stems are silent;
    // otherwise the stems mix at their own gains and the full mix is silent.
    // computeMixGains → src/mix-gains.js (imported above).

    // Post the authoritative gain for every track (stems + the full mix) to the
    // worklet, honouring the unity → full-mix routing. Called on any stem change
    // (via the gain handle below) when a full-mix track exists.
    function applyMixRouting() {
        if (!(S.useWorklet && S.workletNode && S.workletPostReady)) return;
        const { stemGains, fullGain } = computeMixGains(S.stemState, S.fullTrackIndex >= 0);
        for (let i = 0; i < stemGains.length; i++) {
            try { S.workletNode.port.postMessage({ type: 'gain', index: i, value: stemGains[i] }); } catch (_) {}
        }
        if (S.fullTrackIndex >= 0 && fullGain != null) {
            try { S.workletNode.port.postMessage({ type: 'gain', index: S.fullTrackIndex, value: fullGain }); } catch (_) {}
        }
    }

    function cleanupPointerHandlers() {
        for (const cleanup of pointerCleanupHandlers) {
            try { cleanup(); } catch (_) {}
        }
    }

    // ── Settings ──
    const karaokeToggle = document.getElementById('stems-toggle-karaoke');
    if (karaokeToggle) {
        karaokeToggle.checked = karaokeDefault();
        karaokeToggle.addEventListener('change', () => {
            setKaraokeDefault(karaokeToggle.checked);
        });
    }
    const defMutedHost = document.getElementById('stems-toggle-startup-muted');
    if (defMutedHost) {
        const muted = loadDefaultMuted();
        defMutedHost.innerHTML = '';
        for (const id of COMMON_STEMS) {
            const lbl = document.createElement('label');
            lbl.className = 'flex items-center gap-1.5 text-xs text-gray-300 px-2 py-1 bg-dark-700 rounded';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'accent-accent';
            cb.checked = muted.has(id);
            cb.addEventListener('change', () => {
                const cur = loadDefaultMuted();
                if (cb.checked) cur.add(id); else cur.delete(id);
                saveDefaultMuted(cur);
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(' ' + id));
            defMutedHost.appendChild(lbl);
        }
    }

    function clampVolume(volume) {
        const numeric = Number(volume);
        if (!Number.isFinite(numeric)) return null;
        return Math.max(0, Math.min(1, numeric));
    }

    // Song-level gain (0..1) from the core audio mixer / persisted volume.
    // Used to seed the master gain so stems open at the level the Song fader
    // will drive them to.
    function persistedSongGain() {
        try {
            const read = window.slopsmith && window.slopsmith.audio
                && window.slopsmith.audio.readSongVolume;
            if (typeof read === 'function') {
                const pct = Number(read());
                if (Number.isFinite(pct)) return Math.max(0, Math.min(1, pct / 100));
            }
            const stored = parseFloat(localStorage.getItem('volume'));
            if (Number.isFinite(stored)) return Math.max(0, Math.min(1, stored / 100));
        } catch (_) { /* localStorage blocked */ }
        return 0.8;
    }

    function ensureCtx() {
        if (!S.audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            S.audioCtx = new AC();
        }
        return S.audioCtx;
    }

    // Resume the AudioContext if suspended, swallowing BOTH a synchronous
    // throw and the async rejection AudioContext.resume() produces when the
    // browser blocks resume outside a user gesture.
    function resumeCtx() {
        if (!S.audioCtx || S.audioCtx.state !== 'suspended') return;
        try {
            const p = S.audioCtx.resume();
            if (p && p.catch) p.catch(() => {});
        } catch (_) { /* resume unsupported */ }
    }

    // Register the time-stretch worklet module once. Resolves to true when the
    // worklet is usable, false to signal the caller to fall back to legacy
    // (pitch-coupling) playback. Memoised; a failed load is retried next song.
    function ensureWorklet() {
        if (S.workletReady) return Promise.resolve(true);
        if (S.workletModulePromise) return S.workletModulePromise;
        if (!S.audioCtx || !S.audioCtx.audioWorklet || !WORKLET_URL) return Promise.resolve(false);
        S.workletModulePromise = S.audioCtx.audioWorklet.addModule(WORKLET_URL)
            .then(() => { S.workletReady = true; return true; })
            .catch((e) => {
                // Log once, not every song — a missing core asset route (404)
                // would otherwise spam the console on each load.
                if (!S.workletWarned) {
                    console.warn('[stems] worklet module load failed; using legacy mode:', e);
                    S.workletWarned = true;
                }
                S.workletModulePromise = null; // allow a retry on the next song
                return false;
            });
        return S.workletModulePromise;
    }

    // WSOLA buffers audio internally, so what is HEARD lags the read frontier
    // by a fixed number of output samples (worklet 'ready' reports it). In song
    // time that lag scales with the rate. At rate 1.0 the worklet is an exact
    // pass-through (no stretch, no latency), so the offset is zero.
    function updateLatencyOffset() {
        if (S.useWorklet && S.audioCtx && S.workletLatencyOutSamples > 0
                && Math.abs(transport.rate - 1) > 1e-6) {
            S.latencyOffsetSec = (S.workletLatencyOutSamples / S.audioCtx.sampleRate) * transport.rate;
        } else {
            S.latencyOffsetSec = 0;
        }
    }

    // A stand-in for a per-stem GainNode that forwards volume changes to the
    // worklet instead. Exposes the same `.gain.value` / `.connect` / `.disconnect`
    // surface so every existing `s.gain.gain.value = …` write and the public
    // window.stems API keep working unchanged in worklet mode.
    function makeStemGainHandle(index) {
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

    function onWorkletMessage(e) {
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
                lastWorkletPos = msg.pos;
                // Re-baseline the transport clock to the worklet's AUTHORITATIVE
                // read frontier. Without this, an under-run stall (worklet holds
                // pos, main clock keeps advancing off AudioContext.currentTime)
                // would leave the highway permanently ahead by the stall duration
                // once audio resumes. Re-baselining every ~20 ms also freezes the
                // highway during a stall (each urgent 'pos' resets it to the held
                // pos), so it stays in sync. Steady playback is a near-no-op (both
                // clocks track the audio clock at the same rate).
                if (streaming && transport.playing && S.audioCtx && streamSampleRate > 0) {
                    transport.baseOffset = msg.pos / streamSampleRate;
                    transport.baseCtxTime = S.audioCtx.currentTime;
                }
            }
            if (posWaiter) { const r = posWaiter; posWaiter = null; try { r(); } catch (_) {} }
        }
    }

    function updateStemButton(stem, options = {}) {
        if (!stem.btn) return;
        const volume = clampVolume(stem.vol);
        const percent = Math.round((volume == null ? 0 : volume) * 100);
        stem.btn.className = stem.on ? ON_CLASS : OFF_CLASS;
        if (options.updateA11y !== false) {
            stem.btn.title = `Click: toggle ${stem.id}. Drag left/right: set volume (${percent}%).`;
            stem.btn.setAttribute('aria-pressed', stem.on ? 'true' : 'false');
            stem.btn.setAttribute('aria-label', `${stem.id} stem, ${stem.on ? 'on' : 'muted'}, volume ${percent}%`);
        }
        if (stem.volFill) {
            stem.volFill.className = stem.on ? 'bg-accent/40' : 'bg-dark-500';
            stem.volFill.style.width = `${percent}%`;
        }
    }

    function setStemVolume(stem, volume, options = {}) {
        const clamped = clampVolume(volume);
        if (clamped == null) return false;
        const changed = stem.vol !== clamped;
        stem.vol = clamped;
        if (stem.on && stem.gain) stem.gain.gain.value = clamped;
        updateStemButton(stem, options);
        if (options.persist !== false && changed) saveVolume(storageSongKey(), stem.id, clamped);
        return true;
    }

    function setStemVolumeFromPointer(stem, button, event, options = {}, bounds = null) {
        const rect = bounds || button.getBoundingClientRect();
        if (!rect.width) return false;
        const volume = (event.clientX - rect.left) / rect.width;
        return setStemVolume(stem, volume, options);
    }

    // ── Buffer transport ──

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
    function transportPlayhead() {
        const raw = transportPlayheadRaw();
        if (!S.useWorklet || !transport.playing || S.latencyOffsetSec <= 0) return raw;
        const dur = transport.duration;
        const t = raw - S.latencyOffsetSec;
        return Math.max(0, dur > 0 ? Math.min(t, dur) : t);
    }

    // Stop + release every active source node. Detaching `onended` first
    // means the natural-end handler never fires for an intentional stop.
    function stopSources() {
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
    function flushPendingPlayResolvers() {
        if (S.pendingPlayResolvers.length === 0) return;
        const resolvers = S.pendingPlayResolvers;
        S.pendingPlayResolvers = [];
        for (const resolve of resolvers) {
            try { resolve(); } catch (_) {}
        }
    }

    // True when `offset` (s) falls inside the PCM the streaming worklet currently
    // holds around its read frontier. Outside it — e.g. replaying from 0 after the
    // song ended and the pump drained the window to the tail — the worklet would
    // read silence, so the caller must refetch (repositionStream) first.
    function streamOffsetBuffered(offset) {
        if (!streaming || streamSampleRate <= 0) return true;
        const posSamp = Math.round(offset * streamSampleRate);
        const behind = Math.ceil(0.1 * streamSampleRate);
        return posSamp >= lastWorkletPos - behind && posSamp <= jsWriteFrontier;
    }

    function transportPlay() {
        resumeCtx();
        if (!S.buffersReady) { S.pendingPlay = true; return; }
        if (transport.playing) { flushPendingPlayResolvers(); return; }
        let offset = transportPlayhead();
        if (transport.duration > 0 && offset >= transport.duration - 0.001) offset = 0;
        // Streaming: if the window doesn't cover this offset (replay from 0 after
        // EOF, or the pump has drained), refetch from here before starting. The
        // worklet stalls to silence until the refill reaches `offset`, then plays.
        if (streaming && !streamOffsetBuffered(offset)) {
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
    function lightStop() {
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
        if (streaming) {
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
    // Installed once. Each member delegates to the captured core
    // implementation when no sloppak is active, so archive songs and the JUCE
    // desktop path behave exactly as before.
    let shimsInstalled = false;        // re-entry guard (prevents recapture/double-define)
    let shimsUsable = false;           // critical shims (currentTime + play + pause) all succeeded
    let coreCurrentTimeDesc = null;
    let corePausedDesc = null;
    let coreDurationDesc = null;
    let coreNativePlay = null;
    let coreNativePause = null;

    function nativeCorePaused(core) {
        try {
            if (corePausedDesc && corePausedDesc.get) return corePausedDesc.get.call(core);
            return core.paused;
        } catch (_) { return true; }
    }
    function nativeCorePause(core) {
        try {
            if (typeof coreNativePause === 'function') coreNativePause();
            else core.pause();
        } catch (_) {}
    }
    function nativeCoreTime(core) {
        try {
            if (coreCurrentTimeDesc && coreCurrentTimeDesc.get) {
                const t = Number(coreCurrentTimeDesc.get.call(core));
                return Number.isFinite(t) ? Math.max(0, t) : 0;
            }
            const t = Number(core.currentTime);
            return Number.isFinite(t) ? Math.max(0, t) : 0;
        } catch (_) { return 0; }
    }

    function installAudioShims() {
        if (shimsInstalled) return;
        const core = document.getElementById('audio');
        if (!core) return;  // #audio not in DOM yet — retry-able from onSongReady().

        // From this point we begin mutating `core`: capture descriptors and
        // attempt shims. Flip the re-entry guard NOW so a retry call doesn't
        // recapture our own shimmed descriptors (which would self-recurse on
        // delegation). `shimsUsable` separately tracks whether the critical
        // shims actually succeeded; onSongReady() gates the transport on that.
        shimsInstalled = true;

        coreCurrentTimeDesc = Object.getOwnPropertyDescriptor(core, 'currentTime')
            || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        corePausedDesc = Object.getOwnPropertyDescriptor(core, 'paused')
            || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
        coreDurationDesc = Object.getOwnPropertyDescriptor(core, 'duration')
            || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
        coreNativePlay = core.play.bind(core);
        coreNativePause = core.pause.bind(core);

        // Track success of the three CRITICAL shims (currentTime + play + pause).
        // Without all three the transport can't drive the highway, so onSongReady()
        // refuses to take over. `paused` and `duration` are useful but not gating.
        let ctOk = false, playOk = false, pauseOk = false;

        // Each shim is installed independently and defensively: Object.defineProperty
        // can throw on some runtimes, and a single failure must not abort the rest
        // of plugin init. A member that fails to shim simply keeps native behaviour.
        if (coreCurrentTimeDesc && coreCurrentTimeDesc.get) {
            try {
                Object.defineProperty(core, 'currentTime', {
                    configurable: true,
                    get() {
                        if (S.sloppakActive) return transportPlayhead();
                        return coreCurrentTimeDesc.get.call(this);
                    },
                    set(v) {
                        if (S.sloppakActive) { transportSeek(v); return; }
                        if (coreCurrentTimeDesc.set) coreCurrentTimeDesc.set.call(this, v);
                    },
                });
                ctOk = true;
            } catch (e) { console.warn('[stems] currentTime shim install failed:', e); }
        }
        if (corePausedDesc && corePausedDesc.get) {
            try {
                Object.defineProperty(core, 'paused', {
                    configurable: true,
                    get() {
                        if (S.sloppakActive) return !transport.playing;
                        return corePausedDesc.get.call(this);
                    },
                });
            } catch (e) { console.warn('[stems] paused shim install failed:', e); }
        }
        if (coreDurationDesc && coreDurationDesc.get) {
            try {
                Object.defineProperty(core, 'duration', {
                    configurable: true,
                    get() {
                        if (S.sloppakActive && transport.duration > 0) return transport.duration;
                        return coreDurationDesc.get.call(this);
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
                    return coreNativePlay();
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
                    return coreNativePause();
                },
            });
            pauseOk = true;
        } catch (e) { console.warn('[stems] pause shim install failed:', e); }
        // The slopsmith speed slider writes #audio.playbackRate; mirror it
        // onto every live buffer source.
        core.addEventListener('ratechange', () => {
            if (S.sloppakActive) setTransportRate(core.playbackRate);
        });

        shimsUsable = ctOk && playOk && pauseOk;
    }

    // ── Loading overlay ──
    function showOverlay(done, total) {
        hideOverlay();
        S.overlayEl = document.createElement('div');
        S.overlayEl.id = 'stems-loading-overlay';
        S.overlayEl.style.cssText = 'position:fixed;left:50%;bottom:84px;'
            + 'transform:translateX(-50%);z-index:9999;'
            + 'background:rgba(17,17,27,0.95);border:1px solid #2a2a3e;'
            + 'border-radius:8px;padding:9px 16px;color:#e5e7eb;'
            + 'font-size:13px;font-weight:500;pointer-events:none;'
            + 'box-shadow:0 4px 16px rgba(0,0,0,0.5);';
        setOverlayText(done, total);
        document.body.appendChild(S.overlayEl);
    }
    function updateOverlay(done, total) {
        if (S.overlayEl) setOverlayText(done, total);
    }
    function setOverlayText(done, total) {
        S.overlayEl.textContent = `Decoding stems… ${done}/${total}`;
    }
    function hideOverlay() {
        if (S.overlayEl) { S.overlayEl.remove(); S.overlayEl = null; }
    }

    function hashString(value) {
        const text = String(value || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function storageSongKey() {
        return S.currentSongKey || S.currentFilename || '';
    }

    function redactedSongRef(extra = {}) {
        const songKey = S.currentSongKey || (S.currentFilename ? `legacy-${hashString(S.currentFilename)}` : '');
        return songKey ? { songKey, ...extra } : { ...extra };
    }

    // ── Teardown ──
    function teardown() {
        cleanupPointerHandlers();
        if (S.pollHandle !== null) {
            clearInterval(S.pollHandle);
            S.pollHandle = null;
        }
        // Abort any in-flight stem load and invalidate its generation so a
        // fetch/decode that resolves later for the previous song is
        // discarded instead of building a stale graph.
        if (S.abortController) {
            try { S.abortController.abort(); } catch (_) {}
            S.abortController = null;
        }
        // Stop the streaming pump + cancel its readers (aborting the fetches
        // above already rejects in-flight reads; this also clears state).
        resetStreamState();
        S.loadGeneration++;
        S.buffersReady = false;
        S.pendingPlay = false;
        flushPendingPlayResolvers();

        // Stop the transport and release every buffer + node.
        stopSources();
        unregisterStemMixParticipants();
        for (const s of S.stemState) {
            try { s.gain && s.gain.disconnect(); } catch (_) {}
            s.buffer = null;
        }
        S.stemState = [];
        claimSnapshots.clear();
        transport.playing = false;
        transport.baseOffset = 0;
        transport.baseCtxTime = 0;
        transport.duration = 0;

        // Release the time-stretch worklet (frees the transferred PCM in the
        // audio thread). stopSources() above already posted 'stop'.
        if (S.workletNode) {
            try { S.workletNode.port.postMessage({ type: 'dispose' }); } catch (_) {}
            try { S.workletNode.port.onmessage = null; } catch (_) {}
            try { S.workletNode.disconnect(); } catch (_) {}
            S.workletNode = null;
        }
        S.workletPostReady = false;
        S.fullTrackIndex = -1;
        S.latencyOffsetSec = 0;
        // Back to "unknown" — the next song's worklet re-reports it via 'ready'.
        S.workletLatencyOutSamples = 0;

        if (S.analyserNode) {
            try { S.analyserNode.disconnect(); } catch (_) {}
            S.analyserNode = null;
        }
        if (S.masterGain) {
            try { S.masterGain.disconnect(); } catch (_) {}
            S.masterGain = null;
        }

        // Restore the Song-fader bridge to whatever owned it before this
        // plugin installed its hook — but only if the hook is STILL ours.
        if (S.songFaderBridgeInstalled) {
            if (window.slopsmith && window.slopsmith.stems
                    && window.slopsmith.stems.setMasterVolume === songFaderHook) {
                // Restore ANY prior value (not just a function) so a non-function
                // sentinel another plugin set (e.g. null) is preserved rather
                // than deleted; only delete when there was genuinely no prior.
                if (S.priorSetMasterVolume !== undefined) {
                    window.slopsmith.stems.setMasterVolume = S.priorSetMasterVolume;
                } else {
                    delete window.slopsmith.stems.setMasterVolume;
                }
            }
            S.songFaderBridgeInstalled = false;
            S.priorSetMasterVolume = undefined;
        }

        hideOverlay();
        pointerCleanupHandlers.clear();
        registerStemOwnerStatus('unavailable');
        if (S.container) {
            S.container.remove();
            S.container = null;
        }

        // Hand transport control back to the core <audio> element. After
        // this point the #audio shims delegate to core's native/JUCE
        // behaviour, so archive and JUCE playback are untouched.
        S.sloppakActive = false;
        // Leave S.audioCtx alive — it is reused across songs to avoid browser
        // "too many AudioContexts" warnings.
    }

    // ── UI ──
    function injectUI() {
        cleanupPointerHandlers();
        pointerCleanupHandlers.clear();
        const c = document.getElementById('player-controls');
        if (!c) return;
        // Remove any previous bar
        const prev = document.getElementById('stems-mixer');
        if (prev) prev.remove();

        S.container = document.createElement('div');
        S.container.id = 'stems-mixer';
        S.container.className = 'flex items-center gap-1.5';
        // flex-wrap so the stem buttons wrap onto a new line instead of
        // overflowing when the host re-homes this bar into the narrow v3
        // "Plugin controls" rail popover (.v3-rail-pop, max-width 340px).
        // Inert in v2's wide #player-controls bar (nothing to wrap there);
        // inline (not a Tailwind class) since this plugin ships no compiled
        // stylesheet and can't rely on flex-wrap being in core's scanned CSS.
        S.container.style.cssText = 'flex-wrap:wrap;padding:0 6px;border-left:1px solid #2a2a3e;margin-left:4px;';

        const label = document.createElement('span');
        label.textContent = 'Stems';
        label.style.cssText = 'font-size:10px;color:#6b7280;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin-right:4px;';
        S.container.appendChild(label);

        for (const s of S.stemState) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;display:inline-block;';

            const btn = document.createElement('button');
            btn.style.cssText = 'position:relative;overflow:hidden;min-width:46px;touch-action:none;';
            const fill = document.createElement('span');
            fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0%;pointer-events:none;transition:width 80ms linear,background-color 120ms ease,border-color 120ms ease;';
            const text = document.createElement('span');
            text.textContent = s.id;
            text.style.cssText = 'position:relative;z-index:1;pointer-events:none;';
            btn.appendChild(fill);
            btn.appendChild(text);
            s.btn = btn;
            s.volFill = fill;

            let volumeGestureActive = false;
            let volumePointerId = null;
            let pointerTracking = false;
            let hasPointerCapture = false;
            let pointerStartX = 0;
            let pointerStartY = 0;
            let pointerBounds = null;
            let pointerFilename = null;
            let pointerStartVolume = null;
            let suppressNextClick = false;
            const clearPointerState = () => {
                pointerTracking = false;
                volumeGestureActive = false;
                volumePointerId = null;
                hasPointerCapture = false;
                pointerBounds = null;
                pointerFilename = null;
                pointerStartVolume = null;
                window.removeEventListener('pointerup', finishVolumeGesture);
                window.removeEventListener('pointercancel', finishVolumeGesture);
                window.removeEventListener('pointermove', handleVolumePointerMove);
            };
            pointerCleanupHandlers.add(clearPointerState);
            const isEventFromWindowListener = (event) => event.currentTarget === window;
            const shouldIgnoreNonCapturedButtonEvent = (event, { allowLostPointerCapture = false } = {}) => (
                !hasPointerCapture
                && !isEventFromWindowListener(event)
                && (!allowLostPointerCapture || event.type !== 'lostpointercapture')
            );
            const handleVolumePointerMove = (event) => {
                if (!pointerTracking || event.pointerId !== volumePointerId) return;
                if (shouldIgnoreNonCapturedButtonEvent(event)) return;
                if (!hasPointerCapture && (event.buttons & PRIMARY_BUTTON_MASK) === 0) {
                    clearPointerState();
                    return;
                }
                const deltaX = event.clientX - pointerStartX;
                const deltaY = event.clientY - pointerStartY;
                if (!volumeGestureActive) {
                    if (Math.abs(deltaX) < DRAG_THRESHOLD_PX || Math.abs(deltaX) < Math.abs(deltaY)) return;
                    volumeGestureActive = true;
                    suppressNextClick = true;
                }
                event.preventDefault();
                setStemVolumeFromPointer(s, btn, event, { persist: false, updateA11y: false }, pointerBounds);
            };
            btn.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                pointerTracking = true;
                volumeGestureActive = false;
                volumePointerId = event.pointerId;
                pointerStartX = event.clientX;
                pointerStartY = event.clientY;
                const rect = btn.getBoundingClientRect();
                pointerBounds = { left: rect.left, width: rect.width };
                pointerFilename = S.currentFilename;
                pointerStartVolume = s.vol;
                suppressNextClick = false;
                try {
                    btn.setPointerCapture(event.pointerId);
                    hasPointerCapture = true;
                } catch (_) {
                    hasPointerCapture = false;
                    window.addEventListener('pointerup', finishVolumeGesture);
                    window.addEventListener('pointercancel', finishVolumeGesture);
                    window.addEventListener('pointermove', handleVolumePointerMove);
                }
            });
            btn.addEventListener('pointermove', handleVolumePointerMove);
            const finishVolumeGesture = (event) => {
                if (!pointerTracking || event.pointerId !== volumePointerId) return;
                if (shouldIgnoreNonCapturedButtonEvent(event, { allowLostPointerCapture: true })) return;
                if (volumeGestureActive) {
                    if (event.type === 'pointerup') {
                        event.preventDefault();
                        setStemVolumeFromPointer(s, btn, event, { persist: false }, pointerBounds);
                        saveVolume(pointerFilename, s.id, s.vol);
                        setTimeout(() => { suppressNextClick = false; }, 0);
                    } else {
                        setStemVolume(s, pointerStartVolume, { persist: false });
                        suppressNextClick = false;
                    }
                }
                clearPointerState();
                try { btn.releasePointerCapture(event.pointerId); } catch (_) {}
            };
            btn.addEventListener('pointerup', finishVolumeGesture);
            btn.addEventListener('pointercancel', finishVolumeGesture);
            btn.addEventListener('lostpointercapture', finishVolumeGesture);
            btn.addEventListener('keydown', (event) => {
                let direction = 0;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') direction = -1;
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') direction = 1;
                if (!direction) return;
                event.preventDefault();
                const step = event.shiftKey ? KEYBOARD_VOLUME_STEP_LARGE : KEYBOARD_VOLUME_STEP;
                setStemVolume(s, s.vol + (direction * step));
            });

            btn.onclick = (event) => {
                if (suppressNextClick) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                s.on = !s.on;
                if (s.gain) s.gain.gain.value = s.on ? s.vol : 0;
                updateStemButton(s);
                saveMuted(storageSongKey(), S.stemState);
                registerStemOwnerStatus('available');
                recordStemUserOverride(s, 'User toggled Stems mute');
            };
            setStemVolume(s, s.vol, { persist: false });
            wrap.appendChild(btn);
            // Sentinel keeps btn from being button:last-child of wrap.
            // Several other plugins (tones, drums, fretboard, midi, ...)
            // locate the close button via controls.querySelector('button:last-child')
            // and then insertBefore(newBtn, closeBtn). Without this sentinel
            // a nested stem button matches first and the insertBefore call
            // throws NotFoundError because the resolved node isn't a direct
            // child of controls.
            const sentinel = document.createElement('span');
            sentinel.style.display = 'none';
            wrap.appendChild(sentinel);
            S.container.appendChild(wrap);
        }

        // Insert before the separator span, same pattern invert uses
        const separator = c.querySelector('span.text-gray-700');
        if (separator && separator.parentNode === c) c.insertBefore(S.container, separator);
        else c.appendChild(S.container);
    }

    // ── Decode pipeline ──

    // Decode one stem ArrayBuffer to an AudioBuffer. The promise-based
    // decodeAudioData is supported by Electron/Chromium and every modern
    // browser slopsmith targets.
    function decodeAudioData(arrayBuffer) {
        return S.audioCtx.decodeAudioData(arrayBuffer);
    }

    // Fetch + decode every stem concurrently. Returns one entry per stem
    // ({ id, url, default, buffer }; buffer is null on failure), or null if
    // the load was superseded by a newer song (generation mismatch).
    async function loadStems(stems, gen, signal) {
        let completed = 0;
        showOverlay(completed, stems.length);

        const out = await Promise.all(stems.map(async (s) => {
            try {
                const resp = await fetch(s.url, { signal });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const arrayBuf = await resp.arrayBuffer();
                if (gen !== S.loadGeneration) return null;
                const buffer = await decodeAudioData(arrayBuf);
                if (gen !== S.loadGeneration) return null;
                return { id: s.id, url: s.url, default: !!s.default, buffer };
            } catch (err) {
                if (gen !== S.loadGeneration) return null;
                console.error('[stems] failed to load stem "' + s.id + '":', err);
                return { id: s.id, url: s.url, default: !!s.default, buffer: null };
            } finally {
                // Count every finished attempt — success OR failure — so the
                // overlay progress can't stall at e.g. 5/6 on a failed stem.
                if (gen === S.loadGeneration) {
                    completed += 1;
                    updateOverlay(completed, stems.length);
                }
            }
        }));

        if (gen !== S.loadGeneration) return null;
        return out;
    }

    // Fetch + decode the pristine full-mix mixdown. Returns the AudioBuffer, or
    // null if it's superseded / missing / fails to decode — in which case the
    // caller just plays the separated stems (no full-mix optimisation).
    async function loadFullMix(url, gen, signal) {
        try {
            const resp = await fetch(url, { signal });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const arrayBuf = await resp.arrayBuffer();
            if (gen !== S.loadGeneration) return null;
            const buffer = await decodeAudioData(arrayBuf);
            return gen === S.loadGeneration ? buffer : null;
        } catch (err) {
            if (gen !== S.loadGeneration) return null;
            console.warn('[stems] full-mix load failed; using separated stems only:', err);
            return null;
        }
    }

    // Build the Web Audio graph from decoded buffers. Returns true on
    // success, false if nothing decoded (caller should bail). `fullBuffer` is
    // the optional pristine full-mix track (worklet path only).
    function buildGraphFromBuffers(results, fullBuffer) {
        const ok = results.filter(r => r && r.buffer);
        if (ok.length === 0) {
            console.error('[stems] no stems decoded — reverting to core audio');
            teardown();
            return false;
        }

        const karaoke = karaokeDefault();
        const defaultMuted = loadDefaultMuted();
        const key = storageSongKey();
        const savedMuted = loadMuted(key) || (S.currentSongKey ? loadMuted(S.currentFilename) : null);
        const savedVols = (() => {
            const primary = loadVolumes(key);
            if (Object.keys(primary).length || !S.currentSongKey) return primary;
            return loadVolumes(S.currentFilename);
        })();

        // S.masterGain sums every stem and is driven by the Song fader.
        S.masterGain = S.audioCtx.createGain();
        S.masterGain.gain.value = persistedSongGain();
        S.masterGain.connect(S.audioCtx.destination);
        // The analyser is a side-chain TAP: S.masterGain fans out to it, but it
        // has no onward connection, so an external plugin calling
        // getAnalyser().disconnect() cannot sever the audible path.
        S.analyserNode = S.audioCtx.createAnalyser();
        S.analyserNode.fftSize = 256;
        S.masterGain.connect(S.analyserNode);

        // In worklet mode the single 'stem-mixer' node replaces every per-stem
        // AudioBufferSourceNode + GainNode and feeds S.masterGain directly. It has
        // zero inputs (it is the source) and stereo output.
        if (S.useWorklet) {
            try {
                S.workletNode = new AudioWorkletNode(S.audioCtx, 'stem-mixer', {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                });
                S.workletNode.port.onmessage = onWorkletMessage;
                S.workletNode.connect(S.masterGain);
            } catch (e) {
                // Construction can throw if the module isn't really registered;
                // drop to legacy mode for this song rather than play nothing.
                console.warn('[stems] stem-mixer node failed; using legacy mode:', e);
                S.useWorklet = false;
                S.workletNode = null;
            }
        }
        // Suppress per-stem gain posts until the 'load' message (with the full
        // initial gain snapshot) has been sent.
        S.workletPostReady = false;

        let maxDur = 0;
        S.stemState = ok.map((r, i) => {
            // Worklet mode: a gain HANDLE that forwards to the worklet; legacy
            // mode: a real per-stem GainNode wired into S.masterGain.
            let gain;
            if (S.useWorklet) {
                gain = makeStemGainHandle(i);
            } else {
                gain = S.audioCtx.createGain();
                gain.connect(S.masterGain);
            }

            // Saved per-song state wins; then default-muted preset; then
            // karaoke override; then manifest default.
            let on;
            if (savedMuted) {
                on = !savedMuted.has(r.id);
            } else {
                on = !!r.default;
                if (defaultMuted.has(r.id)) on = false;
                if (karaoke && /vocal/i.test(r.id)) on = false;
            }

            const vol = clampVolume(savedVols[r.id]);
            const initialVol = vol == null ? 1 : vol;
            gain.gain.value = on ? initialVol : 0;

            if (r.buffer.duration > maxDur) maxDur = r.buffer.duration;
            return {
                id: r.id, url: r.url, default: r.default, buffer: r.buffer,
                source: null, gain, on, vol: initialVol,
            };
        });

        transport.duration = maxDur;
        // Preserve any playhead set before/while decoding (core-playback
        // takeover seed, or a seek during the decode window); just clamp it
        // to the freshly known song duration. Don't reset it to 0.
        transport.baseOffset = Math.max(0, Math.min(transport.baseOffset, maxDur));
        transport.baseCtxTime = 0;
        transport.playing = false;
        const core = document.getElementById('audio');
        const coreRate = core ? Number(core.playbackRate) : 1;
        transport.rate = (Number.isFinite(coreRate) && coreRate > 0) ? coreRate : 1;

        if (S.useWorklet && S.workletNode) {
            // Hand the decoded PCM to the worklet. Copy each channel (slice)
            // then transfer the copy's buffer so the audio thread owns it with
            // no lingering main-thread duplicate. decodeAudioData already
            // resampled every stem to S.audioCtx.sampleRate, so channels line up.
            const stemsMsg = [];
            const transfer = [];
            for (const s of S.stemState) {
                const buf = s.buffer;
                const channels = [];
                for (let ch = 0; ch < buf.numberOfChannels; ch++) {
                    const copy = buf.getChannelData(ch).slice();
                    channels.push(copy);
                    transfer.push(copy.buffer);
                }
                stemsMsg.push({ channels, length: buf.length });
            }
            // Append the pristine full mix as one extra track (index after the
            // real stems), so unity playback uses it instead of the lossy
            // recombination — but ONLY when its length matches the stems within
            // tolerance. original_audio is a SEPARATE encode (codec priming can
            // shift it slightly); the transport/highway timeline tracks the
            // stems, and the worklet ends at its longest track, so a longer mix
            // would play past the song end and a shorter/wrong one would drop to
            // silence mid-song at unity. A gross mismatch means the wrong or a
            // desynced file → ignore it and play the separated stems. We also
            // clamp the posted length to the stems so the mix can never extend
            // the song past where the stems (and the highway) end. The worklet
            // mixes any channel layout (a mono track feeds both outputs), so no
            // channel-count check is needed.
            S.fullTrackIndex = -1;
            const stemMaxLen = stemsMsg.reduce((m, s) => Math.max(m, s.length), 0);
            if (fullBuffer) {
                const tol = Math.max(2048, Math.round(0.05 * (S.audioCtx ? S.audioCtx.sampleRate : 48000)));
                if (Math.abs(fullBuffer.length - stemMaxLen) > tol) {
                    console.warn('[stems] original_audio length off by '
                        + (fullBuffer.length - stemMaxLen) + ' samples (> ' + tol
                        + '); ignoring it, using separated stems only.');
                } else {
                    const channels = [];
                    for (let ch = 0; ch < fullBuffer.numberOfChannels; ch++) {
                        const copy = fullBuffer.getChannelData(ch).slice();
                        channels.push(copy);
                        transfer.push(copy.buffer);
                    }
                    // Clamp to the stem length so this track can't push the
                    // worklet's `total` past the transport/highway end.
                    stemsMsg.push({ channels, length: Math.min(fullBuffer.length, stemMaxLen) });
                    S.fullTrackIndex = S.stemState.length;   // tracks come after the stems
                }
            }
            // Initial gains honour unity routing: at unity the full mix plays
            // alone (stems silent); otherwise stems mix and the full track is 0.
            const { stemGains, fullGain } = computeMixGains(S.stemState, S.fullTrackIndex >= 0);
            const gains = stemGains.slice();
            if (S.fullTrackIndex >= 0) gains.push(fullGain);
            try {
                S.workletNode.port.postMessage({ type: 'load', stems: stemsMsg, gains }, transfer);
            } catch (e) {
                console.warn('[stems] worklet load failed; using legacy mode:', e);
                // Too late to rebuild GainNodes cleanly here; safest is to bail
                // so onSongReady() leaves core <audio> in charge.
                teardown();
                return false;
            }
            S.workletPostReady = true;
            updateLatencyOffset();
            // PCM now lives in the worklet; release the main-thread AudioBuffers.
            for (const s of S.stemState) s.buffer = null;
        }
        registerStemMixParticipants();
        registerStemOwnerStatus('available');
        return true;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Streaming (bounded-memory) playback — the iOS WAV path
    //
    //  The iOS client proxy transcodes each OGG stem to RIFF/WAV (16-bit PCM)
    //  and streams it. Decoding whole stems to AudioBuffers (buildGraphFromBuffers
    //  above) jettisons the WKWebView content process at ~6 stems (~500 MB). Here
    //  we read the PCM incrementally off fetch().body and feed the worklet's
    //  bounded ring via 'append', dropping consumed PCM, so peak memory is a
    //  few-second window per track — independent of song length or stem count.
    //  Raw PCM is sliceable at any sample, so NO decoder/WebCodecs/demuxer is
    //  needed. Desktop (audio/ogg, not sliceable) keeps the full-decode path.
    // ══════════════════════════════════════════════════════════════════════
    const STREAM_AHEAD_SEC = 2.0;      // keep ~this far buffered ahead of pos
    const STREAM_PREFILL_SEC = 0.5;    // buffer this much before starting
    const STREAM_CAP_SEC = 3.5;        // worklet per-track window capacity
    const STREAM_CHUNK_FRAMES = 8192;  // max frames appended per pump round
    const EMPTY_BYTES = new Uint8Array(0);

    let streaming = false;             // this song is using the streaming path
    let streamTracks = [];             // [{ url, nch, byteAlign, totalFrames, reader, leftover, done, skipBytes }]
    let streamSampleRate = 0;
    let streamTotalSamples = 0;        // transport length in samples (max stem)
    let jsWriteFrontier = 0;           // next absolute sample the pump will append
    let pumpStop = false;
    let lastWorkletPos = 0;            // worklet read frontier (samples), via 'pos'
    let posWaiter = null;              // resolve fn for a pump await on next 'pos'
    let streamSeekToken = 0;           // invalidates a superseded seek refetch

    function streamingSupported() {
        return typeof ReadableStream !== 'undefined'
            && typeof fetch === 'function'
            && typeof AudioWorkletNode !== 'undefined';
    }
    function isWavResponse(resp) {
        try {
            const ct = ((resp && resp.headers && resp.headers.get('content-type')) || '').toLowerCase();
            return ct.indexOf('wav') !== -1;
        } catch (_) { return false; }
    }

    // --- parseWavHeader (pure; node-testable, see tests/wav-pcm.test.mjs) ---
    // Parse a RIFF/WAV header from the leading bytes; returns
    // { nch, sampleRate, bitsPerSample, dataOffset, dataSize } or null. Only
    // 16-bit PCM is accepted (what the proxy emits). Chunk-walks fmt/data so a
    // non-canonical header (extra chunks before `data`) still parses.
    // parseWavHeader + pcm16ToFloat32 → src/wav-pcm.js (imported above).

    // Pull one chunk from a track's reader into its leftover byte buffer.
    async function trackRead(t) {
        if (t.done) return false;
        const { done, value } = await t.reader.read();
        if (done) { t.done = true; return false; }
        if (value && value.length) {
            if (t.leftover.length === 0) {
                t.leftover = value;
            } else {
                const merged = new Uint8Array(t.leftover.length + value.length);
                merged.set(t.leftover, 0);
                merged.set(value, t.leftover.length);
                t.leftover = merged;
            }
        }
        return true;
    }
    async function ensureBytes(t, n) {
        while (t.leftover.length < n && !t.done) await trackRead(t);
        return t.leftover.length >= n;
    }
    async function dropBytes(t, n) {
        while (n > 0) {
            if (t.leftover.length === 0) { if (!(await trackRead(t))) break; }
            if (t.leftover.length === 0) break;
            const take = Math.min(n, t.leftover.length);
            t.leftover = t.leftover.subarray(take);
            n -= take;
        }
    }

    // Read the WAV header off a freshly opened track reader, parse it, and trim
    // `leftover` to the start of the PCM body. Returns the header or null.
    async function readWavHeader(t) {
        let header = parseWavHeader(t.leftover);
        while (!header && !t.done && t.leftover.length < (1 << 16)) {
            await trackRead(t);
            header = parseWavHeader(t.leftover);
        }
        if (!header) return null;
        t.leftover = t.leftover.subarray(header.dataOffset);
        return header;
    }

    // Dequeue `frames` per-channel samples of real PCM from a track (reading
    // from its reader as needed), returning one Float32Array(frames) per channel.
    async function dequeueTrackFrames(t, frames) {
        if (t.skipBytes > 0) { await dropBytes(t, t.skipBytes); t.skipBytes = 0; }
        const wantBytes = frames * t.byteAlign;
        await ensureBytes(t, wantBytes);
        const availBytes = Math.min(wantBytes, t.leftover.length);
        const availFrames = Math.floor(availBytes / t.byteAlign);
        const chunk = t.leftover.subarray(0, availFrames * t.byteAlign);
        t.leftover = t.leftover.subarray(availFrames * t.byteAlign);
        return pcm16ToFloat32(chunk, 0, frames, t.nch); // pads past availFrames with 0
    }

    // Append one aligned block for every track at the current write frontier,
    // reading PCM as needed and zero-padding tracks past their own end.
    async function appendRound() {
        const remaining = streamTotalSamples - jsWriteFrontier;
        if (remaining <= 0) return false;
        const aheadTarget = Math.min(streamTotalSamples,
            lastWorkletPos + Math.ceil(STREAM_AHEAD_SEC * streamSampleRate));
        const frames = Math.min(STREAM_CHUNK_FRAMES, remaining, Math.max(0, aheadTarget - jsWriteFrontier));
        if (frames <= 0) return false;

        const blocks = [];
        const transfer = [];
        for (const t of streamTracks) {
            const realWanted = Math.max(0, Math.min(frames, t.totalFrames - jsWriteFrontier));
            let chans;
            if (realWanted <= 0) {
                chans = [];
                for (let ch = 0; ch < t.nch; ch++) chans.push(new Float32Array(frames));
            } else {
                // dequeueTrackFrames pads to `realWanted`; pad the rest to `frames`.
                chans = await dequeueTrackFrames(t, realWanted);
                if (realWanted < frames) {
                    for (let ch = 0; ch < t.nch; ch++) {
                        const full = new Float32Array(frames);
                        full.set(chans[ch], 0);
                        chans[ch] = full;
                    }
                }
            }
            for (const c of chans) transfer.push(c.buffer);
            blocks.push({ channels: chans });
        }
        if (pumpStop || !S.workletNode) return false;
        try {
            S.workletNode.port.postMessage({ type: 'append', base: jsWriteFrontier, frames, tracks: blocks }, transfer);
        } catch (_) { return false; }
        jsWriteFrontier += frames;
        return true;
    }

    // Await the worklet's next backpressure ('pos') message, or a short timeout.
    function waitPos() {
        return new Promise((resolve) => {
            posWaiter = resolve;
            setTimeout(() => { if (posWaiter === resolve) { posWaiter = null; resolve(); } }, 100);
        });
    }

    // The pump: keep the worklet window ~STREAM_AHEAD_SEC ahead of its read
    // frontier. On the initial run, prefill then start (honouring pending play).
    async function runPump(isInitial) {
        try {
            const prefillTo = Math.min(streamTotalSamples,
                jsWriteFrontier + Math.ceil(STREAM_PREFILL_SEC * streamSampleRate));
            while (!pumpStop && jsWriteFrontier < prefillTo) {
                if (!(await appendRound())) break;
            }
            if (pumpStop) return;
            if (isInitial) {
                S.buffersReady = true;
                if (S.pendingPlay) { S.pendingPlay = false; transportPlay(); }
            }
            while (!pumpStop && jsWriteFrontier < streamTotalSamples) {
                const target = Math.min(streamTotalSamples,
                    lastWorkletPos + Math.ceil(STREAM_AHEAD_SEC * streamSampleRate));
                if (jsWriteFrontier >= target) { await waitPos(); continue; }
                if (!(await appendRound())) break;
            }
        } catch (e) {
            if (!pumpStop && (!e || e.name !== 'AbortError')) console.warn('[stems] stream pump error:', e);
        }
    }

    function cancelStreamReaders() {
        for (const t of streamTracks) {
            try { t.reader && t.reader.cancel(); } catch (_) {}
            t.reader = null;
            t.leftover = EMPTY_BYTES;
            t.done = true;
        }
    }

    // (Re)open every track's byte stream starting at `fromSample`. Uses a Range
    // request: a 206-capable proxy serves pure PCM from there (efficient seek);
    // a proxy that ignores Range returns 200 from 0, so we skip the header +
    // preceding samples ourselves.
    async function openTrackStreams(fromSample, gen, token) {
        await Promise.all(streamTracks.map(async (t) => {
            // Byte offset of sample `fromSample` in this track's WAV (header +
            // linear PCM). dataOffset is the parsed header size (44 for the
            // proxy's canonical WAV, but honour a non-canonical one too).
            const byteOffset = t.dataOffset + fromSample * t.byteAlign;
            const headers = { Range: 'bytes=' + byteOffset + '-' };
            const resp = await fetch(t.url, { signal: S.abortController.signal, headers });
            if (gen !== S.loadGeneration || token !== streamSeekToken) {
                try { resp.body && resp.body.cancel(); } catch (_) {}
                return;
            }
            t.reader = resp.body.getReader();
            t.leftover = EMPTY_BYTES;
            t.done = false;
            // 206 → body already starts at fromSample (no header). 200 → whole
            // file from 0; skip the header + the preceding PCM ourselves.
            t.skipBytes = (resp.status === 206) ? 0 : byteOffset;
        }));
    }

    // Streaming seek: flush the worklet window, refetch every track from the
    // target, and resume the pump. Sample-accurate; O(1) network with a
    // 206-capable proxy, O(offset) discard otherwise.
    async function repositionStream(targetSec) {
        const token = ++streamSeekToken;
        const gen = S.loadGeneration;
        pumpStop = true;
        cancelStreamReaders();
        const Tsamp = Math.max(0, Math.round(targetSec * streamSampleRate));
        if (S.workletNode) {
            try { S.workletNode.port.postMessage({ type: 'seek', offset: Tsamp / streamSampleRate }); } catch (_) {}
        }
        jsWriteFrontier = Tsamp;
        lastWorkletPos = Tsamp;
        try {
            await openTrackStreams(Tsamp, gen, token);
        } catch (e) {
            if (token === streamSeekToken && (!e || e.name !== 'AbortError')) {
                console.warn('[stems] seek refetch failed:', e);
            }
            return;
        }
        if (token !== streamSeekToken || gen !== S.loadGeneration) return;
        pumpStop = false;
        runPump(false);
    }

    // Recreate the AudioContext at `rate` when it differs, so streamed PCM feeds
    // the worklet at its native rate (the OS resamples to the device) — no in-JS
    // resample, and the worklet stays sample-exact. Re-registers the worklet
    // module on the new context. Returns true if the context is usable at `rate`.
    async function ensureCtxAtRate(rate) {
        ensureCtx();
        if (S.audioCtx && Math.abs(S.audioCtx.sampleRate - rate) < 1) return true;
        try { if (S.audioCtx) { const old = S.audioCtx; S.audioCtx = null; try { old.close(); } catch (_) {} } } catch (_) {}
        S.workletReady = false;
        S.workletModulePromise = null;
        const AC = window.AudioContext || window.webkitAudioContext;
        try { S.audioCtx = new AC({ sampleRate: rate }); }
        catch (_) { try { S.audioCtx = new AC(); } catch (__) { return false; } }
        const ok = await ensureWorklet();
        // If the engine ignored the sampleRate option, we can't feed native-rate
        // PCM without resampling — refuse streaming and let the caller bail.
        return ok && !!S.audioCtx && Math.abs(S.audioCtx.sampleRate - rate) < 1;
    }

    // Build the streaming graph + pump from the fetched WAV streams. `probeResp`
    // is stem[0]'s already-open response. Returns true once set up (the pump
    // runs asynchronously), false on failure. On failure it does NOT teardown()
    // (that would bump S.loadGeneration and hide the failure from onSongReady's
    // supersession check) — the caller tears down + falls back. A `false` return
    // with `gen === S.loadGeneration` is a real failure; a stale gen is supersession.
    async function setupStreaming(stems, probeResp, fullUrl, gen) {
        // 1. Open readers + parse headers for every stem (and the full mix).
        let restResps = [];
        try {
            restResps = await Promise.all(stems.slice(1).map((s) =>
                fetch(s.url, { signal: S.abortController.signal, headers: { Range: 'bytes=0-' } })));
        } catch (e) {
            if (gen !== S.loadGeneration) return false;
            console.warn('[stems] stem fetch failed; cannot stream:', e);
            return false; // caller (onSongReady) tears down + falls back
        }
        if (gen !== S.loadGeneration) return false;

        let fullResp = null;
        if (fullUrl) {
            try {
                const fr = await fetch(fullUrl, { signal: S.abortController.signal, headers: { Range: 'bytes=0-' } });
                if (gen !== S.loadGeneration) { try { fr.body && fr.body.cancel(); } catch (_) {} return false; }
                if (isWavResponse(fr)) fullResp = fr; else { try { fr.body && fr.body.cancel(); } catch (_) {} }
            } catch (_) { /* no full mix → separated stems only */ }
        }

        const responses = [probeResp].concat(restResps);
        const built = [];
        for (let i = 0; i < stems.length; i++) {
            const resp = responses[i];
            if (!resp || !resp.body) return false;
            const t = {
                id: stems[i].id, url: stems[i].url, default: !!stems[i].default,
                reader: resp.body.getReader(), leftover: EMPTY_BYTES, done: false, skipBytes: 0,
                nch: 2, byteAlign: 4, totalFrames: 0, dataOffset: 44,
            };
            const hdr = await readWavHeader(t);
            if (gen !== S.loadGeneration) { try { t.reader.cancel(); } catch (_) {} return false; }
            if (!hdr) { console.warn('[stems] stem WAV header parse failed; cannot stream'); return false; }
            t.nch = hdr.nch; t.byteAlign = hdr.nch * 2; t.dataOffset = hdr.dataOffset;
            t.totalFrames = Math.floor(hdr.dataSize / t.byteAlign);
            // All stems must share one sample rate — the context is pinned to it
            // and the worklet indexes every track by the same sample clock. A
            // mixed-rate pack would play some stems at the wrong speed, so refuse
            // to stream (the caller falls back). Demucs output is homogeneous;
            // this is a defensive guard.
            if (!streamSampleRate) {
                streamSampleRate = hdr.sampleRate;
            } else if (hdr.sampleRate !== streamSampleRate) {
                console.warn('[stems] stem "' + t.id + '" rate ' + hdr.sampleRate
                    + ' != ' + streamSampleRate + '; cannot stream a mixed-rate pack');
                return false;
            }
            built.push(t);
        }

        let fullTrack = null;
        if (fullResp && fullResp.body) {
            const t = {
                id: '__full', url: fullUrl,
                reader: fullResp.body.getReader(), leftover: EMPTY_BYTES, done: false, skipBytes: 0,
                nch: 2, byteAlign: 4, totalFrames: 0, dataOffset: 44,
            };
            const hdr = await readWavHeader(t);
            if (gen !== S.loadGeneration) { try { t.reader.cancel(); } catch (_) {} return false; }
            // The full mix rides the same sample clock as the stems; the pristine
            // mixdown can be encoded at the source rate (≠ the demucs stem rate),
            // in which case it'd play at the wrong speed. Only keep it when its
            // rate matches; otherwise drop it and play the separated stems.
            if (hdr && hdr.sampleRate === streamSampleRate) {
                t.nch = hdr.nch; t.byteAlign = hdr.nch * 2; t.dataOffset = hdr.dataOffset;
                t.totalFrames = Math.floor(hdr.dataSize / t.byteAlign);
                fullTrack = t;
            } else {
                if (hdr) console.warn('[stems] original_audio rate '
                    + hdr.sampleRate + ' != ' + streamSampleRate + '; using separated stems only');
                try { t.reader.cancel(); } catch (_) {}
            }
        }

        const maxStemFrames = built.reduce((m, t) => Math.max(m, t.totalFrames), 0);
        if (maxStemFrames <= 0) return false;
        streamTotalSamples = maxStemFrames;

        // 2. Pin the AudioContext to the source rate + (re)load the worklet.
        const okCtx = await ensureCtxAtRate(streamSampleRate);
        if (gen !== S.loadGeneration) return false;
        if (!okCtx || !S.audioCtx) {
            console.warn('[stems] could not run the AudioContext at the stem sample rate; not streaming');
            return false;
        }
        S.useWorklet = true;

        // 3. Full-mix tolerance (same rule as buildGraphFromBuffers): only keep
        //    it when its length matches the stems, clamped so it can't extend the
        //    song past where the stems / highway end.
        S.fullTrackIndex = -1;
        streamTracks = built.slice();
        if (fullTrack) {
            const tol = Math.max(2048, Math.round(0.05 * streamSampleRate));
            if (Math.abs(fullTrack.totalFrames - maxStemFrames) > tol) {
                console.warn('[stems] original_audio length off by '
                    + (fullTrack.totalFrames - maxStemFrames) + ' frames; using separated stems only.');
                try { fullTrack.reader.cancel(); } catch (_) {}
            } else {
                fullTrack.totalFrames = Math.min(fullTrack.totalFrames, maxStemFrames);
                streamTracks.push(fullTrack);
                S.fullTrackIndex = built.length;
            }
        }

        // 4. Mix graph + stem UI state (mirrors buildGraphFromBuffers, no buffers).
        S.masterGain = S.audioCtx.createGain();
        S.masterGain.gain.value = persistedSongGain();
        S.masterGain.connect(S.audioCtx.destination);
        S.analyserNode = S.audioCtx.createAnalyser();
        S.analyserNode.fftSize = 256;
        S.masterGain.connect(S.analyserNode);
        S.workletPostReady = false;
        try {
            S.workletNode = new AudioWorkletNode(S.audioCtx, 'stem-mixer', {
                numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
            });
            S.workletNode.port.onmessage = onWorkletMessage;
            S.workletNode.connect(S.masterGain);
        } catch (e) {
            console.warn('[stems] stem-mixer node failed; not streaming:', e);
            return false;
        }

        const karaoke = karaokeDefault();
        const defaultMuted = loadDefaultMuted();
        const savedMuted = loadMuted(S.currentFilename);
        const savedVols = loadVolumes(S.currentFilename);
        S.stemState = built.map((t, i) => {
            const gain = makeStemGainHandle(i);
            let on;
            if (savedMuted) {
                on = !savedMuted.has(t.id);
            } else {
                on = !!t.default;
                if (defaultMuted.has(t.id)) on = false;
                if (karaoke && /vocal/i.test(t.id)) on = false;
            }
            const vol = clampVolume(savedVols[t.id]);
            const initialVol = vol == null ? 1 : vol;
            gain.gain.value = on ? initialVol : 0;
            return { id: t.id, url: t.url, default: t.default, buffer: null, source: null, gain, on, vol: initialVol };
        });

        // 5. Transport + initial gains, then open the worklet window.
        // Preserve any playhead seeded before/while setting up — the core-playback
        // takeover (core was already playing stem[0]) or a seek during setup left
        // it on transport.baseOffset. Start the window there instead of 0; the
        // tracks' readers begin at PCM sample 0, so skip forward to the offset.
        transport.duration = streamTotalSamples / streamSampleRate;
        const initialOffsetSamples = Math.max(0, Math.min(
            Math.round((transport.baseOffset || 0) * streamSampleRate), streamTotalSamples));
        transport.baseOffset = initialOffsetSamples / streamSampleRate;
        transport.baseCtxTime = 0;
        transport.playing = false;
        const core = document.getElementById('audio');
        const coreRate = core ? Number(core.playbackRate) : 1;
        transport.rate = (Number.isFinite(coreRate) && coreRate > 0) ? coreRate : 1;
        jsWriteFrontier = initialOffsetSamples;
        lastWorkletPos = initialOffsetSamples;
        if (initialOffsetSamples > 0) {
            for (const t of streamTracks) t.skipBytes = initialOffsetSamples * t.byteAlign;
        }

        const { stemGains, fullGain } = computeMixGains(S.stemState, S.fullTrackIndex >= 0);
        const gains = stemGains.slice();
        if (S.fullTrackIndex >= 0) gains.push(fullGain);
        const openTracks = streamTracks.map((t) => ({ nch: t.nch, length: t.totalFrames }));
        try {
            S.workletNode.port.postMessage({
                type: 'open', tracks: openTracks, gains,
                sampleRate: streamSampleRate, cap: Math.ceil(STREAM_CAP_SEC * streamSampleRate),
                startSample: initialOffsetSamples,
            });
        } catch (e) {
            console.warn('[stems] worklet open failed; not streaming:', e);
            return false;
        }
        S.workletPostReady = true;
        updateLatencyOffset();

        pumpStop = false; // teardown() set this true; clear it before pumping
        streaming = true;
        runPump(true); // async — prefills, then starts on pending play
        return true;
    }

    function resetStreamState() {
        pumpStop = true;
        streamSeekToken++;
        cancelStreamReaders();
        streamTracks = [];
        streaming = false;
        streamSampleRate = 0;
        streamTotalSamples = 0;
        jsWriteFrontier = 0;
        lastWorkletPos = 0;
        if (posWaiter) { const r = posWaiter; posWaiter = null; try { r(); } catch (_) {} }
    }

    // ── Song-fader bridge ──
    // audio-mixer.js's "Song" fader probes window.slopsmith.stems.setMasterVolume
    // and routes itself there when present, so the fader can drive every stem
    // at once via S.masterGain.
    function songFaderHook(linear) {
        const v = Number(linear);
        if (!Number.isFinite(v) || !S.masterGain) return;
        // Allow up to 2x (boost), matching the pre-rearchitect setMasterVolume
        // range the mixer's "Song" fader drives — clamping at 1 lost the top
        // half of the fader's boost range.
        S.masterGain.gain.value = Math.max(0, Math.min(2, v));
    }
    function installSongFaderBridge() {
        if (!window.slopsmith) return;
        if (!window.slopsmith.stems || typeof window.slopsmith.stems !== 'object') {
            window.slopsmith.stems = {};
        }
        if (!S.songFaderBridgeInstalled) {
            S.priorSetMasterVolume = window.slopsmith.stems.setMasterVolume;
            S.songFaderBridgeInstalled = true;
        }
        window.slopsmith.stems.setMasterVolume = songFaderHook;
    }

    // AnalyserNode tapped off the stem mix — exposed so audio-reactive
    // plugins (e.g. highway_3d) can read the stems instead of #audio, which
    // is now silent. Returns null when no sloppak is loaded.
    function getAnalyser() {
        return S.analyserNode;
    }
    function exposeStemsGlobals() {
        if (!window.slopsmith) return;
        if (!window.slopsmith.stems || typeof window.slopsmith.stems !== 'object') {
            window.slopsmith.stems = {};
        }
        if (typeof window.slopsmith.stems.getAnalyser !== 'function') {
            try { window.slopsmith.stems.getAnalyser = getAnalyser; } catch (_) {}
        }
    }

    // ── Main entry: called after song_info arrives ──
    async function onSongReady() {
        teardown();
        const info = highway.getSongInfo && highway.getSongInfo();
        const stems = (info && info.stems) || [];
        if (stems.length === 0) { emitStemsState('provider-ready', { stemCount: 0 }); return; } // archive or stem-less sloppak — do nothing

        ensureCtx();
        // Decide per-song whether the pitch-preserving worklet is available.
        // Done before buildGraphFromBuffers so the graph is built for the right
        // path. Falls back to legacy (pitch-coupling) playback otherwise.
        S.useWorklet = await ensureWorklet();
        if (!S.useWorklet && !S.workletWarned) {
            S.workletWarned = true;
            console.warn('[stems] AudioWorklet unavailable — speed control will change pitch (legacy mode)');
        }
        // Retry shim install in case #audio wasn't in the DOM when installHooks()
        // ran (no-op once installed). Without the shims the transport can't drive
        // the highway, so a sloppak must NOT proceed past here unshimmed —
        // refuse the takeover and let core's native <audio> play the guitar
        // stem alone (degraded, but better than a non-functional transport).
        installAudioShims();
        if (!shimsUsable) {
            console.error('[stems] #audio shims unavailable; sloppak playback handed back to core <audio>');
            return;
        }
        S.sloppakActive = true;

        // server.py points the core <audio> at stems[0]. If the user pressed
        // play during the song-load gap (before our shims took over) the core
        // element is already playing it — capture that as play intent AND its
        // playhead, then silence the element. Seed transport.baseOffset so
        // takeover is seamless rather than jumping to 0; a seek during the
        // decode window overrides this seed via transportSeek().
        const core = document.getElementById('audio');
        if (core) {
            if (!nativeCorePaused(core)) {
                S.pendingPlay = true;
                transport.baseOffset = nativeCoreTime(core);
            }
            nativeCorePause(core);
        }

        // teardown() above already bumped S.loadGeneration; adopt that value as
        // this load's generation. Nothing else mutates it until the next
        // teardown(), which is exactly what invalidates an in-flight load.
        const gen = S.loadGeneration;
        S.abortController = new AbortController();

        // Pristine full-mix mixdown, if the pack ships one (core #583 exposes
        // it on song_info). Worklet path only — it rides the same time-stretch
        // graph as an extra track. A failed/absent full mix degrades silently to
        // separated-stems playback (loadFullMix returns null).
        const fullUrl = (S.useWorklet && info && info.has_original_audio) ? info.original_audio_url : null;

        // Probe stem[0] to choose the path by Content-Type: the iOS proxy serves
        // `audio/wav` (raw PCM — streamable, bounded memory); desktop serves
        // `audio/ogg` (a container — keep the full-decode path). Streaming also
        // needs the worklet + fetch ReadableStream. The Range header lets a
        // 206-capable proxy serve efficiently; the current proxy/desktop returns
        // a full 200, which streams fine.
        let probe = null;
        if (S.useWorklet && streamingSupported()) {
            try {
                probe = await fetch(stems[0].url, { signal: S.abortController.signal, headers: { Range: 'bytes=0-' } });
            } catch (e) {
                if (gen !== S.loadGeneration) return;
                probe = null;
            }
            if (gen !== S.loadGeneration) { try { probe && probe.body && probe.body.cancel(); } catch (_) {} return; }
        }

        // Capture play intent before graph build — a build failure runs
        // teardown(), which clears S.pendingPlay.
        const wantedPlay = S.pendingPlay;

        if (probe && isWavResponse(probe)) {
            const ok = await setupStreaming(stems, probe, fullUrl, gen);
            // setupStreaming does NOT teardown on failure, so a stale gen here is
            // genuine supersession by a newer song (its overlay owns the screen).
            if (gen !== S.loadGeneration) return;
            if (!ok) {
                // Real streaming-setup failure. We deliberately do NOT fall back to
                // the full-decode path here: streaming is only selected for
                // audio/wav (the iOS proxy), and full-decoding 6 stems is the exact
                // ~500 MB OOM this path exists to avoid. The common failure modes
                // (AudioContext can't be pinned to the WAV rate, worklet
                // construction fails) are device-wide, so full-decode would crash
                // every large pack on such a device. Tear the partial graph down
                // (reverts to core control) and resume core if the user wanted
                // playback — degraded single-track audio beats a crash or a silent,
                // paused player.
                teardown();
                hideOverlay();
                if (wantedPlay) {
                    const c = document.getElementById('audio');
                    if (c) { try { const pr = c.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (_) {} }
                }
                return;
            }
            hideOverlay();
            injectUI();
            installSongFaderBridge();
            // S.buffersReady + pending-play are handled by the streaming pump.
            return;
        }
        // Not streamable (desktop OGG, or streaming unsupported): full-decode.
        try { probe && probe.body && probe.body.cancel(); } catch (_) {}

        let results, fullBuf = null;
        try {
            [results, fullBuf] = await Promise.all([
                loadStems(stems, gen, S.abortController.signal),
                fullUrl ? loadFullMix(fullUrl, gen, S.abortController.signal) : Promise.resolve(null),
            ]);
        } catch (e) {
            console.error('[stems] loadStems error:', e);
            results = null;
        }
        // Superseded by a newer song while we were decoding — the newer
        // song owns the overlay now, so leave it alone.
        if (gen !== S.loadGeneration) return;
        if (results === null) { hideOverlay(); return; }

        if (!buildGraphFromBuffers(results, fullBuf)) {
            hideOverlay();
            // No stems decoded: teardown() inside buildGraphFromBuffers reverted
            // to core control (S.sloppakActive=false), so the #audio shims now
            // delegate natively. We paused core during takeover above — if the
            // user wanted playback, resume it so they aren't stranded on a
            // silent, paused player (degraded single-track playback beats
            // dead silence).
            if (wantedPlay) {
                const c = document.getElementById('audio');
                if (c) { try { const pr = c.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (_) {} }
            }
            return;
        }
        hideOverlay();
        injectUI();
        installSongFaderBridge();
        S.buffersReady = true;
        emitStemsState('provider-ready', { stemCount: S.stemState.length, stemIds: S.stemState.map(s => s.id) });

        if (S.pendingPlay) { S.pendingPlay = false; transportPlay(); }
    }

    function songInfoSignature(info) {
        const stems = Array.isArray(info && info.stems) ? info.stems : [];
        const filename = (info && info.filename) || (window.slopsmith && window.slopsmith.currentSong && window.slopsmith.currentSong.filename) || S.currentFilename || '';
        return JSON.stringify({
            songKey: S.currentSongKey || '',
            filename,
            stems: stems.map(s => ({ id: s.id, url: s.url, default: !!s.default })),
        });
    }

    // Extract the persisted-settings key + filename from a playback lifecycle
    // event detail. Core sends the same { payload?, target?, settingsKey?,
    // filename? } shape on both `loading` and the `ready` aliases (see core
    // static/capabilities/playback.js _publicTarget: target.settingsKey is
    // present on every playback:* emit), so both paths resolve the song key
    // from one place — a ready that arrives without a preceding loading still
    // gets the correct key.
    function songRefFromDetail(detail = {}) {
        const payload = detail && detail.payload && typeof detail.payload === 'object' ? detail.payload : (detail || {});
        const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
        return {
            songKey: target.settingsKey || payload.settingsKey || null,
            filename: payload.filename || target.filename || null,
        };
    }

    function tryInitForCurrentSong() {
        const info = highway.getSongInfo && highway.getSongInfo();
        if (!info || !Array.isArray(info.stems)) return false;
        const signature = songInfoSignature(info);
        if (signature === S.readySignature) return true;
        S.readySignature = signature;
        S.currentFilename = info.filename || (window.slopsmith && window.slopsmith.currentSong && window.slopsmith.currentSong.filename) || S.currentFilename || null;
        try { onSongReady(); } catch (e) { console.warn('[stems] init failed:', e); }
        return true;
    }

    function startReadyPoll() {
        if (S.pollHandle !== null) clearInterval(S.pollHandle);
        let attempts = 0;
        let myHandle;
        myHandle = setInterval(() => {
            attempts++;
            if (tryInitForCurrentSong() || attempts >= 30) {
                clearInterval(myHandle);
                if (S.pollHandle === myHandle) S.pollHandle = null;
            }
        }, 200);
        S.pollHandle = myHandle;
    }

    // ── Playback lifecycle hooks ──
    function installHooks() {
        const hookState = window.__slopsmithStemsHooks || (window.__slopsmithStemsHooks = {});
        hookState.impl = {
            onPlaybackLoading(detail = {}) {
                const ref = songRefFromDetail(detail);
                S.readySignature = null;
                teardown();
                S.currentSongKey = ref.songKey;
                S.currentFilename = ref.filename || S.currentFilename || null;
            },
            onPlaybackReady(detail = {}) {
                // A `ready` alias (playback:ready / song:loaded / song:ready)
                // can fire WITHOUT a preceding `loading` (e.g. re-entering an
                // already-loaded song). S.currentSongKey would then be stale and
                // mute/volume would persist under the wrong song key (see
                // storageSongKey / redactedSongRef). Refresh it from the ready
                // event's own target — but only when the ready detail actually
                // carries a key, so a keyless ready that follows a good loading
                // never wipes a valid key.
                const ref = songRefFromDetail(detail);
                if (ref.songKey) S.currentSongKey = ref.songKey;
                if (ref.filename) S.currentFilename = ref.filename;
                if (!tryInitForCurrentSong()) startReadyPoll();
            },
            onPlaybackStopped() {
                lightStop();
            },
            teardown,
        };
        if (hookState.installed) return;
        S.wired = true;
        hookState.installed = true;

        installAudioShims();
        exposeStemsGlobals();

        const onLoading = (event) => {
            const impl = hookState.impl;
            if (impl && typeof impl.onPlaybackLoading === 'function') impl.onPlaybackLoading(event && event.detail || {});
        };
        const onReady = (event) => {
            const impl = hookState.impl;
            if (impl && typeof impl.onPlaybackReady === 'function') impl.onPlaybackReady(event && event.detail || {});
        };
        const onStopped = () => {
            const impl = hookState.impl;
            if (impl && typeof impl.onPlaybackStopped === 'function') impl.onPlaybackStopped();
        };
        const onFinished = () => {
            const impl = hookState.impl;
            if (impl && typeof impl.teardown === 'function') impl.teardown();
        };
        hookState.listeners = { onLoading, onReady, onStopped, onFinished };
        // Wire the lifecycle listeners as soon as the event bus is live. If
        // window.slopsmith.on isn't ready at eval time, retry once the
        // capability surface signals readiness — mirroring
        // installCapabilityParticipant()'s slopsmith:capabilities:ready retry.
        // (Previously these subscriptions were gated once at eval and dropped
        // silently whenever the bus wasn't up yet.)
        const wireLifecycleListeners = () => {
            if (!(window.slopsmith && typeof window.slopsmith.on === 'function')) {
                window.addEventListener('slopsmith:capabilities:ready', wireLifecycleListeners, { once: true });
                return;
            }
            window.slopsmith.on('song:loading', onLoading);
            window.slopsmith.on('playback:loading', onLoading);
            window.slopsmith.on('playback:ready', onReady);
            window.slopsmith.on('song:loaded', onReady);
            window.slopsmith.on('song:ready', onReady);
            // playback:stopped = user STOP (core playback.js:880): light stop,
            // preserve the graph so playback can resume. playback:ended =
            // genuine song end: full teardown.
            window.slopsmith.on('playback:stopped', onStopped);
            window.slopsmith.on('playback:ended', onFinished);
        };
        wireLifecycleListeners();

        // Clean up on leaving the player
        const _show = window.showScreen;
        hookState.baseShowScreen = _show;
        window.showScreen = function (id) {
            const impl = hookState.impl;
            if (id !== 'player' && impl && typeof impl.teardown === 'function') impl.teardown();
            return hookState.baseShowScreen.call(this, id);
        };
    }

    // Coerce common non-boolean inputs ('false', '0', 0, '', null) to false
    // so external callers can't accidentally mute by passing a string.
    function coerceBool(v) {
        if (v === 'false' || v === '0' || v === '' || v == null) return false;
        return Boolean(v);
    }

    function capabilityApi() {
        return window.slopsmith && window.slopsmith.capabilities;
    }

    function audioSessionApi() {
        const session = window.slopsmith && window.slopsmith.audioSession;
        return session && session.version === 1 ? session : null;
    }

    function safeStemId(id) {
        return String(id || 'stem').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'stem';
    }

    function stemStatesSnapshot() {
        const snapshot = {};
        for (const stem of S.stemState) {
            snapshot[stem.id] = { id: stem.id, on: !!stem.on, muted: !stem.on, vol: stem.vol };
        }
        return snapshot;
    }

    function registerStemOwnerStatus(availability) {
        const session = audioSessionApi();
        if (!session || typeof session.registerStemOwner !== 'function') return;
        try {
            session.registerStemOwner({
                ownerId: 'stems.provider',
                participantId: 'stems.provider',
                availability,
                stemIds: S.stemState.map(stem => stem.id),
                stemStates: stemStatesSnapshot(),
            });
        } catch (err) {
            console.warn('[stems] could not register stem owner:', err);
        }
    }

    function stemParticipantId(stem) {
        return `stems.${safeStemId(stem && stem.id)}`;
    }

    function registerStemMixParticipant(stem) {
        const session = audioSessionApi();
        if (!session || typeof session.registerMixParticipant !== 'function' || !stem) return;
        const participantId = stemParticipantId(stem);
        try {
            session.registerMixParticipant({
                participantId,
                ownerPluginId: 'stems',
                label: `Stem: ${stem.id}`,
                kind: 'stem',
                sourceMode: 'native',
                logicalFaderKey: `stems:${safeStemId(stem.id)}`,
                fader: {
                    id: safeStemId(stem.id),
                    label: stem.id,
                    min: 0,
                    max: 1,
                    step: 0.01,
                    defaultValue: 1,
                    currentValue: stem.vol,
                },
                operations: ['fader.get-value', 'fader.set-value'],
                operationHandlers: {
                    'fader.get-value': () => stem.vol,
                    'fader.set-value': (value) => {
                        const committed = stemsApi.setVolume(stem.id, value);
                        if (committed === undefined) return { outcome: 'no-target', reason: `Stem ${stem.id} is no longer available` };
                        return { committedValue: committed };
                    },
                },
                availability: 'available',
                version: 1,
            });
            registeredMixParticipantIds.add(participantId);
        } catch (err) {
            console.warn('[stems] could not register audio-mix fader:', err);
        }
    }

    function registerStemMixParticipants() {
        unregisterStemMixParticipants();
        for (const stem of S.stemState) registerStemMixParticipant(stem);
    }

    function unregisterStemMixParticipants() {
        const session = audioSessionApi();
        if (session && typeof session.unregisterMixParticipant === 'function') {
            for (const participantId of registeredMixParticipantIds) {
                try { session.unregisterMixParticipant(participantId); } catch (_) {}
            }
        }
        registeredMixParticipantIds.clear();
    }

    function isGuitarStemId(id) {
        return /(^|[-_\s])(guitars?|rhythm|lead|dist|distortion)([-_\s]|$)/i.test(String(id || ''));
    }

    function applyStemState(stem, on, vol = stem.vol) {
        stem.vol = Math.max(0, Math.min(1, Number.isFinite(Number(vol)) ? Number(vol) : stem.vol));
        stem.on = !!on;
        stem.gain.gain.value = stem.on ? stem.vol : 0;
        if (stem.btn) stem.btn.className = stem.on ? ON_CLASS : OFF_CLASS;
        registerStemOwnerStatus('available');
    }

    function emitStemsState(event, payload = {}) {
        const detail = { event, ...redactedSongRef(), ...payload };
        try { window.dispatchEvent(new CustomEvent('stems:state', { detail })); } catch (_) {}
        const api = capabilityApi();
        if (api && typeof api.emitEvent === 'function') {
            api.emitEvent('stems', event === 'provider-ready' ? 'stems.ready' : event, detail);
        }
    }

    function stemSelector(stem) {
        return isGuitarStemId(stem && stem.id) ? 'guitar' : String(stem && stem.id || '*').toLowerCase();
    }

    function recordStemUserOverride(stem, reason) {
        const session = audioSessionApi();
        if (session && typeof session.recordStemManualOverride === 'function') {
            try { session.recordStemManualOverride({ requester: 'user', stemIds: [stem.id], reason }); }
            catch (_) {}
        }
        const api = capabilityApi();
        if (!api || typeof api.recordUserOverride !== 'function') return;
        api.recordUserOverride({
            capability: 'stems',
            command: 'mute',
            source: 'user',
            target: { id: stem.id, kind: stemSelector(stem) },
            selector: stemSelector(stem),
            reason,
        });
        if (typeof api.emitEvent === 'function') api.emitEvent('stems', 'stems.manual-unmute', redactedSongRef({ id: stem.id, on: stem.on }));
    }

    function capabilityTargets(payload = {}) {
        if (!S.stemState.length) return [];
        const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
        const id = payload.id || target.id;
        if (id) return S.stemState.filter(s => s.id.toLowerCase() === String(id).toLowerCase());
        const selector = String(payload.selector || target.selector || target.kind || '').toLowerCase();
        if (selector === 'guitar') {
            const guitars = S.stemState.filter(s => isGuitarStemId(s.id));
            return guitars.length ? guitars : S.stemState.filter(s => String(s.id).toLowerCase() === 'other');
        }
        return S.stemState.slice();
    }

    function claimIdFromContext(cmdCtx) {
        const payload = cmdCtx && cmdCtx.payload && typeof cmdCtx.payload === 'object' ? cmdCtx.payload : {};
        const claim = cmdCtx && cmdCtx.claim && typeof cmdCtx.claim === 'object' ? cmdCtx.claim : {};
        return payload.claimId || claim.claimId || null;
    }

    function capMute(cmdCtx = {}) {
        const payload = cmdCtx.payload || {};
        const targets = capabilityTargets(payload);
        if (!S.stemState.length) {
            return { outcome: 'no-owner', reason: 'No active stem graph is available', payload: redactedSongRef({ mutedIds: [] }) };
        }
        if (!targets.length) {
            return { outcome: 'no-target', reason: 'No matching stem target is available', payload: redactedSongRef({ mutedIds: [] }) };
        }
        let claimId = claimIdFromContext(cmdCtx);
        const session = audioSessionApi();
        if (session && typeof session.muteStems === 'function') {
            try {
                const result = session.muteStems({
                    claimId,
                    requester: cmdCtx.requester || payload.requester || 'stems.capability',
                    stemIds: targets.map(stem => stem.id),
                    restoreSnapshot: stemStatesSnapshot(),
                });
                claimId = claimId || (result && result.payload && result.payload.claimId) || null;
            } catch (_) {}
        }
        const mutedIds = [];
        for (const stem of targets) {
            if (claimId) {
                const key = `${claimId}:${stem.id}`;
                if (!claimSnapshots.has(key)) claimSnapshots.set(key, { claimId, id: stem.id, prevOn: stem.on, prevVol: stem.vol });
            }
            applyStemState(stem, false, stem.vol);
            mutedIds.push(stem.id);
        }
        return { outcome: 'handled', payload: redactedSongRef({ claimId, mutedIds }) };
    }

    function capRestore(cmdCtx = {}) {
        const claimId = claimIdFromContext(cmdCtx);
        if (!claimId) {
            return { outcome: 'no-target', reason: 'Restore requires a claimId', payload: redactedSongRef({ restoredIds: [] }) };
        }
        const session = audioSessionApi();
        if (session && typeof session.restoreStems === 'function' && claimId) {
            try { session.restoreStems({ claimId, requester: cmdCtx.requester || 'stems.capability' }); }
            catch (_) {}
        }
        const restoredIds = [];
        for (const [key, previous] of Array.from(claimSnapshots.entries())) {
            if (previous.claimId !== claimId) continue;
            const stem = S.stemState.find(s => s.id === previous.id);
            if (stem) {
                applyStemState(stem, previous.prevOn, previous.prevVol);
                restoredIds.push(stem.id);
            }
            claimSnapshots.delete(key);
        }
        return { outcome: 'handled', payload: redactedSongRef({ claimId, restoredIds }) };
    }

    function clearClaimSnapshots(claimId) {
        if (!claimId) return;
        for (const [key, previous] of Array.from(claimSnapshots.entries())) {
            if (previous.claimId === claimId) claimSnapshots.delete(key);
        }
    }

    function capSetVolume(cmdCtx = {}) {
        const payload = cmdCtx.payload || {};
        if (!S.stemState.length) return { outcome: 'no-owner', reason: 'No active stem graph is available', payload: redactedSongRef({ stems: [] }) };
        const committed = stemsApi.setVolume(payload.id || payload.target?.id, payload.vol ?? payload.volume);
        if (committed === undefined) return { outcome: 'no-target', reason: 'No matching stem target is available', payload: capList().payload };
        return { outcome: 'handled', payload: { ...capList().payload, committedValue: committed } };
    }

    function capList() {
        return { outcome: 'handled', payload: redactedSongRef({ stems: stemsApi.getState().map(s => ({ id: s.id, vol: s.vol, on: s.on })) }) };
    }

    function capInspect() {
        return { outcome: 'handled', payload: redactedSongRef({ activeClaims: Array.from(claimSnapshots.values()), stems: capList().payload.stems }) };
    }

    function installCapabilityParticipant() {
        const api = capabilityApi();
        if (!api || typeof api.registerParticipant !== 'function') {
            window.addEventListener('slopsmith:capabilities:ready', installCapabilityParticipant, { once: true });
            return;
        }
        api.registerParticipant('stems', {
            stems: {
                roles: ['owner', 'provider'],
                kind: 'command',
                commands: ['mute', 'restore', 'setVolume', 'list', 'inspect', 'mute-guitar', 'unmute-guitar'],
                emits: ['stems.ready', 'stems.manual-unmute'],
                observes: ['claim:released'],
                description: 'Owns stem mix automation commands and exposes sloppak stem state for requester plugins.',
                compatibility: 'legacy-window-shim',
                ownership: 'exclusive-owner',
                safety: 'safe',
                version: 1,
                runtime: true,
                handlers: {
                    mute: capMute,
                    restore: capRestore,
                    setVolume: capSetVolume,
                    list: capList,
                    inspect: capInspect,
                    'mute-guitar': capMute,
                    'unmute-guitar': capRestore,
                },
                eventHandlers: {
                    'claim:released': (detail) => clearClaimSnapshots(detail && detail.payload && detail.payload.claimId),
                },
            },
            playback: {
                roles: ['observer'],
                kind: 'lifecycle',
                observes: ['loading', 'ready', 'stopped', 'ended'],
                description: 'Observes playback lifecycle events to rebuild or tear down the stem graph without wrapping window.playSong.',
                compatibility: 'shim-allowed',
                ownership: 'observer-only',
                safety: 'safe',
                version: 1,
                runtime: true,
            },
            'audio-mix': {
                roles: ['provider'],
                operations: ['fader.get-value', 'fader.set-value'],
                events: ['fader-value-changed', 'fader-unavailable'],
                description: 'Registers per-stem faders with the core audio-mix coordinator while Stems owns the media graph.',
                compatibility: 'none',
                ownership: 'multi-provider',
                safety: 'safe',
                version: 1,
                runtime: true,
            },
        });
        registerStemMixParticipants();
        registerStemOwnerStatus(S.stemState.length ? 'available' : 'unavailable');
        emitStemsState('provider-ready', { stemCount: S.stemState.length, stemIds: S.stemState.map(s => s.id) });
    }

    /**
     * Public API exposed at window.stems for other plugins (e.g. stem_mixer).
     *
     *   getState()           Returns [{id, vol, on, gain, audio}, ...] for the
     *                        current song's stems. Callers may mutate
     *                        gain.gain.value directly to set a stem's level,
     *                        but should re-fetch on every song:loaded because
     *                        gains are recreated between songs. In legacy
     *                        (AudioBufferSourceNode) mode `gain` is a live
     *                        GainNode; in worklet mode it is a GainNode-shaped
     *                        handle (same `.gain.value`, with no-op
     *                        connect/disconnect) that forwards the level to the
     *                        time-stretch worklet. `audio` is always null now
     *                        that stems play from AudioBuffers / the worklet,
     *                        not <audio> elements; the key is kept for shape
     *                        compatibility.
     *   setVolume(id, vol)   `id` matched case-insensitively. `vol` is a float
     *                        in [0, 1]; out-of-range clamped, NaN ignored.
     *   setMuted(id, muted)  `muted=true` mutes, `false` unmutes. Common
     *                        non-boolean inputs are coerced to false.
     *   stemState              Live array of internal stem-state objects.
     */
    const stemsApi = {
        getState: () => S.stemState.map(s => ({
            id: s.id, vol: s.vol, on: s.on, gain: s.gain, audio: null,
        })),
        setVolume(id, vol) {
            const v = Number(vol);
            if (!Number.isFinite(v)) return undefined;
            const target = String(id).toLowerCase();
            const clamped = clampVolume(v);
            if (clamped == null) return undefined;
            let applied = false;
            for (const s of S.stemState) {
                if (s.id.toLowerCase() !== target) continue;
                setStemVolume(s, clamped);
                applied = true;
            }
            if (applied) registerStemOwnerStatus('available');
            return applied ? clamped : undefined;
        },
        setMuted(id, muted) {
            const m = coerceBool(muted);
            const target = String(id).toLowerCase();
            let applied = false;
            for (const s of S.stemState) {
                if (s.id.toLowerCase() !== target) continue;
                s.on = !m;
                if (s.gain) s.gain.gain.value = s.on ? s.vol : 0;
                updateStemButton(s);
                saveMuted(storageSongKey(), S.stemState);
                applied = true;
            }
            if (applied) registerStemOwnerStatus('available');
        },
    };
    Object.defineProperty(stemsApi, 'stemState', {
        get: () => S.stemState, enumerable: true,
    });

    // Don't clobber an existing window.stems set by another plugin —
    // only fill slots that aren't already defined.
    const existing = window.stems;
    const isMergeable = existing && (typeof existing === 'object' || typeof existing === 'function');
    if (!isMergeable) {
        window.stems = stemsApi;
    } else {
        const desc = Object.getOwnPropertyDescriptors(stemsApi);
        for (const key of Object.keys(desc)) {
            if (key in existing) continue;
            try {
                Object.defineProperty(existing, key, desc[key]);
            } catch (err) {
                console.warn(`[stems] could not install window.stems.${key}:`, err);
            }
        }
    }

    installCapabilityParticipant();
    installHooks();
})();
