import { computeMixGains } from './mix-gains.js';
import { clampVolume, coerceBool, hashString, isGuitarStemId } from './util.js';
import { ensureCtx, ensureWorklet, updateLatencyOffset } from './audio-ctx.js';
import { makeStemGainHandle } from './mix.js';
import { publishAudioGraph, retractAudioGraph } from './audio-graph-publish.js';
import {
    setupStreaming, resetStreamState, streamingSupported, isWavResponse, configureStreaming,
} from './streaming.js';
import {
    onWorkletMessage, transportPlay, lightStop, stopSources, flushPendingPlayResolvers,
    installAudioShims, nativeCorePaused, nativeCorePause, nativeCoreTime,
} from './transport.js';
import {
    karaokeDefault, setKaraokeDefault,
    loadDefaultMuted, saveDefaultMuted,
    loadMuted, saveMuted, loadVolumes, saveVolume,
} from './prefs.js';
import {
    S, SH, ST, transport, registeredMixParticipantIds, pointerCleanupHandlers, claimSnapshots,
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

    // Wire the streaming layer's seams back to the transport/orchestration layers
    // (streaming.js can't import them — transport imports streaming). transportPlay
    // + onWorkletMessage come from transport.js; persistedSongGain is local (hoisted).
    configureStreaming({
        startPendingPlay: transportPlay,   // resume a deferred play() when buffers arrive
        songGain: persistedSongGain,       // seed master gain from the mixer / persisted vol
        onWorkletMessage,                  // shared worklet 'ready'/'ended'/'pos' handler
    });

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
    // Pristine full-mix track (feedBack#580 / core #583, #933). When a pack ships
    // its pre-separation mixdown — the RESERVED `full` stem (spec §5.3), which
    // core surfaces separately from `stems` because it is a mixdown, not a layer
    // — we load it as one extra worklet track and play IT instead of the lossy
    // demucs recombination whenever every stem is on at 100% ("unity"); the
    // moment any stem is muted/attenuated we cross to the separated stems.
    // Worklet path only; -1 = no full-mix track.

    // Mix routing (applyMixRouting + the per-stem gain handle) → src/mix.js;
    // computeMixGains (pure) → src/mix-gains.js. Both imported above.

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
            retractAudioGraph();
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
        publishAudioGraph();

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
            // tolerance. The full mix is a SEPARATE encode (codec priming can
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
                    console.warn('[stems] full mix length off by '
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
        const info = currentSongInfo();
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
        if (!SH.shimsUsable) {
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

        // Pristine full-mix mixdown, if the pack ships one. This is the RESERVED
        // `full` stem (feedpak §5.3), which core lifts out of `info.stems` and
        // surfaces separately — it is a mixdown, not a layer, so it must never be
        // one of the tracks we sum. Worklet path only: it rides the same
        // time-stretch graph as an extra track. A failed/absent full mix degrades
        // silently to separated-stems playback (loadFullMix returns null).
        //
        // `has_original_audio` / `original_audio_url` are the DEPRECATED aliases
        // of these two fields, named after a manifest key core invented and the
        // spec never had (#933). Kept as a fallback so this plugin still works
        // against a core that predates the rename; drop with the aliases.
        const hasFullMix = !!(info && (info.has_full_mix || info.has_original_audio));
        const fullMixUrl = info && (info.full_mix_url || info.original_audio_url);
        const fullUrl = (S.useWorklet && hasFullMix) ? fullMixUrl : null;

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

    // The stem list, from the highway if it has arrived — otherwise from the
    // preload (see preloadSong). Both carry the same {id,url,default} triples;
    // core builds them from one shared helper precisely so these cannot drift,
    // which is what lets the signature below match and the ready path skip a
    // second, identical build.
    function currentSongInfo() {
        const live = highway.getSongInfo && highway.getSongInfo();
        if (live && Array.isArray(live.stems) && live.stems.length) return live;
        const pre = S.preloadInfo;
        if (pre && pre.filename && pre.filename === S.currentFilename) return pre;
        return live || null;
    }

    // Start the whole load — fetch, decode, and the graph build — as soon as the
    // song starts loading, instead of waiting for the highway's WS `ready`.
    //
    // The graph build hands every stem's decoded PCM to the audio worklet, which
    // means copying the entire song: for a 4-minute 6-stem pack that is over half
    // a GIGABYTE of memcpy, and it runs in one frame on the main thread. Done at
    // `ready` — with the player already on screen — it froze the picture for
    // ~700ms: the venue video visibly stopped. Measured on a real load: a 698ms
    // frame, right as the song-credits card appeared.
    //
    // Nothing about the work changes; only WHEN. Here it lands behind the loading
    // overlay, before the highway (and the venue) is drawn, where a stalled frame
    // costs nothing.
    //
    // Best-effort: any failure just leaves the old `ready`-driven path to do it.
    async function preloadSong(filename) {
        if (!filename) return;
        const gen = ++S.preloadGen;
        let info = null;
        try {
            const res = await fetch('/api/song/' + encodeURIComponent(filename) + '?stems=1');
            if (!res.ok) return;
            const d = await res.json();
            if (!Array.isArray(d.stems) || d.stems.length === 0) return;
            info = {
                filename,
                stems: d.stems,
                full_mix_url: d.full_mix_url || null,
                has_full_mix: !!d.full_mix_url,
            };
        } catch (_) {
            return;   // offline / older core without ?stems=1 → ready path handles it
        }
        // A newer song (or a teardown) started while we were fetching.
        if (gen !== S.preloadGen || filename !== S.currentFilename) return;
        S.preloadInfo = info;
        tryInitForCurrentSong();
    }

    function tryInitForCurrentSong() {
        const info = currentSongInfo();
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
                // Get the whole load underway NOW — before the highway (and the
                // venue) is on screen. See preloadSong for why that matters.
                S.preloadInfo = null;
                preloadSong(S.currentFilename);
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
                // `feedBack:capabilities:ready` is what capabilities.js actually dispatches
                // (capabilities.js:1536). The slopsmith: name is the PRE-DMCA event and nothing
                // emits it any more — so this fallback has been DEAD since the rename, and the
                // lifecycle listeners silently never wired when the bus was late. Keep the old
                // alias too, harmlessly, for an older capabilities build.
                window.addEventListener('feedBack:capabilities:ready', wireLifecycleListeners, { once: true });
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

        // Clean up on leaving the player.
        //
        // This USED to monkey-patch window.showScreen. It doesn't any more, and that mattered:
        // THREE parties were wrapping that one global — core publishes it, the v3 shell wrapped it
        // (carrying the legacy home -> v3-songs mapping), and this wrapped it again — each
        // capturing whatever happened to be there at the time. Plugins load ASYNCHRONOUSLY, so the
        // chain linked up in whatever order the race settled, and when this wrapper won, the
        // shell's mapping was silently dropped and the LIBRARY OPENED ON THE DEAD LEGACY SCREEN.
        // Testers saw it as "randomly, the library shows the old interface"
        // (got-feedback/feedback#923, #924).
        //
        // Core already emits screen:changed for exactly this. Listening costs nothing, cannot
        // clobber another plugin, and cannot be clobbered by one.
        //
        // RETRY IF THE BUS IS LATE. Codex [P2] on the first cut, and it was right: the old
        // wrapper did not need window.feedBack to exist, but a listener does. Bailing out when
        // the bus is not ready yet would silently mean teardown() NEVER runs — a leak that only
        // shows up as stems still playing after you leave the player. Same shape, and the same
        // fix, as wireLifecycleListeners() above.
        // screen:CHANGING, not screen:changed. Codex [P2], and it matters: the old wrapper ran
        // BEFORE showScreen did anything, whereas screen:changed fires at the very END — after
        // core awaits library and provider loads. Listening to the late event would delay teardown
        // behind a slow fetch, or skip it entirely if that fetch threw, and the stems graph would
        // keep playing on a non-player screen. screen:changing fires before any of that, which is
        // exactly the timing the wrapper had.
        const wireScreenListener = () => {
            // Either bus. `window.slopsmith` is the LEGACY ALIAS of the same object
            // (core's app.js: `window.slopsmith = window.feedBack`), and the rest of this file
            // reads it. Codex [P2]: on a build that only exposes the old name, reading just
            // `window.feedBack` would attach nothing — and with the showScreen wrapper gone,
            // teardown() would silently never run and stems would keep playing after you leave
            // the player. They are the same object; take whichever is there.
            const bus = window.feedBack || window.slopsmith;
            if (!(bus && typeof bus.on === 'function')) {
                window.addEventListener('feedBack:capabilities:ready', wireScreenListener, { once: true });
                window.addEventListener('slopsmith:capabilities:ready', wireScreenListener, { once: true });
                return;
            }
            // BOTH events, deliberately. Codex [P2], and it is a cross-repo ordering problem:
            //
            //   screen:changing  fires BEFORE core navigates — the timing the old wrapper had, and
            //                    the one we want. But it is NEW: today's released host does not
            //                    emit it yet (got-feedback/feedback#924).
            //   screen:changed   fires at the END of showScreen. Later than ideal, but it exists
            //                    on every host in the field TODAY.
            //
            // Listening to only the new one would mean teardown() NEVER runs on the current host —
            // the stems graph would just keep playing after you leave the player. Listening to only
            // the old one reintroduces the late-teardown problem once the host is updated.
            //
            // Both is safe: the wrapper this replaces called teardown() on EVERY non-player
            // navigation, so it is already idempotent by construction. On a new host teardown runs
            // at the early (correct) moment and the late event is a cheap no-op; on an old host the
            // late event is the only one, exactly as before.
            const onLeavingPlayer = (ev) => {
                const id = ev && ev.detail && ev.detail.id;
                if (!id || id === 'player') return;
                const impl = hookState.impl;
                if (impl && typeof impl.teardown === 'function') impl.teardown();
            };
            bus.on('screen:changing', onLeavingPlayer);   // preferred — pre-navigation
            bus.on('screen:changed', onLeavingPlayer);    // fallback — hosts without the new event
        };
        wireScreenListener();
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
            // Same dead-event bug as above — see the note at wireLifecycleListeners.
            window.addEventListener('feedBack:capabilities:ready', installCapabilityParticipant, { once: true });
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
