# Slopsmith Plugin: Stems Toggle

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that turns multi-stem `.sloppak` songs into a live mixing board. Toggle guitar, bass, drums, vocals, piano, or "other" on the fly during playback, tweak each stem's volume, and the plugin remembers your mix per song.

archive songs are untouched — the plugin only activates when a song's `song_info` payload contains a non-empty `stems[]` array.

## Features

- **Per-stem mute toggles** injected into the player control bar
- **Inline volume controls** — each stem button fills left-to-right to show its saved volume; drag across the button to set the level
- **Per-song memory** — muted stems and volumes are saved to `localStorage` keyed by filename, so each song reopens with your last mix
- **Mute on load** — pick which stems start silenced when a song opens (e.g. always start with vocals off)
- **Karaoke mode** — one-click preset that always mutes vocals by default
- **Sample-locked playback** — every stem plays from a decoded `AudioBuffer` through one shared `AudioContext`, so the stems and the note highway are sample-exact and cannot drift apart
- **Pitch-preserving speed control** — slowing a song down (or speeding it up) changes tempo only, not pitch, just like archive playback
- **Inert on archive** — core audio works normally when there are no stems to mix

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/topkoa/slopsmith-plugin-stems.git stems
docker compose restart
```

## Usage

1. Convert a archive to a `.sloppak` with the [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) plugin (which runs Demucs to split the single mixed track into per-instrument stems), or hand-craft a sloppak directory with multiple stems listed in `manifest.yaml`.
2. Play the song. The stem mixer bar appears in `#player-controls` with one labeled button per stem.
3. Click a stem to toggle it on/off. Drag left or right across the button to adjust its volume continuously.
4. Your mute state and volumes are remembered the next time you open the same song.

## Settings

Open **Settings → Stems Toggle** to configure:

- **Karaoke mode** — start every new song with vocals muted
- **Mute on load** — tick the stems that should default to off (e.g. vocals + piano for a guitar practice preset)

Per-song toggles always override defaults.

## How it works

Playing six stems as six independent `<audio>` elements means six independent
HTMLMediaElement decoder clocks — and they do not stay in step. In practice
the guitar/core stem's element decoded ~7–8% fast, so the note highway (which
clocked off it) ran ahead of the music. The plugin removes HTMLMediaElement
decoder clocks from playback entirely.

When a song with stems loads, the plugin:

1. Fetches every stem and `AudioContext.decodeAudioData()`s each into an
   `AudioBuffer` (a "Decoding stems…" indicator shows while this runs)
2. Plays each stem through an `AudioBufferSourceNode` → per-stem `GainNode` →
   master `GainNode` → `AudioContext.destination`. Every source is `start()`-ed
   at the **same `AudioContext` time**, so the stems are sample-locked forever
3. Derives the playhead from the `AudioContext` clock and shims the core
   `<audio id="audio">` element's `play` / `pause` / `currentTime` / `duration`
   / `paused` to drive this transport, dispatching the matching media events so
   the rest of slopsmith is unaffected
4. Publishes `window.slopsmith.stems.setMasterVolume` so the core "Song" fader
   drives the master `GainNode`, moving every stem together
5. Exposes `window.slopsmith.stems.getAnalyser()` — an `AnalyserNode` on the
   stem mix — for audio-reactive plugins

Transport (play / pause / seek / speed) operates on all stems atomically:
seeking stops and recreates every source node at the new offset so they
restart locked. Toggling a stem is a pure `GainNode.gain.value` change.

archive songs (no stems) and the JUCE desktop path are untouched — the `<audio>`
shims delegate straight to core whenever no sloppak is active.

### Pitch-preserving speed (worklet)

When `AudioWorklet` is available, the per-stem `AudioBufferSourceNode`s are
replaced by a single `stem-mixer` `AudioWorkletProcessor`
(`assets/stretch-worklet.js`) that owns every stem's PCM. It mixes the stems
(applying live per-stem gains) and time-stretches the **single mixed signal**
with WSOLA, so the speed slider changes tempo without changing pitch — and
because there is one mix and one stretcher, the stems stay sample-locked. At
rate 1.0 it is an exact pass-through (no stretch, no added latency); off-unity
it reports its constant algorithmic latency so the highway stays aligned with
what is heard. The module is self-hosted and loaded from the plugin's
`assets/` directory via the core `/api/plugins/{id}/assets/{path}` route.

If `AudioWorklet` is unavailable (e.g. an old WKWebView) the plugin falls back
to the `AudioBufferSourceNode`-per-stem path, where the speed slider couples
pitch to tempo as before; a one-time console warning is logged.

The DSP has a headless test: `node tests/stretch-worklet.test.mjs`.

### Bounded-memory streaming (iOS)

Decoding six full stems to `AudioBuffer`s up front costs ~500 MB and jettisons
the WKWebView content process on iOS. When a stem is served as raw PCM
(`audio/wav` — the iOS client proxy transcodes OGG→WAV and streams it), the
plugin instead **streams the PCM off `fetch().body` into the worklet's bounded
ring buffer**, dropping consumed samples so peak memory is a few-second window
per track regardless of song length or stem count. Raw PCM is sliceable at any
sample, so no decoder/WebCodecs/demuxer is needed. Seeks flush the window and
refetch each stem from the target (using an HTTP `Range`/`206` when the proxy
supports it, else re-streaming from the start); the `AudioContext` is pinned to
the stems' sample rate so no in-JS resample is needed. Desktop (served
`audio/ogg`, which can't be sliced) keeps the full-decode path above.

Streaming is feature-detected by response `Content-Type`. The pure helpers
(`parseWavHeader`, `pcm16ToFloat32`) and the worklet's ring/under-run behaviour
have headless tests (`node --test`).

## Requirements

Requires Slopsmith with `.sloppak` format support and a `song_info` payload that includes a `stems[]` array (available on the `feature/sloppak-format` branch and its merged descendants).

## Other Plugins

- [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) — convert archives into `.sloppak` files in-app, with optional Demucs stem splitting

## License

MIT
