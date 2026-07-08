// Unit test for the pure `computeMixGains` decision in src/main.js — the routing
// that plays the pristine full mix when every stem is at unity and switches to
// the separated stems the moment one is muted/attenuated (feedBack#580 / core
// #583). Extracts the marker-delimited pure function from the source and evals
// it (same source-eval approach as stretch-worklet.test.mjs).
// Run with:  node tests/mix-routing.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// Pull the pure function out of the IIFE (it touches no DOM/closure state).
// Capture from `function computeMixGains` up to the `// --- end computeMixGains`
// marker that immediately follows its closing brace — no indentation assumption,
// so it survives reformatting of the body.
const m = src.match(/(function computeMixGains[\s\S]*?)\n\s*\/\/ --- end computeMixGains ---/);
assert.ok(m, 'computeMixGains block (between markers) not found in src/main.js');
const computeMixGains = eval('(' + m[1] + ')');

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
