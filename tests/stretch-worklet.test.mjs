// Headless DSP test for assets/stretch-worklet.js. Stubs the
// AudioWorkletGlobalScope so the StemMixerProcessor can run under plain Node,
// then verifies: exact pass-through at rate 1.0, pitch preservation at 0.5x
// and 1.5x (the whole point of the worklet), per-stem muting, and end-of-song
// signalling. Run with:  node tests/stretch-worklet.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = path.join(__dirname, '..', 'assets', 'stretch-worklet.js');

// --- Stub the AudioWorkletGlobalScope ---
let REGISTERED = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
    constructor() {
        this.port = {
            onmessage: null,
            _sink: null,
            postMessage(m) { if (this._sink) this._sink(m); },
        };
    }
};
globalThis.registerProcessor = (name, cls) => { REGISTERED = cls; };

const src = fs.readFileSync(WORKLET_PATH, 'utf8');
eval(src.replace(/^'use strict';/m, '')); // class + registerProcessor call

const SR = 48000;
function makeSine(freq, secs, amp = 0.5) {
    const n = Math.floor(secs * SR);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    return a;
}

// Transfer a message into the processor.
function send(p, msg) { p.port.onmessage({ data: msg }); }

// Pull `nQuanta` render quanta of stereo output and concatenate channel 0.
function pull(p, nQuanta) {
    const outL = new Float32Array(nQuanta * 128);
    for (let q = 0; q < nQuanta; q++) {
        const ch0 = new Float32Array(128);
        const ch1 = new Float32Array(128);
        p.process([], [[ch0, ch1]]);
        outL.set(ch0, q * 128);
    }
    return outL;
}

// Estimate dominant frequency by counting zero crossings (rising) in steady state.
function estFreq(buf, startFrac = 0.3, endFrac = 0.9) {
    const s = Math.floor(buf.length * startFrac);
    const e = Math.floor(buf.length * endFrac);
    let crossings = 0;
    for (let i = s + 1; i < e; i++) {
        if (buf[i - 1] <= 0 && buf[i] > 0) crossings++;
    }
    const secs = (e - s) / SR;
    return crossings / secs;
}

function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
}

let failures = 0;
function check(name, cond, detail) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!cond) failures++;
}

const FREQ = 220; // A3
const sine = makeSine(FREQ, 4.0);

// === Test 1: rate 1.0 passthrough is exact ===
{
    const p = new REGISTERED();
    send(p, { type: 'load', stems: [{ channels: [sine.slice()], length: sine.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 1.0 });
    const out = pull(p, 200); // ~0.53s
    // Compare against input from sample 0.
    let maxErr = 0;
    for (let i = 0; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - sine[i]));
    check('rate 1.0 is exact passthrough', maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
}

// === Test 2: rate 0.5 preserves pitch ===
{
    const p = new REGISTERED();
    send(p, { type: 'load', stems: [{ channels: [sine.slice()], length: sine.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 0.5 });
    const out = pull(p, 1200); // ~3.2s of output (consumes ~1.6s of source at 0.5x)
    const f = estFreq(out);
    const r = rms(out);
    check('rate 0.5 output is audible', r > 0.05, `rms=${r.toFixed(3)}`);
    check('rate 0.5 preserves pitch', Math.abs(f - FREQ) < FREQ * 0.06, `est=${f.toFixed(1)}Hz target=${FREQ}Hz`);
}

// === Test 3: rate 1.5 preserves pitch ===
{
    const p = new REGISTERED();
    send(p, { type: 'load', stems: [{ channels: [sine.slice()], length: sine.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 1.5 });
    const out = pull(p, 600); // ~1.6s output (consumes ~2.4s source)
    const f = estFreq(out);
    check('rate 1.5 preserves pitch', Math.abs(f - FREQ) < FREQ * 0.06, `est=${f.toFixed(1)}Hz target=${FREQ}Hz`);
}

// === Test 4: a naive resample (what playbackRate does) would FAIL the pitch check ===
// Sanity that our zero-crossing estimator can tell pitch shift apart:
{
    const shifted = makeSine(FREQ * 0.5, 1.0); // an octave down, like 0.5x resample
    const f = estFreq(shifted);
    check('estimator detects a real pitch shift', Math.abs(f - FREQ * 0.5) < FREQ * 0.06, `est=${f.toFixed(1)}Hz`);
}

// === Test 5: muting a stem (gain 0) silences it ===
{
    const p = new REGISTERED();
    const other = makeSine(440, 4.0);
    send(p, { type: 'load', stems: [
        { channels: [sine.slice()], length: sine.length },
        { channels: [other.slice()], length: other.length },
    ], gains: [1, 1] });
    send(p, { type: 'gain', index: 1, value: 0 });
    send(p, { type: 'start', offset: 0, rate: 1.0 });
    const out = pull(p, 200);
    // With stem 1 muted, output should equal stem 0 only.
    let maxErr = 0;
    for (let i = 0; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - sine[i]));
    check('gain 0 mutes a stem', maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
}

// === Test 5b: a gain change DURING playback ramps (no click / hard switch) ===
// (this is the unity<->stems crossover smoothing — feedBack-plugin-stems#15).
{
    const p = new REGISTERED();
    const dc = new Float32Array(SR).fill(0.5); // constant 0.5 → output == 0.5 * gain
    send(p, { type: 'load', stems: [{ channels: [dc.slice()], length: dc.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 1.0 });
    pull(p, 4);                                  // full gain (output ~0.5)
    send(p, { type: 'gain', index: 0, value: 0 }); // mute mid-playback
    const out = pull(p, 16);                      // 2048 samples spanning the ramp
    const early = Math.abs(out[64]);              // still partly audible (ramping)
    const late = Math.abs(out[out.length - 1]);   // fully muted by the end
    const gradual = [...out].some(v => Math.abs(v) > 0.05 && Math.abs(v) < 0.45);
    check('in-playback gain change ramps (no hard switch)',
        early > 0.1 && gradual && late < 1e-6,
        `early=${early.toFixed(3)} gradual=${gradual} late=${late.toExponential(1)}`);
}

// === Test 6: 'ended' fires once past the end ===
{
    const short = makeSine(FREQ, 0.05); // 2400 samples
    const p = new REGISTERED();
    let ended = 0;
    p.port._sink = (m) => { if (m.type === 'ended') ended++; };
    send(p, { type: 'load', stems: [{ channels: [short.slice()], length: short.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 1.0 });
    pull(p, 60); // 7680 samples, well past 2400
    check("'ended' fires once at end of song", ended === 1, `ended=${ended}`);
}

// === Test 7: a mid-stream rate change stays finite + audible (no NaN, no
//             dropout) and still preserves pitch after crossing the
//             pass-through boundary (1.0 -> 0.7). ===
{
    const p = new REGISTERED();
    send(p, { type: 'load', stems: [{ channels: [sine.slice()], length: sine.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 1.0 });
    pull(p, 100);                       // play a bit at 1.0 (pass-through)
    send(p, { type: 'rate', rate: 0.7 }); // cross into WSOLA
    const out = pull(p, 1000);          // ~2.7s output after the change

    let finite = true, maxAbs = 0;
    for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i])) { finite = false; break; }
        maxAbs = Math.max(maxAbs, Math.abs(out[i]));
    }
    check('rate change produces only finite samples', finite);
    check('rate change keeps output audible', rms(out) > 0.05, `rms=${rms(out).toFixed(3)}`);
    const f = estFreq(out);
    check('pitch preserved after a 1.0->0.7 change', Math.abs(f - FREQ) < FREQ * 0.06, `est=${f.toFixed(1)}Hz`);
}

// === Test 8: transients survive the stretch (not smeared into fuzz). A click
//             train stretched to 0.5x should keep most of its peak amplitude;
//             too much overlap would average it down toward ~0.4. ===
{
    const p = new REGISTERED();
    const n = Math.floor(6 * SR);
    const clicks = new Float32Array(n);
    const period = Math.floor(0.5 * SR);
    for (let i = 0; i < n; i += period) { clicks[i] = 0.9; if (i + 1 < n) clicks[i + 1] = -0.6; }
    send(p, { type: 'load', stems: [{ channels: [clicks.slice()], length: clicks.length }], gains: [1] });
    send(p, { type: 'start', offset: 0, rate: 0.5 });
    const out = pull(p, 1400);
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    check('transients stay sharp at 0.5x (not smeared)', peak > 0.8, `peak=${peak.toFixed(3)} (want >0.8)`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
