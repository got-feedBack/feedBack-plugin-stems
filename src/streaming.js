// ══════════════════════════════════════════════════════════════════════
//  Streaming (bounded-memory) playback — the iOS WAV path
//
//  The iOS client proxy transcodes each OGG stem to RIFF/WAV (16-bit PCM)
//  and streams it. Decoding whole stems to AudioBuffers (buildGraphFromBuffers
//  in main.js) jettisons the WKWebView content process at ~6 stems (~500 MB).
//  Here we read the PCM incrementally off fetch().body and feed the worklet's
//  bounded ring via 'append', dropping consumed PCM, so peak memory is a
//  few-second window per track — independent of song length or stem count.
//  Raw PCM is sliceable at any sample, so NO decoder/WebCodecs/demuxer is
//  needed. Desktop (audio/ogg, not sliceable) keeps the full-decode path.
// ══════════════════════════════════════════════════════════════════════
import { S, ST, transport } from './state.js';
import { ensureCtxAtRate, updateLatencyOffset } from './audio-ctx.js';
import { makeStemGainHandle } from './mix.js';
import { publishAudioGraph } from './audio-graph-publish.js';
import { computeMixGains } from './mix-gains.js';
import { clampVolume } from './util.js';
import { parseWavHeader, pcm16ToFloat32 } from './wav-pcm.js';
import { karaokeDefault, loadDefaultMuted, loadMuted, loadVolumes } from './prefs.js';

// Injected seams to main.js's transport/orchestration layer. Injected (not
// imported) to avoid a static import cycle: transport already imports
// repositionStream/setupStreaming from here, so this layer can't import back.
let startPendingPlay = () => {};     // resume a deferred play() once buffers are ready
let songGain = () => 0.8;            // seed the master gain from the mixer / persisted volume
let onWorkletMessage = () => {};     // the shared worklet 'ready'/'ended'/'pos' handler
export function configureStreaming(hooks) {
    if (hooks.startPendingPlay) startPendingPlay = hooks.startPendingPlay;
    if (hooks.songGain) songGain = hooks.songGain;
    if (hooks.onWorkletMessage) onWorkletMessage = hooks.onWorkletMessage;
}

const STREAM_AHEAD_SEC = 2.0;      // keep ~this far buffered ahead of pos
const STREAM_PREFILL_SEC = 0.5;    // buffer this much before starting
const STREAM_CAP_SEC = 3.5;        // worklet per-track window capacity
const STREAM_CHUNK_FRAMES = 8192;  // max frames appended per pump round
const EMPTY_BYTES = new Uint8Array(0);

export function streamingSupported() {
    return typeof ReadableStream !== 'undefined'
        && typeof fetch === 'function'
        && typeof AudioWorkletNode !== 'undefined';
}
export function isWavResponse(resp) {
    try {
        const ct = ((resp && resp.headers && resp.headers.get('content-type')) || '').toLowerCase();
        return ct.indexOf('wav') !== -1;
    } catch (_) { return false; }
}

// True when `offset` (s) falls inside the PCM the streaming worklet currently
// holds around its read frontier. Outside it — e.g. replaying from 0 after the
// song ended and the pump drained the window to the tail — the worklet would
// read silence, so the caller must refetch (repositionStream) first.
export function streamOffsetBuffered(offset) {
    if (!ST.streaming || ST.streamSampleRate <= 0) return true;
    const posSamp = Math.round(offset * ST.streamSampleRate);
    const behind = Math.ceil(0.1 * ST.streamSampleRate);
    return posSamp >= ST.lastWorkletPos - behind && posSamp <= ST.jsWriteFrontier;
}

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
// (parseWavHeader + pcm16ToFloat32 are the pure decoders in wav-pcm.js.)
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
// (Exported for the seek-token guard test; not part of the plugin's public API.)
export async function appendRound(token = ST.streamSeekToken) {
    const remaining = ST.streamTotalSamples - ST.jsWriteFrontier;
    if (remaining <= 0) return false;
    const aheadTarget = Math.min(ST.streamTotalSamples,
        ST.lastWorkletPos + Math.ceil(STREAM_AHEAD_SEC * ST.streamSampleRate));
    const frames = Math.min(STREAM_CHUNK_FRAMES, remaining, Math.max(0, aheadTarget - ST.jsWriteFrontier));
    if (frames <= 0) return false;

    const blocks = [];
    const transfer = [];
    for (const t of ST.streamTracks) {
        // Bail before touching each track once a seek supersedes us: dequeue
        // reads t.reader fresh, and repositionStream reopens readers on these
        // same track objects — consuming a later track here would steal PCM
        // from the new pump. The in-flight track (if any) resolves off its own
        // now-cancelled reader, so it can't reach the fresh ones.
        if (token !== ST.streamSeekToken) return false;
        const realWanted = Math.max(0, Math.min(frames, t.totalFrames - ST.jsWriteFrontier));
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
    // A seek (repositionStream) bumps streamSeekToken and resets jsWriteFrontier.
    // If it landed while we were awaiting dequeueTrackFrames above, these blocks
    // are misaligned to the old frontier — drop them. Checking pumpStop alone is
    // not enough: repositionStream clears it again before this continuation runs.
    if (ST.pumpStop || token !== ST.streamSeekToken || !S.workletNode) return false;
    try {
        S.workletNode.port.postMessage({ type: 'append', base: ST.jsWriteFrontier, frames, tracks: blocks }, transfer);
    } catch (_) { return false; }
    ST.jsWriteFrontier += frames;
    return true;
}

// Await the worklet's next backpressure ('pos') message, or a short timeout.
function waitPos() {
    return new Promise((resolve) => {
        ST.posWaiter = resolve;
        setTimeout(() => { if (ST.posWaiter === resolve) { ST.posWaiter = null; resolve(); } }, 100);
    });
}

// The pump: keep the worklet window ~STREAM_AHEAD_SEC ahead of its read
// frontier. On the initial run, prefill then start (honouring pending play).
async function runPump(isInitial) {
    // Capture the seek token for this pump run: a seek supersedes us by bumping
    // it, so every loop guard + append re-checks it after awaits (see appendRound).
    const token = ST.streamSeekToken;
    try {
        const prefillTo = Math.min(ST.streamTotalSamples,
            ST.jsWriteFrontier + Math.ceil(STREAM_PREFILL_SEC * ST.streamSampleRate));
        while (!ST.pumpStop && token === ST.streamSeekToken && ST.jsWriteFrontier < prefillTo) {
            if (!(await appendRound(token))) break;
        }
        if (ST.pumpStop || token !== ST.streamSeekToken) return;
        if (isInitial) {
            S.buffersReady = true;
            if (S.pendingPlay) { S.pendingPlay = false; startPendingPlay(); }
        }
        while (!ST.pumpStop && token === ST.streamSeekToken && ST.jsWriteFrontier < ST.streamTotalSamples) {
            const target = Math.min(ST.streamTotalSamples,
                ST.lastWorkletPos + Math.ceil(STREAM_AHEAD_SEC * ST.streamSampleRate));
            if (ST.jsWriteFrontier >= target) { await waitPos(); continue; }
            if (!(await appendRound(token))) break;
        }
    } catch (e) {
        if (!ST.pumpStop && (!e || e.name !== 'AbortError')) console.warn('[stems] stream pump error:', e);
    }
}

// INVARIANT (seek safety): this sets t.done = true SYNCHRONOUSLY for every track.
// repositionStream calls it before its first await, so any in-flight dequeue's
// parked t.reader.read() resolves (cancelled) with t.done already true and
// ensureBytes exits — it can't loop onto a reopened reader, because openTrackStreams
// only reinstalls t.reader/t.done=false AFTER a network fetch (a macrotask later).
// Keep the synchronous t.done=true if this is ever refactored, or reopened readers
// on the same track objects could be consumed by a stale append (see appendRound's
// per-track token guard, which is the second line of defence).
function cancelStreamReaders() {
    for (const t of ST.streamTracks) {
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
    await Promise.all(ST.streamTracks.map(async (t) => {
        // Byte offset of sample `fromSample` in this track's WAV (header +
        // linear PCM). dataOffset is the parsed header size (44 for the
        // proxy's canonical WAV, but honour a non-canonical one too).
        const byteOffset = t.dataOffset + fromSample * t.byteAlign;
        const headers = { Range: 'bytes=' + byteOffset + '-' };
        const resp = await fetch(t.url, { signal: S.abortController.signal, headers });
        if (gen !== S.loadGeneration || token !== ST.streamSeekToken) {
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
export async function repositionStream(targetSec) {
    const token = ++ST.streamSeekToken;
    const gen = S.loadGeneration;
    ST.pumpStop = true;
    cancelStreamReaders();
    // Unblock an old pump parked in waitPos() so it re-checks its (now stale)
    // token and exits promptly, instead of hanging until the 100ms timeout.
    if (ST.posWaiter) { const r = ST.posWaiter; ST.posWaiter = null; try { r(); } catch (_) {} }
    const Tsamp = Math.max(0, Math.round(targetSec * ST.streamSampleRate));
    if (S.workletNode) {
        try { S.workletNode.port.postMessage({ type: 'seek', offset: Tsamp / ST.streamSampleRate }); } catch (_) {}
    }
    ST.jsWriteFrontier = Tsamp;
    ST.lastWorkletPos = Tsamp;
    try {
        await openTrackStreams(Tsamp, gen, token);
    } catch (e) {
        if (token === ST.streamSeekToken && (!e || e.name !== 'AbortError')) {
            console.warn('[stems] seek refetch failed:', e);
        }
        return;
    }
    if (token !== ST.streamSeekToken || gen !== S.loadGeneration) return;
    ST.pumpStop = false;
    // If a seek supersedes the initial prefill, runPump(true) returns before
    // flipping S.buffersReady / honouring pendingPlay. Carry the initial role
    // forward until readiness is actually established, else the stream would
    // stay silent (play() only sets pendingPlay) until a reload.
    runPump(!S.buffersReady);
}

// Build the streaming graph + pump from the fetched WAV streams. `probeResp`
// is stem[0]'s already-open response. Returns true once set up (the pump
// runs asynchronously), false on failure. On failure it does NOT teardown()
// (that would bump S.loadGeneration and hide the failure from onSongReady's
// supersession check) — the caller tears down + falls back. A `false` return
// with `gen === S.loadGeneration` is a real failure; a stale gen is supersession.
export async function setupStreaming(stems, probeResp, fullUrl, gen) {
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
        if (!ST.streamSampleRate) {
            ST.streamSampleRate = hdr.sampleRate;
        } else if (hdr.sampleRate !== ST.streamSampleRate) {
            console.warn('[stems] stem "' + t.id + '" rate ' + hdr.sampleRate
                + ' != ' + ST.streamSampleRate + '; cannot stream a mixed-rate pack');
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
        if (hdr && hdr.sampleRate === ST.streamSampleRate) {
            t.nch = hdr.nch; t.byteAlign = hdr.nch * 2; t.dataOffset = hdr.dataOffset;
            t.totalFrames = Math.floor(hdr.dataSize / t.byteAlign);
            fullTrack = t;
        } else {
            if (hdr) console.warn('[stems] full mix rate '
                + hdr.sampleRate + ' != ' + ST.streamSampleRate + '; using separated stems only');
            try { t.reader.cancel(); } catch (_) {}
        }
    }

    const maxStemFrames = built.reduce((m, t) => Math.max(m, t.totalFrames), 0);
    if (maxStemFrames <= 0) return false;
    ST.streamTotalSamples = maxStemFrames;

    // 2. Pin the AudioContext to the source rate + (re)load the worklet.
    const okCtx = await ensureCtxAtRate(ST.streamSampleRate);
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
    ST.streamTracks = built.slice();
    if (fullTrack) {
        const tol = Math.max(2048, Math.round(0.05 * ST.streamSampleRate));
        if (Math.abs(fullTrack.totalFrames - maxStemFrames) > tol) {
            console.warn('[stems] full mix length off by '
                + (fullTrack.totalFrames - maxStemFrames) + ' frames; using separated stems only.');
            try { fullTrack.reader.cancel(); } catch (_) {}
        } else {
            fullTrack.totalFrames = Math.min(fullTrack.totalFrames, maxStemFrames);
            ST.streamTracks.push(fullTrack);
            S.fullTrackIndex = built.length;
        }
    }

    // 4. Mix graph + stem UI state (mirrors buildGraphFromBuffers, no buffers).
    S.masterGain = S.audioCtx.createGain();
    S.masterGain.gain.value = songGain();
    S.masterGain.connect(S.audioCtx.destination);
    S.analyserNode = S.audioCtx.createAnalyser();
    S.analyserNode.fftSize = 256;
    S.masterGain.connect(S.analyserNode);
    publishAudioGraph();
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
    transport.duration = ST.streamTotalSamples / ST.streamSampleRate;
    const initialOffsetSamples = Math.max(0, Math.min(
        Math.round((transport.baseOffset || 0) * ST.streamSampleRate), ST.streamTotalSamples));
    transport.baseOffset = initialOffsetSamples / ST.streamSampleRate;
    transport.baseCtxTime = 0;
    transport.playing = false;
    const core = document.getElementById('audio');
    const coreRate = core ? Number(core.playbackRate) : 1;
    transport.rate = (Number.isFinite(coreRate) && coreRate > 0) ? coreRate : 1;
    ST.jsWriteFrontier = initialOffsetSamples;
    ST.lastWorkletPos = initialOffsetSamples;
    if (initialOffsetSamples > 0) {
        for (const t of ST.streamTracks) t.skipBytes = initialOffsetSamples * t.byteAlign;
    }

    const { stemGains, fullGain } = computeMixGains(S.stemState, S.fullTrackIndex >= 0);
    const gains = stemGains.slice();
    if (S.fullTrackIndex >= 0) gains.push(fullGain);
    const openTracks = ST.streamTracks.map((t) => ({ nch: t.nch, length: t.totalFrames }));
    try {
        S.workletNode.port.postMessage({
            type: 'open', tracks: openTracks, gains,
            sampleRate: ST.streamSampleRate, cap: Math.ceil(STREAM_CAP_SEC * ST.streamSampleRate),
            startSample: initialOffsetSamples,
        });
    } catch (e) {
        console.warn('[stems] worklet open failed; not streaming:', e);
        return false;
    }
    S.workletPostReady = true;
    updateLatencyOffset();

    ST.pumpStop = false; // teardown() set this true; clear it before pumping
    ST.streaming = true;
    runPump(true); // async — prefills, then starts on pending play
    return true;
}

export function resetStreamState() {
    ST.pumpStop = true;
    ST.streamSeekToken++;
    cancelStreamReaders();
    ST.streamTracks = [];
    ST.streaming = false;
    ST.streamSampleRate = 0;
    ST.streamTotalSamples = 0;
    ST.jsWriteFrontier = 0;
    ST.lastWorkletPos = 0;
    if (ST.posWaiter) { const r = ST.posWaiter; ST.posWaiter = null; try { r(); } catch (_) {} }
}
