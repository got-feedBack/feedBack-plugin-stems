# Changelog

All notable changes to the Stems Toggle plugin are documented here.

## [0.7.0] — Pristine full mix at unity

### Added

- **Plays the pristine full mix when nothing is isolated.** When a sloppak ships
  a pre-separation `original_audio` mixdown (exposed on `song_info` by core
  #583 / feedBack#580), the plugin now loads it as one extra time-stretch track
  and plays **it** — not the lossy demucs recombination — whenever every stem is
  on at 100% ("unity"). The moment any stem is muted or attenuated, it crosses
  to the separated stems; back to unity, back to the pristine mix. This wires up
  the consumer half of #583 (previously the field was published but unused, so
  at-unity playback always used the recombined stems) and is the audible win
  behind the "converted stems sound tinny at rest" reports.

  Worklet path only and fully opt-in: a pack without `original_audio`, or the
  legacy (non-worklet) fallback, behaves exactly as before. Routing is a single
  pure `computeMixGains(stems, hasFull)` (unit-tested in
  `tests/mix-routing.test.mjs`); the full mix rides the same WSOLA graph as the
  stems, so speed/seek/sync are unchanged.

## [0.6.0] — Pitch-preserving speed control

### Added

- **The speed slider now preserves pitch**, matching archive playback. Slowing a
  stemmed sloppak down (or speeding it up) changes tempo only — the pitch
  stays put. This closes the 0.5.0 known limitation.

  A single `AudioWorkletProcessor` (`assets/stretch-worklet.js`, `stem-mixer`)
  now owns every stem's decoded PCM and acts as the source node: it mixes all
  stems with their live per-stem gains and time-stretches the **single mixed
  signal** with WSOLA (waveform-similarity overlap-add). Mixing-then-stretching
  once keeps the stems sample-locked by construction — there is no per-stem
  stretcher to diverge — so the note-highway sync from 0.5.0 is preserved.

  At **rate 1.0 the worklet is an exact pass-through mixer** (no stretch, no
  added latency), so normal-speed playback is bit-identical to the old path.
  Off-unity, WSOLA adds a small constant latency (`FRAME/2 + SYN_HOP/2` output
  samples); the worklet reports the exact value and the transport shifts the
  reported `currentTime` back by it so the highway stays aligned with what is
  heard.

- The worklet module is self-hosted under the plugin's `assets/` directory and
  loaded via the new core `/api/plugins/{id}/assets/{path}` route (no CDN).

### Changed

- In worklet mode, per-stem gain/mute/solo no longer use real `GainNode`s — a
  lightweight handle with the same `.gain.value` / `.connect` / `.disconnect`
  surface forwards changes to the worklet, so the `window.stems` API and all
  existing controls are unchanged.

### Fallback

- If `AudioWorklet` is unavailable (e.g. an old WKWebView) or the module fails
  to load, playback falls back to the 0.5.0 `AudioBufferSourceNode`-per-stem
  path (speed couples pitch) and logs a one-time warning. Sample-lock and all
  other behaviour are unchanged in fallback.

### Migration notes

- Requires a Slopsmith core build that serves plugin assets at
  `/api/plugins/{plugin_id}/assets/{path}`. On older cores the asset 404s and
  the plugin transparently uses the legacy (pitch-coupling) path.

## [0.5.0] — Sample-locked stem playback

### Changed

- **Rearchitected playback to be sample-locked.** Stems no longer play as
  six independent `<audio>` elements on six separate HTMLMediaElement decoder
  clocks. Each stem is now fetched and decoded once into an `AudioBuffer` and
  played through an `AudioBufferSourceNode`. All sources are `start()`-ed at
  the same `AudioContext` time, so the stems — and the note highway that
  clocks off them — are sample-exact and **cannot drift**.

  This fixes the desync where the highway ran ahead of the music on sloppak
  songs: the guitar/core stem's `<audio>` element decoded ~7–8% fast, and the
  highway clocked off it. With one shared `AudioContext` clock that failure
  mode is structurally impossible.

- The core `<audio id="audio">` element is no longer used as an audio source.
  Its `play` / `pause` / `currentTime` / `duration` / `paused` members are
  shimmed to drive the buffer transport, and the transport dispatches the
  matching media events so the rest of slopsmith is unaffected. The shims
  delegate to core whenever no sloppak is active, so **archive songs and the
  JUCE desktop path are completely untouched**.

- The Song fader now drives a single master `GainNode` that sums every stem
  (previously the guitar/core stem was scaled separately).

- A stem mix `AnalyserNode` is exposed at `window.slopsmith.stems.getAnalyser()`
  for audio-reactive plugins, since the core `<audio>` element is now silent.

### Removed

- The `<audio>`-element-per-stem graph, the core-element reuse, the
  `play`/`pause`/`seek`/`ratechange` event fan-out, the 50 ms drift-snap
  correction, and the `createMediaElementSource` core-tap contention with
  other plugins. None of it is needed once playback is sample-locked.

### Known limitations

- The speed slider now changes pitch along with tempo. `AudioBufferSourceNode`
  has no pitch-preserving time-stretch; an HTMLMediaElement preserved pitch by
  default. Playing a song slowed down will sound lower-pitched.

- All stems are decoded to `AudioBuffer` on song load (roughly a few hundred
  MB total for a typical 3–5 minute song). A "Decoding stems…" indicator is
  shown while this completes; buffers are freed on song change.

## [0.4.0]

- Master gain node so the mixer Song fader controls stem volume.

## [0.3.0]

- Quick volume sliders; per-song volume memory; comb-filter fix.
