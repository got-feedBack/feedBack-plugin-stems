// Unit tests for src/streaming.js. The pure-ish exports (streamingSupported,
// isWavResponse, streamOffsetBuffered) plus the seek-token guard on appendRound.
// The rest of the pump/seek internals drive fetch + the worklet, so their end-to-
// end behaviour is covered by the on-device seek-stress smoke.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { S, ST } from '../src/state.js';
import { streamingSupported, isWavResponse, streamOffsetBuffered, appendRound } from '../src/streaming.js';

test('isWavResponse: true only when content-type contains "wav"', () => {
    const mk = (ct) => ({ headers: { get: () => ct } });
    assert.equal(isWavResponse(mk('audio/wav')), true);
    assert.equal(isWavResponse(mk('audio/x-wav')), true);
    assert.equal(isWavResponse(mk('AUDIO/WAV')), true);      // case-insensitive
    assert.equal(isWavResponse(mk('audio/ogg')), false);
    assert.equal(isWavResponse(mk(null)), false);
    assert.equal(isWavResponse(null), false);                // no resp
    assert.equal(isWavResponse({ headers: { get() { throw new Error('x'); } } }), false);
});

test('streamingSupported: true only when all three platform APIs exist', () => {
    const orig = { R: globalThis.ReadableStream, f: globalThis.fetch, A: globalThis.AudioWorkletNode };
    try {
        globalThis.ReadableStream = function () {};
        globalThis.fetch = function () {};
        globalThis.AudioWorkletNode = function () {};
        assert.equal(streamingSupported(), true);
        delete globalThis.ReadableStream;                    // no stream → unsupported
        assert.equal(streamingSupported(), false);
        globalThis.ReadableStream = function () {};
        delete globalThis.fetch;                             // no fetch → unsupported
        assert.equal(streamingSupported(), false);
        globalThis.fetch = function () {};
        delete globalThis.AudioWorkletNode;                  // no worklet → unsupported
        assert.equal(streamingSupported(), false);
    } finally {
        globalThis.ReadableStream = orig.R; globalThis.fetch = orig.f;
        if (orig.A === undefined) delete globalThis.AudioWorkletNode; else globalThis.AudioWorkletNode = orig.A;
    }
});

beforeEach(() => {
    ST.streaming = true;
    ST.streamSampleRate = 48000;
    ST.lastWorkletPos = 48000;   // read frontier at 1.0s
    ST.jsWriteFrontier = 96000;  // written up to 2.0s
});

test('streamOffsetBuffered: true only inside [pos - 0.1s, writeFrontier]', () => {
    // window is [48000 - 4800, 96000] = [43200, 96000] samples
    assert.equal(streamOffsetBuffered(1.0), true);    // 48000 — inside
    assert.equal(streamOffsetBuffered(2.0), true);    // 96000 — at the write frontier
    assert.equal(streamOffsetBuffered(0.9), true);    // 43200 — exactly pos-0.1s
    assert.equal(streamOffsetBuffered(0.0), false);   // before the window (replay-from-0)
    assert.equal(streamOffsetBuffered(0.85), false);  // 40800 — just behind the window
    assert.equal(streamOffsetBuffered(2.1), false);   // 100800 — past the write frontier
});

test('streamOffsetBuffered: always true when not streaming or rate unknown', () => {
    ST.streaming = false;
    assert.equal(streamOffsetBuffered(0.0), true);
    ST.streaming = true; ST.streamSampleRate = 0;
    assert.equal(streamOffsetBuffered(999), true);
});

// ── appendRound seek-token guard (the step-9.1 race fix) ──────────────────────
// A silent track (totalFrames=0 → realWanted<=0) exercises the guards without a
// reader/fetch: appendRound must post only when its captured token still matches
// ST.streamSeekToken, else drop the block (a seek superseded it).
function primeAppendRound() {
    const posted = [];
    S.workletNode = { port: { postMessage: (m) => posted.push(m) } };
    ST.streamTracks = [{ nch: 2, totalFrames: 0 }];   // silent path, no reader needed
    ST.streamTotalSamples = 10000;
    ST.jsWriteFrontier = 0;
    ST.streamSampleRate = 48000;
    ST.lastWorkletPos = 10000;   // aheadTarget high → frames > 0
    ST.pumpStop = false;
    ST.streamSeekToken = 5;
    return posted;
}

test('appendRound posts the block when its token still matches', async () => {
    const posted = primeAppendRound();
    const ok = await appendRound(5);
    assert.equal(ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'append');
    assert.equal(posted[0].base, 0);
    assert.ok(posted[0].frames > 0);                       // a real block was posted
    assert.equal(ST.jsWriteFrontier, posted[0].frames);    // frontier advanced by exactly that
});

test('appendRound drops the block (no post) once a seek supersedes its token', async () => {
    const posted = primeAppendRound();
    const ok = await appendRound(4);            // stale token (current is 5)
    assert.equal(ok, false);
    assert.deepEqual(posted, []);               // nothing posted to the worklet
    assert.equal(ST.jsWriteFrontier, 0);        // frontier NOT advanced
});
