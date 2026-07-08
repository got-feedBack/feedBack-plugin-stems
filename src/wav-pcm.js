// Pure WAV/PCM helpers for the bounded-memory streaming path. No DOM/state —
// real-import tested in tests/wav-pcm.test.mjs.

// Parse a canonical RIFF/WAVE header. Returns {nch, sampleRate, bitsPerSample,
// dataOffset, dataSize} for linear 16-bit PCM, or null for anything else
// (the streaming path reads raw Int16 and rejects compressed/float variants).
export function parseWavHeader(u8) {
    if (!u8 || u8.length < 44) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let off = 12, fmt = null, dataOffset = -1, dataSize = 0;
    while (off + 8 <= u8.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, true);
        const body = off + 8;
        if (id === 'fmt ' && body + 16 <= u8.length) {
            fmt = {
                audioFormat: dv.getUint16(body, true),
                nch: dv.getUint16(body + 2, true),
                sampleRate: dv.getUint32(body + 4, true),
                bitsPerSample: dv.getUint16(body + 14, true),
            };
        } else if (id === 'data') {
            dataOffset = body;
            dataSize = size;
            break; // PCM starts here
        }
        off = body + size + (size & 1); // chunks are word-aligned
    }
    if (!fmt || dataOffset < 0) return null;
    // Only linear 16-bit PCM (audioFormat 1) — the rest of the streaming path
    // reads raw Int16. Reject compressed/float WAV variants (e.g. ADPCM).
    if (fmt.audioFormat !== 1) return null;
    if (fmt.bitsPerSample !== 16 || fmt.nch < 1 || fmt.sampleRate <= 0) return null;
    return { nch: fmt.nch, sampleRate: fmt.sampleRate, bitsPerSample: 16, dataOffset, dataSize };
}

// De-interleave `frames` of 16-bit little-endian PCM starting at byte
// `byteOffset` in `u8` into one Float32Array(frames) per channel, [-1, 1).
// Reads that run past the buffer are treated as 0 (silence pad).
export function pcm16ToFloat32(u8, byteOffset, frames, nch) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
    const limit = u8.length;
    const chans = [];
    for (let ch = 0; ch < nch; ch++) chans.push(new Float32Array(frames));
    let p = byteOffset;
    for (let f = 0; f < frames; f++) {
        for (let ch = 0; ch < nch; ch++) {
            chans[ch][f] = (p + 2 <= limit) ? dv.getInt16(p, true) / 32768 : 0;
            p += 2;
        }
    }
    return chans;
}
