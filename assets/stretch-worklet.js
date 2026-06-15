/* ======================================================================
 *  Stems Toggle — pitch-preserving time-stretch worklet
 *
 *  A single AudioWorkletProcessor that OWNS every stem's decoded PCM and
 *  acts as the source node for the stems graph. It mixes all stems (with
 *  live per-stem gains) into one signal and time-stretches that single mix
 *  with WSOLA (Waveform-Similarity Overlap-Add), so changing playback speed
 *  changes tempo WITHOUT changing pitch — matching what PSARC playback gets
 *  for free from HTMLMediaElement.preservesPitch.
 *
 *  Why a worklet-as-source instead of a mid-graph effect: a mid-graph
 *  AudioWorklet receives a fixed 128 input samples per render quantum and
 *  must emit 128, so it cannot change tempo (tempo != 1 needs input:output
 *  != 1) without starving or growing an unbounded buffer. Owning the PCM
 *  lets the processor pull input at its own rate.
 *
 *  Why mix-then-stretch ONCE (not per stem): all stems share one uniform
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

        this.stems = [];        // [{ channels: [Float32Array(,Float32Array)], length, nch }]
        this.gains = null;      // Float32Array, one per stem (0 == muted)
        this.total = 0;         // longest stem length, in source samples
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

        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        if (!msg) return;
        switch (msg.type) {
            case 'load': {
                // Channel arrays arrive as transferables (ownership moved here).
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
                // Always one finite gain per stem: a short or non-finite
                // gains array would otherwise leave _mix() reading `undefined`
                // (=> NaN output). Missing entries default to 1 (audible).
                {
                    const provided = Array.isArray(msg.gains) ? msg.gains : [];
                    this.gains = new Float32Array(this.stems.length);
                    for (let i = 0; i < this.stems.length; i++) {
                        const g = Number(provided[i]);
                        this.gains[i] = Number.isFinite(g) ? g : 1;
                    }
                }
                this.total = this.stems.reduce((m, s) => Math.max(m, s.length), 0);
                this.loaded = true;
                this.port.postMessage({ type: 'ready', latencyOutSamples: this.latencyOutSamples });
                break;
            }
            case 'start':
                // Round to an integer sample: the rate-1.0 pass-through path
                // indexes with `pos | 0`, so a fractional start would lose
                // sub-sample alignment and break exact pass-through.
                this.pos = Math.max(0, Math.round((msg.offset || 0) * sampleRate));
                this.rate = this._coerceRate(msg.rate);
                this._flush();
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
                break;
            default:
                break;
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
    // applying current per-stem gains. Out-of-range reads contribute 0. Mono
    // stems feed both output channels.
    _mix(idx, ch) {
        let sum = 0;
        const stems = this.stems;
        const gains = this.gains;
        for (let i = 0; i < stems.length; i++) {
            const g = gains[i];
            if (g === 0) continue;
            const s = stems[i];
            if (idx < 0 || idx >= s.length) continue;
            const c = s.channels[ch < s.nch ? ch : 0];
            sum += c[idx] * g;
        }
        return sum;
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

        if (Math.abs(this.rate - 1) <= 1e-6) {
            // Pass-through mixer: exact, zero added latency.
            if (this.pos >= this.total) { this._endOnce(); return true; }
            const i0 = this.pos | 0;
            for (let k = 0; k < n; k++) {
                outL[k] = this._mix(i0 + k, 0);
                if (stereo) outR[k] = this._mix(i0 + k, 1);
            }
            this.pos += n; // rate == 1
            return true;
        }

        // WSOLA: top up the FIFO, then drain one quantum. Synthesise up to one
        // hop PAST the end so the final FRAME-SYN_HOP samples sitting in the
        // overlap accumulators get flushed (grains past `total` read silence,
        // fading the tail) — otherwise the last half-window is truncated and
        // 'ended' fires ~SYN_HOP samples early.
        while (this.fill < n && this.pos < this.total + this.SYN_HOP) this._synthHop();
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
