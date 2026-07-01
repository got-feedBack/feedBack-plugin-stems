/* ======================================================================
 *  Stems Toggle — pitch-preserving time-stretch worklet
 *
 *  A single AudioWorkletProcessor that acts as the source node for the
 *  stems graph. It mixes all tracks (with live per-track gains) into one
 *  signal and time-stretches that single mix with WSOLA (Waveform-Similarity
 *  Overlap-Add), so changing playback speed changes tempo WITHOUT changing
 *  pitch — matching what archive playback gets for free from
 *  HTMLMediaElement.preservesPitch.
 *
 *  Two ways to feed it PCM:
 *   - 'load' (desktop / full-decode): every track's PCM is handed over once,
 *     up front, and RETAINED for the whole song (instant seek, no refill).
 *   - 'open' + 'append' (streaming / iOS): the processor holds only a bounded
 *     sliding window per track. The main thread pumps aligned PCM blocks as
 *     playback consumes them, and the processor DROPS samples behind the read
 *     frontier, so peak memory is a small window regardless of song length or
 *     track count. Seeks flush the window; the main thread refetches from the
 *     target and re-appends. Under-run (window not filled ahead of the read
 *     frontier yet) STALLS to silence rather than reading unwritten samples.
 *
 *  Why a worklet-as-source instead of a mid-graph effect: a mid-graph
 *  AudioWorklet receives a fixed 128 input samples per render quantum and
 *  must emit 128, so it cannot change tempo (tempo != 1 needs input:output
 *  != 1) without starving or growing an unbounded buffer. Owning the read
 *  frontier lets the processor pull input at its own rate.
 *
 *  Why mix-then-stretch ONCE (not per track): all tracks share one uniform
 *  rate, and stretching a single mixed signal is inherently sample-locked —
 *  there is no per-stream WSOLA divergence to desync the note highway.
 *
 *  At rate == 1.0 the processor is an exact pass-through mixer (no WSOLA,
 *  zero added latency), so the common case is bit-identical to plain
 *  AudioBufferSourceNode playback.
 *
 *  Self-contained, no dependencies — keeps the plugin cleanly MIT-licensed.
 * ====================================================================== */

'use strict';

// --- WSOLA defaults (override via processorOptions) -----------------------
// FRAME: analysis/synthesis window length (~21 ms @ 48 kHz). Larger = better
//   low-frequency stretch, more transient smear.
// SYN_HOP: synthesis hop (output samples advanced per frame). FRAME/SYN_HOP is
//   the overlap factor: SYN_HOP = FRAME/4 means 75% overlap (4 frames summed).
//   Too small a hop (too much overlap) blurs/combs the signal into "fuzz";
//   FRAME/4..FRAME/2 is the clean range. Decoupled from the 128-sample render
//   quantum by an output FIFO.
// SEARCH: +/- waveform-similarity search range, in samples — how far WSOLA
//   may slide each frame to phase-align it with what's already been emitted.
// LCORR: length of the correlation window used to score that alignment.
// synHop = FRAME/2 (50% overlap) is the clean operating point: enough overlap
// for smooth tonal crossfades, little enough that transients (drum hits, note
// attacks) aren't smeared into fuzz by averaging many windowed copies.
const DEFAULTS = { frame: 1024, synHop: 512, search: 360, lcorr: 256 };

function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
}

class StemMixerProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.FRAME = o.frame || DEFAULTS.frame;
        this.SYN_HOP = o.synHop || DEFAULTS.synHop;
        this.SEARCH = o.search || DEFAULTS.search;
        this.LCORR = Math.min(o.lcorr || DEFAULTS.lcorr, this.FRAME - this.SYN_HOP);

        this.loaded = false;
        this.disposed = false;
        this.playing = false;
        this.endedPosted = false;

        // ── Track storage ──
        // Each track is { channels: [Float32Array], nch, length } where
        // channels[ch][idx - base] holds the sample at ABSOLUTE source index
        // `idx`, valid for base <= idx < writeFrontier. In 'load' (retain-all)
        // mode base stays 0, writeFrontier == total and the channel arrays span
        // the whole song. In streaming mode the arrays are fixed capacity `cap`
        // and slide: base advances (old samples dropped) as playback consumes.
        this.stems = [];
        this.base = 0;             // absolute source index of channels[..][0]
        this.writeFrontier = 0;    // absolute index one past the newest sample
        this.cap = 0;              // per-channel capacity (streaming)
        this.streaming = false;    // true when fed via open/append
        // Retain a little behind the read frontier so WSOLA's backward search
        // (grainNominal - SEARCH) and the pass-through never fall off the start
        // of the window after a drop.
        this.BEHIND = this.SEARCH + this.FRAME;

        this.gains = null;      // Float32Array, TARGET gain per track (0 == muted)
        this.curGains = null;   // currently-applied gain, ramped toward `gains`
                                // over ~12 ms so a unity<->stems crossover (or any
                                // mute/unmute mid-playback) doesn't click or jump.
        this.total = 0;         // longest track length, in source samples
        this.rate = 1;          // tempo factor; pos advances `rate` input samples / output sample
        this.pos = 0;           // analysis read frontier, in fractional source samples
        this.inPrev = null;     // input start of the previously emitted grain (WSOLA)

        this.HANN = hann(this.FRAME);

        // WSOLA accumulators (weighted overlap-add): summed windowed signal
        // per channel + summed window weights for normalisation.
        this.accL = new Float32Array(this.FRAME);
        this.accR = new Float32Array(this.FRAME);
        this.wacc = new Float32Array(this.FRAME);
        // Per-hop mix scratch covering [floor(pos)-SEARCH, +FRAME+SEARCH).
        this.scratchLen = this.FRAME + 2 * this.SEARCH;
        this.scratchL = new Float32Array(this.scratchLen);
        this.scratchR = new Float32Array(this.scratchLen);
        this.corrTarget = new Float32Array(this.LCORR);

        // Output FIFO (staging): each synth hop appends SYN_HOP finalised
        // samples; process() drains 128 per quantum. Sized for the worst-case
        // (< 128 leftover) + one hop.
        this.stageCap = this.FRAME + this.SYN_HOP + 256;
        this.stageL = new Float32Array(this.stageCap);
        this.stageR = new Float32Array(this.stageCap);
        this.fill = 0; // valid samples in the FIFO

        // Structural output latency reported to the main thread: the Hann
        // centroid (FRAME/2) plus the average FIFO backlog (~SYN_HOP/2).
        this.latencyOutSamples = (this.FRAME / 2) + (this.SYN_HOP / 2);

        // Backpressure: while streaming, report the read frontier to the main
        // thread ~every 20 ms (or immediately on under-run) so it can top the
        // window up ahead of `pos`.
        this._posInterval = Math.max(1, Math.round(0.02 * sampleRate));
        this._posAccum = 0;

        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        if (!msg) return;
        switch (msg.type) {
            case 'load': {
                // Full-decode path (desktop). Channel arrays arrive as
                // transferables (ownership moved here) and are RETAINED for the
                // whole song: base=0, writeFrontier=total, no dropping.
                this.streaming = false;
                this.stems = (msg.stems || []).map((s) => {
                    // Guard against a malformed stem with no channels.
                    const channels = (s && Array.isArray(s.channels)) ? s.channels : [];
                    const chLen = channels[0] ? channels[0].length : 0;
                    // Never let declared length exceed the actual channel data,
                    // or _mix() would read past the array (=> NaN).
                    return {
                        channels,
                        nch: channels.length,
                        length: Math.min((s && s.length) | 0, chLen),
                    };
                });
                this._initGains(msg.gains);
                this.total = this.stems.reduce((m, s) => Math.max(m, s.length), 0);
                this.base = 0;
                this.writeFrontier = this.total;
                this.loaded = true;
                this.port.postMessage({ type: 'ready', latencyOutSamples: this.latencyOutSamples });
                break;
            }
            case 'open': {
                // Streaming path (iOS). Allocate empty bounded windows; the main
                // thread pumps PCM via 'append'. `cap` bounds per-channel memory;
                // `startSample` is the absolute source sample the first append
                // will begin at (0, or a seek/resume target).
                this.streaming = true;
                const tracks = (msg.tracks || []);
                // Default cap ~3 s if the main thread doesn't specify one; must
                // comfortably exceed the behind margin + one pump chunk + the
                // ahead target the main thread keeps buffered.
                const defCap = Math.max(this.FRAME * 8, Math.ceil(3 * sampleRate));
                this.cap = Math.max(this.FRAME * 4, (msg.cap | 0) || defCap);
                this.stems = tracks.map((t) => {
                    const nch = Math.max(1, (t && t.nch) | 0);
                    const channels = [];
                    for (let ch = 0; ch < nch; ch++) channels.push(new Float32Array(this.cap));
                    return { channels, nch, length: (t && t.length) | 0 };
                });
                this._initGains(msg.gains);
                this.total = this.stems.reduce((m, s) => Math.max(m, s.length), 0);
                const start = Math.max(0, Math.round(msg.startSample || 0));
                this.base = start;
                this.writeFrontier = start;
                this.pos = start;
                this._flush();
                this.endedPosted = false;
                this.loaded = true;
                this.port.postMessage({ type: 'ready', latencyOutSamples: this.latencyOutSamples });
                break;
            }
            case 'append': {
                // Aligned PCM for EVERY track at absolute sample `base` (which
                // must equal the current writeFrontier — a stale block from
                // before a seek is dropped). Shorter tracks are zero-padded by
                // the sender so all tracks advance the frontier together.
                if (!this.streaming || this.disposed || !this.loaded) break;
                const frames = msg.frames | 0;
                if (frames <= 0) break;
                const startAbs = (msg.base == null) ? this.writeFrontier : (msg.base | 0);
                if (startAbs !== this.writeFrontier) break; // stale (post-seek) — ignore
                this._compact();
                let local = this.writeFrontier - this.base;
                if (local + frames > this.cap) {
                    // Window would overflow. Backpressure should prevent this;
                    // as a last resort drop the oldest unread samples so we never
                    // write out of bounds.
                    const needBase = this.writeFrontier + frames - this.cap;
                    this._dropTo(needBase);
                    local = this.writeFrontier - this.base;
                    if (local + frames > this.cap) break; // still no room — skip
                }
                const blocks = msg.tracks || [];
                for (let i = 0; i < this.stems.length; i++) {
                    const t = this.stems[i];
                    const blk = blocks[i];
                    const srcChannels = (blk && Array.isArray(blk.channels)) ? blk.channels : null;
                    for (let ch = 0; ch < t.nch; ch++) {
                        const dst = t.channels[ch];
                        const src = srcChannels && srcChannels[ch];
                        if (src && src.length >= frames) {
                            dst.set(src.length === frames ? src : src.subarray(0, frames), local);
                        } else if (src && src.length > 0) {
                            dst.set(src, local);
                            dst.fill(0, local + src.length, local + frames);
                        } else {
                            dst.fill(0, local, local + frames);
                        }
                    }
                }
                this.writeFrontier += frames;
                break;
            }
            case 'start':
                // Round to an integer sample: the rate-1.0 pass-through path
                // indexes with `pos | 0`, so a fractional start would lose
                // sub-sample alignment and break exact pass-through.
                this.pos = Math.max(0, Math.round((msg.offset || 0) * sampleRate));
                this.rate = this._coerceRate(msg.rate);
                this._flush();
                // Snap to the target so gains set before playback (e.g. a
                // default-muted stem, or the initial unity routing) are exact
                // from the first sample — only mid-playback changes ramp.
                if (this.curGains && this.gains) this.curGains.set(this.gains);
                this.endedPosted = false;
                this.playing = true;
                break;
            case 'stop':
                // Freeze the read frontier and go silent; resume re-flushes.
                this.playing = false;
                break;
            case 'seek':
                // Integer sample, same reason as 'start'.
                this.pos = Math.max(0, Math.round((msg.offset || 0) * sampleRate));
                this._flush();
                this.endedPosted = false;
                if (this.streaming) {
                    // Discard the window; the main thread refills from the target.
                    this.base = this.pos;
                    this.writeFrontier = this.pos;
                }
                break;
            case 'rate': {
                const r = this._coerceRate(msg.rate);
                // Crossing the pass-through boundary flips DSP path; flush so a
                // fresh WSOLA run doesn't overlap-add stale pass-through state.
                const wasStretch = Math.abs(this.rate - 1) > 1e-6;
                const isStretch = Math.abs(r - 1) > 1e-6;
                this.rate = r;
                if (wasStretch !== isStretch) {
                    this._flush();
                    // pos accumulates fractionally under WSOLA; snap to an
                    // integer sample so the pass-through path (pos | 0) doesn't
                    // truncate a fraction when rate returns to 1.0.
                    this.pos = Math.round(this.pos);
                }
                break;
            }
            case 'gain':
                if (this.gains && msg.index >= 0 && msg.index < this.gains.length) {
                    const v = Number(msg.value);
                    this.gains[msg.index] = Number.isFinite(v) ? v : 0;
                }
                break;
            case 'dispose':
                this.disposed = true;
                this.stems = [];
                this.gains = null;
                this.curGains = null;
                break;
            default:
                break;
        }
    }

    // Build gains/curGains from a provided array (missing entries default to 1,
    // audible). Applied instantly (no ramp from silence on the first sound);
    // in-playback changes ramp from here.
    _initGains(provided) {
        const arr = Array.isArray(provided) ? provided : [];
        this.gains = new Float32Array(this.stems.length);
        for (let i = 0; i < this.stems.length; i++) {
            const g = Number(arr[i]);
            this.gains[i] = Number.isFinite(g) ? g : 1;
        }
        this.curGains = Float32Array.from(this.gains);
    }

    // Drop every sample below absolute index `newBase`, sliding the retained
    // tail down to channels[..][0]. Streaming only. Clamps to [base, writeFrontier].
    _dropTo(newBase) {
        if (newBase <= this.base) return;
        if (newBase > this.writeFrontier) newBase = this.writeFrontier;
        const shift = newBase - this.base;
        if (shift <= 0) return;
        const count = this.writeFrontier - this.base;
        for (let i = 0; i < this.stems.length; i++) {
            const t = this.stems[i];
            for (let ch = 0; ch < t.nch; ch++) {
                t.channels[ch].copyWithin(0, shift, count);
            }
        }
        this.base = newBase;
    }

    // Drop samples the read frontier has passed (keeping BEHIND for WSOLA's
    // backward reach), bounding the window. Streaming only.
    _compact() {
        if (!this.streaming) return;
        const dropTo = Math.floor(this.pos) - this.BEHIND;
        if (dropTo > this.base) this._dropTo(dropTo);
    }

    _maybePostPos(n, urgent) {
        this._posAccum += n;
        if (urgent || this._posAccum >= this._posInterval) {
            this._posAccum = 0;
            try {
                // Floor the read frontier: under WSOLA `pos` is fractional, and the
                // main-thread pump does integer sample math off it (a fractional
                // value would desync jsWriteFrontier and get appends rejected).
                this.port.postMessage({ type: 'pos', pos: Math.floor(this.pos), writeFrontier: this.writeFrontier });
            } catch (_) { /* port closed */ }
        }
    }

    _coerceRate(r) {
        const v = Number(r);
        return (Number.isFinite(v) && v > 0) ? v : 1;
    }

    _flush() {
        this.accL.fill(0);
        this.accR.fill(0);
        this.wacc.fill(0);
        this.fill = 0;
        this.inPrev = null;
    }

    // Mixed sample at integer source index `idx` for channel `ch` (0=L,1=R),
    // applying current per-track gains. Reads outside the resident window
    // [base, writeFrontier) contribute 0 (so under-run / past-end reads are
    // silence). Mono tracks feed both output channels.
    _mix(idx, ch) {
        if (idx < this.base || idx >= this.writeFrontier) return 0;
        const local = idx - this.base;
        let sum = 0;
        const stems = this.stems;
        const gains = this.curGains || this.gains;
        for (let i = 0; i < stems.length; i++) {
            const g = gains[i];
            if (g === 0) continue;
            const s = stems[i];
            if (idx >= s.length) continue;
            const c = s.channels[ch < s.nch ? ch : 0];
            sum += c[local] * g;
        }
        return sum;
    }

    // Step the applied gains toward their targets, ~12 ms to traverse the full
    // 0..1 range, called once per render quantum (output-time). A no-op when
    // every track is already at its target (so steady playback is untouched and
    // the pass-through path stays sample-exact).
    _rampGains(n) {
        const cur = this.curGains, tgt = this.gains;
        if (!cur || !tgt) return;
        const step = n / Math.max(1, 0.012 * sampleRate);
        for (let i = 0; i < cur.length; i++) {
            const d = tgt[i] - cur[i];
            if (d > step) cur[i] += step;
            else if (d < -step) cur[i] -= step;
            else cur[i] = tgt[i];
        }
    }

    // Fill scratch buffers with the mixed signal over the window the next hop
    // needs: scratch[k] == mixed input at index (base + k).
    _fillScratch(base) {
        const L = this.scratchL, R = this.scratchR;
        for (let k = 0; k < this.scratchLen; k++) {
            const idx = base + k;
            L[k] = this._mix(idx, 0);
            R[k] = this._mix(idx, 1);
        }
    }

    // True WSOLA: choose the search offset whose candidate grain best CONTINUES
    // the previous grain in the INPUT domain. The template is the previous
    // grain's overlap region (input[inPrev + SYN_HOP ...]) — the samples that
    // would naturally follow it. Matching against the clean input (not the
    // already-overlap-added output) is what keeps broadband / transient content
    // from smearing into fuzz. `grainNominal` = floor(pos); scratchL is already
    // filled over [grainNominal - SEARCH, ...].
    _searchDelta(grainNominal) {
        const S = this.SEARCH, LCORR = this.LCORR, H = this.SYN_HOP;
        const tmpl = this.corrTarget;
        const tBase = this.inPrev + H;
        let tEnergy = 0;
        for (let j = 0; j < LCORR; j++) {
            const v = this._mix(tBase + j, 0);
            tmpl[j] = v;
            tEnergy += v * v;
        }
        if (tEnergy < 1e-9) return 0; // silence: nothing to align to.

        const L = this.scratchL;
        let bestDelta = 0;
        let bestScore = -Infinity;
        for (let d = -S; d <= S; d++) {
            const off = S + d; // scratch index of candidate sample j=0
            let dot = 0, energy = 0;
            for (let j = 0; j < LCORR; j++) {
                const c = L[off + j];
                dot += tmpl[j] * c;
                energy += c * c;
            }
            const score = dot / Math.sqrt(energy + 1e-9);
            if (score > bestScore || (score === bestScore && Math.abs(d) < Math.abs(bestDelta))) {
                bestScore = score;
                bestDelta = d;
            }
        }
        return bestDelta;
    }

    // Synthesise the next SYN_HOP finalised samples and append them to the FIFO.
    _synthHop() {
        const FRAME = this.FRAME, H = this.SYN_HOP, S = this.SEARCH;
        const grainNominal = Math.floor(this.pos);
        this._fillScratch(grainNominal - S);
        const delta = this.inPrev === null ? 0 : this._searchDelta(grainNominal);
        this.inPrev = grainNominal + delta;
        const frameOff = S + delta; // scratch index of the chosen frame's j=0

        const accL = this.accL, accR = this.accR, wacc = this.wacc, W = this.HANN;
        const L = this.scratchL, R = this.scratchR;
        for (let j = 0; j < FRAME; j++) {
            const w = W[j];
            const si = frameOff + j;
            accL[j] += w * L[si];
            accR[j] += w * R[si];
            wacc[j] += w;
        }

        // Finalise + append the leading H samples (no future frame covers them).
        const stageL = this.stageL, stageR = this.stageR;
        let w = this.fill;
        for (let k = 0; k < H; k++) {
            const wk = wacc[k];
            if (wk > 1e-8) {
                stageL[w] = accL[k] / wk;
                stageR[w] = accR[k] / wk;
            } else {
                stageL[w] = 0;
                stageR[w] = 0;
            }
            w++;
        }
        this.fill = w;

        // Slide the accumulators left by H; zero the freshly exposed tail.
        accL.copyWithin(0, H);
        accR.copyWithin(0, H);
        wacc.copyWithin(0, H);
        accL.fill(0, FRAME - H);
        accR.fill(0, FRAME - H);
        wacc.fill(0, FRAME - H);

        this.pos += H * this.rate;
    }

    // True if the sliding window is filled far enough ahead of the read frontier
    // to cover this quantum's DSP reads. In 'load' mode everything is resident,
    // so this is always satisfied. Under-run only happens while streaming and
    // more data is still coming (writeFrontier < total).
    _bufferedEnough(n) {
        if (!this.streaming) return true;
        if (this.writeFrontier >= this.total) return true; // all data in — read to end
        const r = this.rate;
        const horizon = (Math.abs(r - 1) <= 1e-6)
            ? n
            : (Math.ceil(n * r) + this.FRAME + 2 * this.SEARCH + this.SYN_HOP);
        return this.pos + horizon <= this.writeFrontier;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const outL = out[0];
        const stereo = out.length > 1;
        const outR = stereo ? out[1] : null;
        const n = outL.length; // 128

        if (this.disposed) return false;
        if (!this.loaded || !this.playing) {
            return true; // silent (outputs are zero-filled by the host)
        }

        // Under-run: the window isn't filled ahead of the read frontier yet.
        // Stall to silence and hold `pos` (never read unwritten samples, never
        // signal 'ended'); nudge the main thread to refill.
        if (!this._bufferedEnough(n)) {
            this._maybePostPos(n, true);
            return true;
        }
        if (this.streaming) this._maybePostPos(n, false);

        // Advance any in-flight gain crossfade once per quantum (output-time),
        // before either DSP path reads gains via _mix().
        this._rampGains(n);

        if (Math.abs(this.rate - 1) <= 1e-6) {
            // Pass-through mixer: exact, zero added latency.
            if (this.pos >= this.total) { this._endOnce(); return true; }
            const i0 = this.pos | 0;
            for (let k = 0; k < n; k++) {
                outL[k] = this._mix(i0 + k, 0);
                if (stereo) outR[k] = this._mix(i0 + k, 1);
            }
            this.pos += n; // rate == 1
            // (Window compaction happens at 'append' time, not per-quantum, to
            // keep the audio thread free of per-quantum memmoves.)
            return true;
        }

        // WSOLA: top up the FIFO, then drain one quantum. Synthesise up to one
        // hop PAST the end so the final FRAME-SYN_HOP samples sitting in the
        // overlap accumulators get flushed (grains past `total` read silence,
        // fading the tail) — otherwise the last half-window is truncated and
        // 'ended' fires ~SYN_HOP samples early. While streaming, also stop
        // synthesising once the read frontier reaches the buffered edge, so we
        // never overlap-add unwritten samples during an under-run.
        while (this.fill < n && this.pos < this.total + this.SYN_HOP && this._bufferedEnough(n)) {
            this._synthHop();
        }
        if (this.fill <= 0) {
            if (this.pos >= this.total) this._endOnce();
            return true;
        }
        const avail = Math.min(n, this.fill);
        const stageL = this.stageL, stageR = this.stageR;
        for (let k = 0; k < avail; k++) {
            outL[k] = stageL[k];
            if (stereo) outR[k] = stageR[k];
        }
        // Slide the FIFO down by what we consumed.
        stageL.copyWithin(0, avail, this.fill);
        stageR.copyWithin(0, avail, this.fill);
        this.fill -= avail;
        return true;
    }

    _endOnce() {
        if (!this.endedPosted) {
            this.endedPosted = true;
            this.playing = false;
            this.port.postMessage({ type: 'ended' });
        }
    }
}

registerProcessor('stem-mixer', StemMixerProcessor);
