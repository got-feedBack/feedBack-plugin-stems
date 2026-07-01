// Headless test for the streaming (open/append) path of assets/stretch-worklet.js.
// Stubs the AudioWorkletGlobalScope, drives the processor in streaming mode via
// a pump that appends aligned PCM in response to the worklet's backpressure
// ('pos') messages, and verifies:
//   - streaming pass-through reproduces the source exactly (fed incrementally),
//   - the sliding window stays bounded (writeFrontier - base <= cap) and base
//     actually advances (old PCM is dropped),
//   - under-run stalls to SILENCE and holds `pos` (never reads unwritten PCM),
//     then resumes cleanly once fed,
//   - 'seek' flushes the window and playback resumes exactly at the target,
//   - 'ended' fires once the fully-fed source is played out.
// Run with:  node --test tests/stretch-worklet-streaming.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = path.join(__dirname, '..', 'assets', 'stretch-worklet.js');

globalThis.sampleRate = 48000;
let REGISTERED = null;
globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, _sink: null, postMessage(m) { if (this._sink) this._sink(m); } }; }
};
globalThis.registerProcessor = (name, cls) => { REGISTERED = cls; };
const src = fs.readFileSync(WORKLET_PATH, 'utf8');
eval(src.replace(/^'use strict';/m, ''));

const SR = 48000;
function makeSine(freq, n, amp = 0.5) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    return a;
}
function send(p, msg) { p.port.onmessage({ data: msg }); }

// A pump that mirrors the worklet's writeFrontier and appends aligned chunks
// from `sources` (array of per-track mono/stereo Float32 channel arrays) up to
// a target absolute sample, zero-padding tracks past their own end.
function makePump(p, sources, { chunk = 2048 } = {}) {
    const total = Math.max(...sources.map(s => s.channels[0].length));
    const pump = { ended: 0, lastPos: 0, wf: 0 };
    p.port._sink = (m) => {
        if (m.type === 'pos') pump.lastPos = m.pos;
        else if (m.type === 'ended') pump.ended++;
    };
    pump.resetBase = (b) => { pump.wf = b; };
    pump.fillTo = (targetAbs) => {
        const target = Math.min(targetAbs, total);
        while (pump.wf < target) {
            const frames = Math.min(chunk, target - pump.wf);
            const tracks = sources.map((s) => {
                const channels = s.channels.map((srcCh) => {
                    const out = new Float32Array(frames);
                    for (let j = 0; j < frames; j++) {
                        const idx = pump.wf + j;
                        out[j] = idx < srcCh.length ? srcCh[idx] : 0;
                    }
                    return out;
                });
                return { channels };
            });
            send(p, { type: 'append', base: pump.wf, frames, tracks });
            pump.wf += frames;
        }
    };
    pump.total = total;
    return pump;
}

// Pull one stereo quantum; return channel 0.
function quantum(p) {
    const ch0 = new Float32Array(128), ch1 = new Float32Array(128);
    p.process([], [[ch0, ch1]]);
    return ch0;
}

test('streaming pass-through reproduces the source exactly (incremental feed)', () => {
    const N = 40000;
    const sineArr = makeSine(220, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    const AHEAD = 8192, CAP = 16384;
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: CAP, startSample: 0 });
    pump.fillTo(AHEAD);                        // prefill
    send(p, { type: 'start', offset: 0, rate: 1 });

    const nQ = 200;                             // 25600 samples
    const out = new Float32Array(nQ * 128);
    let maxWindow = 0;
    for (let q = 0; q < nQ; q++) {
        out.set(quantum(p), q * 128);
        pump.fillTo(pump.lastPos + AHEAD);      // top up in response to backpressure
        maxWindow = Math.max(maxWindow, p.writeFrontier - p.base);
    }
    let maxErr = 0;
    for (let i = 0; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - sineArr[i]));
    assert.ok(maxErr < 1e-6, `streaming pass-through exact, maxErr=${maxErr.toExponential(2)}`);
    assert.ok(maxWindow <= CAP, `window bounded by cap: max=${maxWindow} cap=${CAP}`);
    assert.ok(p.base > 0, `old PCM was dropped (base advanced): base=${p.base}`);
});

test('under-run stalls to silence and holds pos, then resumes', () => {
    const N = 40000;
    const sineArr = makeSine(330, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    const CAP = 16384;
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: CAP, startSample: 0 });
    pump.fillTo(512);                           // only 512 samples buffered
    send(p, { type: 'start', offset: 0, rate: 1 });

    // Drain past the buffered region WITHOUT topping up.
    quantum(p);                                 // outputs [0,128)
    quantum(p);                                 // outputs [128,256)
    quantum(p);                                 // outputs [256,384)
    quantum(p);                                 // outputs [384,512)
    const posAtEdge = p.pos;
    const starved = quantum(p);                 // now under-run → silence
    assert.equal(p.pos, posAtEdge, 'pos held during under-run (no advance past buffered edge)');
    assert.ok(starved.every(v => v === 0), 'under-run output is pure silence');

    // Feed more and confirm it resumes with real audio at the held position.
    pump.fillTo(8192);
    const resumed = quantum(p);
    assert.ok(resumed.some(v => v !== 0), 'resumes with audio once fed');
    let maxErr = 0;
    for (let k = 0; k < 128; k++) maxErr = Math.max(maxErr, Math.abs(resumed[k] - sineArr[posAtEdge + k]));
    assert.ok(maxErr < 1e-6, `resumes exactly at held pos, maxErr=${maxErr.toExponential(2)}`);
});

test("'seek' flushes the window and resumes exactly at the target", () => {
    const N = 60000;
    const sineArr = makeSine(196, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    const AHEAD = 8192, CAP = 16384;
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: CAP, startSample: 0 });
    pump.fillTo(AHEAD);
    send(p, { type: 'start', offset: 0, rate: 1 });
    for (let q = 0; q < 20; q++) { quantum(p); pump.fillTo(pump.lastPos + AHEAD); }

    const T = 40000;                            // seek target (samples)
    send(p, { type: 'seek', offset: T / SR });
    assert.equal(p.base, T, 'seek reset window base to target');
    assert.equal(p.writeFrontier, T, 'seek flushed the window');
    pump.resetBase(T);                          // main refetches from target
    pump.fillTo(T + AHEAD);

    // First non-silent quantum after the seek should be source[T..T+128].
    let firstAudio = null;
    for (let q = 0; q < 5 && !firstAudio; q++) {
        const qd = quantum(p);
        pump.fillTo(pump.lastPos + AHEAD);
        if (qd.some(v => v !== 0)) firstAudio = qd;
    }
    assert.ok(firstAudio, 'playback produced audio after seek');
    let maxErr = 0;
    for (let k = 0; k < 128; k++) maxErr = Math.max(maxErr, Math.abs(firstAudio[k] - sineArr[T + k]));
    assert.ok(maxErr < 1e-6, `resumes exactly at seek target, maxErr=${maxErr.toExponential(2)}`);
});

test("'ended' fires once the fully-fed source is played out", () => {
    const N = 6000;
    const sineArr = makeSine(220, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: 16384, startSample: 0 });
    pump.fillTo(N);                             // feed the whole song (writeFrontier == total)
    send(p, { type: 'start', offset: 0, rate: 1 });
    for (let q = 0; q < 80; q++) quantum(p);    // 10240 samples, well past 6000
    assert.equal(pump.ended, 1, 'ended fired exactly once at end of song');
});

test('streaming at rate 0.5 keeps feeding (integer backpressure pos)', () => {
    // Under WSOLA the worklet's read frontier is fractional; it must report a
    // FLOORED integer 'pos' so the pump's sample math stays integer — otherwise
    // jsWriteFrontier drifts fractional and appends get rejected as stale, stalling.
    const N = 60000;
    const sineArr = makeSine(220, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    const AHEAD = 8192, CAP = 20000;
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: CAP, startSample: 0 });
    pump.fillTo(AHEAD);
    send(p, { type: 'start', offset: 0, rate: 0.5 });

    let audible = 0;
    for (let q = 0; q < 400; q++) {
        const qd = quantum(p);
        for (let k = 0; k < qd.length; k++) if (qd[k] !== 0) { audible++; break; }
        assert.ok(Number.isInteger(pump.lastPos), `backpressure pos is an integer (got ${pump.lastPos})`);
        pump.fillTo(pump.lastPos + AHEAD);
    }
    // At 0.5x, 400 output quanta consume ~200 quanta of source; the pump must have
    // kept feeding well past the initial prefill (appends were not all rejected).
    assert.ok(pump.wf > AHEAD * 2, `pump advanced past prefill: wf=${pump.wf}`);
    assert.ok(audible > 350, `output stayed audible across the run: ${audible}/400 quanta`);
});

test('under-run never fires a spurious end while data is still incoming', () => {
    const N = 40000;
    const sineArr = makeSine(220, N);
    const p = new REGISTERED();
    const pump = makePump(p, [{ channels: [sineArr] }], { chunk: 2048 });
    send(p, { type: 'open', tracks: [{ nch: 1, length: N }], gains: [1], cap: 16384, startSample: 0 });
    pump.fillTo(512);
    send(p, { type: 'start', offset: 0, rate: 1 });
    for (let q = 0; q < 20; q++) quantum(p);    // starve for many quanta (no top-up)
    assert.equal(pump.ended, 0, 'no ended during under-run (writeFrontier < total)');
});
