// Unit tests for src/util.js — pure, state-free helpers. Real ES-module import;
// no stubs needed (no DOM / localStorage / module state).
import test from 'node:test';
import assert from 'node:assert/strict';

import { clampVolume, coerceBool, hashString, isGuitarStemId } from '../src/util.js';

test('clampVolume clamps to [0,1] and rejects non-finite', () => {
    assert.equal(clampVolume(0.5), 0.5);
    assert.equal(clampVolume(-1), 0);
    assert.equal(clampVolume(2), 1);
    assert.equal(clampVolume('0.25'), 0.25);   // numeric strings coerce
    assert.equal(clampVolume('nope'), null);
    assert.equal(clampVolume(NaN), null);
    assert.equal(clampVolume(undefined), null);
});

test('coerceBool maps falsy sentinels to false, else Boolean', () => {
    for (const f of ['false', '0', '', null, undefined]) assert.equal(coerceBool(f), false, `${f}`);
    for (const t of ['true', '1', 1, true, 'anything']) assert.equal(coerceBool(t), true, `${t}`);
});

test('hashString is stable, base36, and non-empty', () => {
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
    assert.match(hashString('song.sloppak'), /^[0-9a-z]+$/);
    assert.equal(hashString(null), hashString(''));   // null → ''
});

test('isGuitarStemId matches guitar parts only', () => {
    for (const id of ['guitar', 'Guitars', 'rhythm', 'lead', 'dist', 'distortion', 'rhythm_gtr'])
        assert.equal(isGuitarStemId(id), true, id);
    for (const id of ['bass', 'drums', 'vocals', 'other', '', null])
        assert.equal(isGuitarStemId(id), false, String(id));
});
