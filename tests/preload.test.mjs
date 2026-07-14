// Start the load before the highway is drawn.
//
// The graph build hands every stem's decoded PCM to the audio worklet — which
// means copying the WHOLE SONG. For a 4-minute, 6-stem pack that is over half a
// gigabyte of memcpy, in one frame, on the main thread. It used to run on the
// highway's WS `ready`, i.e. with the player already on screen, and it froze the
// picture: measured on a real load, a 698 ms frame right as the song-credits card
// appeared, with the venue video visibly stopping.
//
// Nothing about the work changes — only WHEN. The stem list is now available from
// core at `song:loading` (GET /api/song/{f}?stems=1), so the whole load runs
// behind the loading overlay, before the highway and the venue are drawn, where a
// stalled frame costs nothing.
//
// main.js is the entry module: no exports, and importing it runs the plugin. So
// these are source-shape guards, in the style the repo already uses for it. The
// part that could actually be WRONG — that the REST stem list is byte-identical
// to the one the WS later sends, so the ready path skips a second build rather
// than rebuilding — is pinned behaviourally on the core side
// (tests/test_song_info_stems.py::test_rest_payload_matches_what_the_ws_would_build).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
const STATE = fs.readFileSync(path.join(HERE, '..', 'src', 'state.js'), 'utf8');

function block(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `'${signature}' not found`);
    // Skip the parameter list first (paren-balanced): a default value like
    // `detail = {}` would otherwise be mistaken for the function body.
    let i = src.indexOf('(', start) + 1;
    let parens = 1;
    while (i < src.length && parens > 0) {
        if (src[i] === '(') parens++;
        else if (src[i] === ')') parens--;
        i++;
    }
    const open = src.indexOf('{', i);
    let depth = 1;
    i = open + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('the load starts on song:loading, not on the highway being ready', () => {
    const fn = block(SRC, 'onPlaybackLoading(detail = {})');
    assert.match(fn, /preloadSong\s*\(/,
        'song:loading must kick off the load — waiting for the WS `ready` is what put ' +
        'the whole-song PCM copy on top of a live venue');
    assert.match(fn, /S\.preloadInfo\s*=\s*null/,
        'a new song must not inherit the previous song\'s preloaded stem list');
});

test('preload asks core for the stem list it could previously only get from the WS', () => {
    const fn = block(SRC, 'async function preloadSong(');
    assert.match(fn, /\/api\/song\/'\s*\+\s*encodeURIComponent/,
        'must fetch the song-info route');
    assert.match(fn, /\?stems=1/,
        'the stem list is opt-in so the library hot path pays nothing for it');
    assert.match(fn, /encodeURIComponent\s*\(\s*filename\s*\)/,
        'filenames contain spaces and punctuation — they must be encoded');
});

test('an in-flight preload cannot overtake a newer song', () => {
    const fn = block(SRC, 'async function preloadSong(');
    assert.match(fn, /\+\+\s*S\.preloadGen/, 'each preload must take a generation');
    assert.match(fn, /gen\s*!==\s*S\.preloadGen[\s\S]{0,80}return/,
        'a preload whose song has been superseded must abandon — otherwise it would ' +
        'build the PREVIOUS song\'s graph over the current one');
    assert.match(fn, /filename\s*!==\s*S\.currentFilename[\s\S]{0,40}return/,
        'belt and braces: the filename must still be the one we are loading');
    assert.match(STATE, /preloadGen:\s*0/, 'state must carry the generation counter');
});

test('preloading is best-effort — it can never break the song', () => {
    const fn = block(SRC, 'async function preloadSong(');
    assert.match(fn, /catch\s*\([\s\S]{0,80}return/,
        'an offline core (or one too old to know ?stems=1) must fall through to the ' +
        'old ready-driven path, not fail the load');
    assert.match(fn, /!res\.ok[\s\S]{0,20}return/, 'a non-200 must bail quietly');
    assert.match(fn, /d\.stems\.length\s*===\s*0[\s\S]{0,20}return/,
        'a stem-less pack has nothing to preload');
});

test('the live highway list wins once it arrives; the preload is only a stand-in', () => {
    const fn = block(SRC, 'function currentSongInfo()');
    const liveIdx = fn.search(/highway\.getSongInfo/);
    const preIdx = fn.search(/S\.preloadInfo/);
    assert.ok(liveIdx !== -1 && preIdx !== -1);
    assert.ok(liveIdx < preIdx,
        'the highway is the source of truth — the preload is consulted only before it arrives');
    assert.match(fn, /pre\.filename\s*===\s*S\.currentFilename/,
        'a preload for a DIFFERENT song must never be used');
});

test('the load path reads the shared accessor, not the highway directly', () => {
    // If onSongReady went back to highway.getSongInfo() it would find no stems at
    // song:loading time and the preload would silently do nothing.
    const fn = block(SRC, 'async function onSongReady()');
    assert.match(fn, /currentSongInfo\s*\(\s*\)/,
        'onSongReady must accept a preloaded stem list');
    assert.doesNotMatch(fn, /highway\.getSongInfo/,
        'reading the highway directly here defeats the preload');
    const init = block(SRC, 'function tryInitForCurrentSong()');
    assert.match(init, /currentSongInfo\s*\(\s*\)/);
});
