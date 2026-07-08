// Unit tests for the pure streaming helpers in src/main.js — parseWavHeader and
// pcm16ToFloat32 — extracted from their marker comments and eval'd (same
// source-eval approach as mix-routing.test.mjs). These touch no DOM/closure
// state, so they run under plain `node --test`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

function extract(name) {
    const re = new RegExp('(function ' + name + '[\\s\\S]*?)\\n\\s*// --- end ' + name + ' ---');
    const m = source.match(re);
    assert.ok(m, `${name} block (between markers) not found in src/main.js`);
    return eval('(' + m[1] + ')');
}
const parseWavHeader = extract('parseWavHeader');
const pcm16ToFloat32 = extract('pcm16ToFloat32');

// Build a canonical 44-byte RIFF/WAV header (+ optional trailing bytes).
function wavHeader(nch, sampleRate, dataSize, extraTrailing = 0) {
    const u8 = new Uint8Array(44 + extraTrailing);
    const dv = new DataView(u8.buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);          // PCM
    dv.setUint16(22, nch, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * nch * 2, true);
    dv.setUint16(32, nch * 2, true);    // block align
    dv.setUint16(34, 16, true);         // bits per sample
    ascii(36, 'data'); dv.setUint32(40, dataSize, true);
    return u8;
}

test('parseWavHeader reads a canonical 16-bit stereo header', () => {
    const h = parseWavHeader(wavHeader(2, 44100, 1000));
    assert.ok(h);
    assert.equal(h.nch, 2);
    assert.equal(h.sampleRate, 44100);
    assert.equal(h.bitsPerSample, 16);
    assert.equal(h.dataOffset, 44);
    assert.equal(h.dataSize, 1000);
});

test('parseWavHeader handles mono at 48 kHz', () => {
    const h = parseWavHeader(wavHeader(1, 48000, 512));
    assert.equal(h.nch, 1);
    assert.equal(h.sampleRate, 48000);
    assert.equal(h.dataOffset, 44);
});

test('parseWavHeader rejects non-RIFF and truncated input', () => {
    assert.equal(parseWavHeader(new Uint8Array(10)), null);
    const bad = wavHeader(2, 44100, 1000); bad[0] = 0;   // corrupt "RIFF"
    assert.equal(parseWavHeader(bad), null);
});

test('parseWavHeader rejects non-16-bit PCM', () => {
    const h = wavHeader(2, 44100, 1000);
    new DataView(h.buffer).setUint16(34, 24, true);      // 24-bit
    assert.equal(parseWavHeader(h), null);
});

test('parseWavHeader rejects non-PCM audio formats', () => {
    const h = wavHeader(2, 44100, 1000);
    new DataView(h.buffer).setUint16(20, 2, true);       // audioFormat 2 (ADPCM), still 16-bit
    assert.equal(parseWavHeader(h), null);
});

test('parseWavHeader walks past an extra chunk before data', () => {
    // Insert a 4-byte "LIST" chunk between fmt and data.
    const nch = 2, sr = 44100, dataSize = 800, listBody = 4;
    const u8 = new Uint8Array(36 + (8 + listBody) + 8);
    const dv = new DataView(u8.buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
    ascii(0, 'RIFF'); dv.setUint32(4, u8.length - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * 2, true);
    dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
    let off = 36;
    ascii(off, 'LIST'); dv.setUint32(off + 4, listBody, true); off += 8 + listBody;
    ascii(off, 'data'); dv.setUint32(off + 4, dataSize, true);
    const h = parseWavHeader(u8);
    assert.ok(h, 'parses with an interposed chunk');
    assert.equal(h.dataOffset, off + 8);
    assert.equal(h.dataSize, dataSize);
});

test('pcm16ToFloat32 de-interleaves stereo and scales to [-1,1)', () => {
    // Frames: L,R = (0,32767), (-32768,16384)
    const u8 = new Uint8Array(8);
    const dv = new DataView(u8.buffer);
    dv.setInt16(0, 0, true); dv.setInt16(2, 32767, true);
    dv.setInt16(4, -32768, true); dv.setInt16(6, 16384, true);
    const [L, R] = pcm16ToFloat32(u8, 0, 2, 2);
    assert.ok(Math.abs(L[0] - 0) < 1e-9);
    assert.ok(Math.abs(R[0] - 32767 / 32768) < 1e-6);
    assert.ok(Math.abs(L[1] - (-1)) < 1e-9);
    assert.ok(Math.abs(R[1] - 0.5) < 1e-6);
});

test('pcm16ToFloat32 zero-pads reads past the buffer end', () => {
    const u8 = new Uint8Array(4);           // only 1 stereo frame of data
    const dv = new DataView(u8.buffer);
    dv.setInt16(0, 1000, true); dv.setInt16(2, -1000, true);
    const [L, R] = pcm16ToFloat32(u8, 0, 3, 2);   // ask for 3 frames
    assert.ok(Math.abs(L[0] - 1000 / 32768) < 1e-6);
    assert.equal(L[1], 0); assert.equal(R[1], 0);   // padded
    assert.equal(L[2], 0); assert.equal(R[2], 0);
});

test('pcm16ToFloat32 honours a byte offset', () => {
    const u8 = new Uint8Array(8);
    const dv = new DataView(u8.buffer);
    dv.setInt16(4, 16384, true);            // second frame (mono) at byte 4
    const [M] = pcm16ToFloat32(u8, 4, 1, 1);
    assert.ok(Math.abs(M[0] - 0.5) < 1e-6);
});
