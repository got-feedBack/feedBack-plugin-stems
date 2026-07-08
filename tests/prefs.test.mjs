// Unit tests for src/prefs.js — the localStorage persistence layer. Real
// ES-module import against an in-memory storage stub. prefs.js is import-pure
// (it reads localStorage only inside its functions), so the static import runs
// before the stub is installed with no ill effect.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

import {
    karaokeDefault, setKaraokeDefault,
    loadDefaultMuted, saveDefaultMuted,
    loadMuted, saveMuted, loadVolumes, saveVolume,
} from '../src/prefs.js';

beforeEach(() => store.clear());

test('karaoke default round-trips', () => {
    assert.equal(karaokeDefault(), false);
    setKaraokeDefault(true);
    assert.equal(karaokeDefault(), true);
    setKaraokeDefault(false);
    assert.equal(karaokeDefault(), false);
});

test('default-muted set round-trips', () => {
    assert.deepEqual([...loadDefaultMuted()], []);
    saveDefaultMuted(new Set(['bass', 'drums']));
    assert.deepEqual([...loadDefaultMuted()].sort(), ['bass', 'drums']);
});

test('per-song muted: saveMuted stores the off stems, loadMuted returns them', () => {
    assert.equal(loadMuted('song.sloppak'), null);
    saveMuted('song.sloppak', [{ id: 'vocals', on: false }, { id: 'guitar', on: true }, { id: 'bass', on: false }]);
    assert.deepEqual([...loadMuted('song.sloppak')].sort(), ['bass', 'vocals']);
    assert.equal(loadMuted(''), null);        // no filename → null
    saveMuted('', [{ id: 'x', on: false }]);  // no filename → no-op, no throw
});

test('per-song volumes round-trip and merge across saves', () => {
    assert.deepEqual(loadVolumes('s.sloppak'), {});
    saveVolume('s.sloppak', 'guitar', 0.5);
    saveVolume('s.sloppak', 'bass', 0.8);
    assert.deepEqual(loadVolumes('s.sloppak'), { guitar: 0.5, bass: 0.8 });
});

test('corrupt localStorage values degrade to safe defaults', () => {
    store.set('stemsDefaultMuted', '{not json');
    assert.deepEqual([...loadDefaultMuted()], []);
    store.set('stemsVol:x', 'nope');            // invalid JSON
    assert.deepEqual(loadVolumes('x'), {});
    store.set('stemsMute:x', '"a string not array"');
    assert.equal(loadMuted('x'), null);
});

test('loadVolumes coerces valid-but-non-object JSON to {} (guards saveVolume)', () => {
    for (const bad of ['[]', 'true', '42', '"str"', 'null']) {
        store.set('stemsVol:s', bad);
        assert.deepEqual(loadVolumes('s'), {}, `expected {} for ${bad}`);
    }
});

test('karaokeDefault returns false when localStorage throws (blocked/privacy)', () => {
    const orig = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => { throw new Error('storage blocked'); } };
    try {
        assert.equal(karaokeDefault(), false);
    } finally {
        globalThis.localStorage = orig;
    }
});
