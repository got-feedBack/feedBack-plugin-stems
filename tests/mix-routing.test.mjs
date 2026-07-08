// Unit test for the pure `computeMixGains` decision (src/mix-gains.js) — the
// routing that plays the pristine full mix when every stem is at unity and
// switches to the separated stems the moment one is muted/attenuated
// (feedBack#580 / core #583). Real ES-module import — the marker/eval source
// extraction is retired now that the function lives in its own module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMixGains } from '../src/mix-gains.js';

const S = (on, vol) => ({ on, vol });

test('no full mix → fullGain null, stems pass through (on?vol:0)', () => {
    const r = computeMixGains([S(true, 1), S(false, 1), S(true, 0.5)], false);
    assert.equal(r.unity, false);
    assert.equal(r.fullGain, null);
    assert.deepEqual(r.stemGains, [1, 0, 0.5]);
});

test('full mix + every stem on at unity → play full alone, stems silent', () => {
    const r = computeMixGains([S(true, 1), S(true, 1), S(true, 1)], true);
    assert.equal(r.unity, true);
    assert.equal(r.fullGain, 1);
    assert.deepEqual(r.stemGains, [0, 0, 0]);
});

test('full mix + one stem muted → not unity, stems mix, full silent', () => {
    const r = computeMixGains([S(true, 1), S(false, 1), S(true, 1)], true);
    assert.equal(r.unity, false);
    assert.equal(r.fullGain, 0);
    assert.deepEqual(r.stemGains, [1, 0, 1]);
});

test('full mix + one stem attenuated → not unity (leaves unity on any move)', () => {
    const r = computeMixGains([S(true, 1), S(true, 0.5)], true);
    assert.equal(r.unity, false);
    assert.equal(r.fullGain, 0);
    assert.deepEqual(r.stemGains, [1, 0.5]);
});

test('default volume (null) counts as 100% for unity', () => {
    const r = computeMixGains([S(true, null), S(true, null)], true);
    assert.equal(r.unity, true);
    assert.equal(r.fullGain, 1);
    assert.deepEqual(r.stemGains, [0, 0]);
});

test('full mix flag but no stems → not unity (nothing to be at unity)', () => {
    const r = computeMixGains([], true);
    assert.equal(r.unity, false);
    assert.equal(r.fullGain, 0);
    assert.deepEqual(r.stemGains, []);
});
