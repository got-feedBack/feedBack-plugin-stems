// Unit tests for src/mix.js — the imperative worklet-posting routing layer.
// Real ES-module import; drives the shared S container with a fake worklet port
// that captures the gain messages the routing posts.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../src/state.js';
import { applyMixRouting, makeStemGainHandle } from '../src/mix.js';

let posted;
function fakeWorklet() {
    posted = [];
    return { port: { postMessage: (m) => posted.push(m) } };
}
const gainsFor = () => posted.filter((m) => m.type === 'gain');

beforeEach(() => {
    posted = [];
    S.useWorklet = true;
    S.workletPostReady = true;
    S.workletNode = fakeWorklet();
    S.fullTrackIndex = -1;
    S.stemState = [{ id: 'a', on: true, vol: 1 }, { id: 'b', on: true, vol: 0.5 }];
});

test('applyMixRouting is a no-op unless worklet is live and ready', () => {
    S.workletPostReady = false;
    applyMixRouting();
    assert.deepEqual(posted, []);
});

test('applyMixRouting posts each stem gain; muted → 0', () => {
    S.stemState[1].on = false;             // b muted
    applyMixRouting();
    assert.deepEqual(gainsFor(), [
        { type: 'gain', index: 0, value: 1 },
        { type: 'gain', index: 1, value: 0 },
    ]);
});

test('applyMixRouting: unity full-mix → stems silent, full at 1', () => {
    S.fullTrackIndex = 2;
    S.stemState = [{ id: 'a', on: true, vol: 1 }, { id: 'b', on: true, vol: 1 }];
    applyMixRouting();
    assert.deepEqual(gainsFor(), [
        { type: 'gain', index: 0, value: 0 },
        { type: 'gain', index: 1, value: 0 },
        { type: 'gain', index: 2, value: 1 },   // the full-mix track
    ]);
});

test('makeStemGainHandle exposes a gain-node surface with no-op connect/disconnect', () => {
    const h = makeStemGainHandle(0);
    assert.equal(typeof h.connect, 'function');
    assert.equal(typeof h.disconnect, 'function');
    assert.doesNotThrow(() => { h.connect(); h.disconnect(); });
    h.gain.value = 'not a number';
    assert.equal(h.gain.value, 0);            // non-finite coerces to 0
});

test('gain handle (no full mix): a direct write posts that one stem gain', () => {
    const h = makeStemGainHandle(1);
    h.gain.value = 0.3;
    assert.deepEqual(gainsFor(), [{ type: 'gain', index: 1, value: 0.3 }]);
    assert.equal(h.gain.value, 0.3);
});

test('gain handle (full mix): a positive write reflects into stemState and re-routes all', () => {
    S.fullTrackIndex = 2;
    S.stemState = [{ id: 'a', on: true, vol: 1 }, { id: 'b', on: true, vol: 1 }];
    const h = makeStemGainHandle(1);
    h.gain.value = 0.4;                        // breaks unity for stem b
    assert.equal(S.stemState[1].vol, 0.4);    // external write reflected
    // routing re-posts every track (no longer unity → stems audible, full silent)
    assert.deepEqual(gainsFor(), [
        { type: 'gain', index: 0, value: 1 },
        { type: 'gain', index: 1, value: 0.4 },
        { type: 'gain', index: 2, value: 0 },
    ]);
});
