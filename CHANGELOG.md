# Changelog

All notable changes to the Stems Toggle plugin are documented here.

## [Unreleased]

### Changed

- **ES-module migration, step 4b — the reassigned scalars → `S` object in
  `src/state.js` (R1 pilot).** The ~28 reassigned module scalars (the audio graph
  `audioCtx`/`masterGain`/`analyserNode`, `stemState`, the worklet + decode flags,
  the current-song fields) move into a single exported `S` object — because ES
  imports are read-only bindings, `export let x` can't be reassigned from
  `main.js`, but `S.x = …` can. Every `main.js` reference becomes `S.x`
  (~230 sites). The AudioContext is exported as `S.audioCtx` and the four
  capability-command functions' local `ctx` param was renamed to `cmdCtx` first,
  so the rewrite was collision-free (verified: 0 bare references, 0 double-prefix,
  no property-key/shorthand hazards). Move-only, no behaviour change. Verified:
  node 31/31, pytest 10/10, `import-x/no-cycle` clean on the 6-module graph, and
  the graph boots + executes in-browser against core-with-R0. **Not yet
  exercised: real playback** (needs a seeded stems song) — on-device smoke
  recommended before release.
- **ES-module migration, step 4a — extract the state containers to `src/state.js`
  (R1 pilot).** The data-structure state that is never reassigned — the
  `transport` object (playhead/rate/duration clock) and the
  `registeredMixParticipantIds` / `pointerCleanupHandlers` / `claimSnapshots`
  Set/Map containers — moves to `src/state.js` as `export const`. Because these
  are only
  *mutated* (never reassigned), `main.js` imports them with **zero reference
  changes** at the ~90 call sites. The reassigned scalars (`ctx`, `stemState`,
  `masterGain`, `workletNode`, …) stay in `main.js` for the follow-up accessor
  refactor. Move-only, zero behaviour change; 31/31 node + 10/10 pytest,
  5-module graph boots against core-with-R0.
- **ES-module migration, step 3 — extract the persistence layer to `src/prefs.js`
  (R1 pilot).** The localStorage helpers (`loadDefaultMuted`/`saveDefaultMuted`,
  `loadMuted`/`saveMuted`, `loadVolumes`/`saveVolume`, `karaokeDefault` + a new
  `setKaraokeDefault` wrapping the one inline write) and their storage keys leave
  `src/main.js` for `src/prefs.js`; the karaoke-toggle wiring now calls the
  helpers instead of `localStorage` directly. New `tests/prefs.test.mjs` covers
  it with a **real import** against an in-memory storage stub (round-trips +
  corrupt-value degradation), validating prefs.js is import-pure. Move-only, zero
  behaviour change; 29/29 node + 10/10 pytest, 4-module graph boots against
  core-with-R0.
- **ES-module migration, step 2 — first pure-module extractions (R1 pilot).**
  The pure helpers move out of `src/main.js` into their own modules:
  `computeMixGains` → `src/mix-gains.js`, and `parseWavHeader` /
  `pcm16ToFloat32` → `src/wav-pcm.js` (`main.js` imports them at module top).
  Their tests (`mix-routing`, `wav-pcm`) drop the marker-comment /`eval` source
  extraction for **real ES-module imports** — the first retirement of the
  `@pure`-style harness. Move-only, zero behaviour change; 24/24 node + 10/10
  pytest, and the 3-module graph boots in-browser against core-with-R0.
- **ES-module migration, step 1 — the bootstrap flip (R1 pilot).** `screen.js`
  is now a one-line `import './src/main.js'` and the plugin declares
  `"scriptType": "module"` (+ `"minHost": "0.3.0-alpha.1"`); the host injects it
  as `<script type="module">` (needs core with the R0 module rails). The plugin
  body moved verbatim to `src/main.js` (history preserved via `git mv`); the only
  logic change is asset resolution — the worklet URL now uses
  `new URL('../assets/stretch-worklet.js', import.meta.url)` instead of
  `document.currentScript` (which is `null` in a module). Behaviour unchanged;
  verified booting in-browser against core-with-R0 (module executes,
  `window.stems` installs, worklet resolves to the plugin-root `assets/`). The
  regex-extraction tests now read `src/main.js` (real-import conversion follows in
  later steps). No `src/` split yet — that's the next steps.

## [0.8.1] — Stem buttons wrap inside the v3 plugin-controls popover

### Fixed

- **Stem buttons no longer overflow the v3 "Plugin controls" rail popover.**
  The mixer bar (`#stems-mixer`) is a horizontal flex row built for v2's wide
  `#player-controls` bar. In v3 the host re-homes it into the narrow rail
  popover (`.v3-rail-pop`, `max-width: 340px`), where the six stem buttons
  (`min-width: 46px` each) exceeded the bubble's inner width and spilled past
  its right edge — the popover's own `flex-wrap` can't help because the whole
  mixer is a single child of the slot. The bar now sets `flex-wrap: wrap` on
  itself so the buttons wrap onto additional lines inside the popover. Inert in
  v2 (nothing to wrap in the wide bar); applied as an inline style since this
  plugin ships no compiled stylesheet and can't rely on `flex-wrap` being in
  core's scanned Tailwind CSS.

## [0.8.0] — Bounded-memory streaming (fixes the iOS 6-stem crash)

### Fixed

- **6-stem sloppaks no longer crash iOS/iPadOS.** Previously every stem was
  decoded to a full-length Float32 `AudioBuffer` up front (~500–650 MB for a
  6-stem, 4-minute song), which jettisoned the WKWebView content process the
  moment decode reached 6/6 — the app "crashed"/reloaded to the library.
  Playback memory is now **bounded to a few-second window per track,
  independent of song length and stem count** (~8 MB vs ~645 MB), at full
  quality (no downsampling / lossy re-encode).

### Changed

- **Streaming playback path.** The iOS client proxy already transcodes each OGG
  stem to RIFF/WAV (16-bit PCM) and streams it. The plugin now reads that PCM
  incrementally off `fetch().body` and feeds the time-stretch worklet's bounded
  ring buffer, dropping consumed PCM as playback advances. Because raw PCM is
  sliceable at any sample, **no decoder / WebCodecs / demuxer is needed**, and
  there is no iOS-version floor beyond `AudioWorklet` + fetch streams. The
  worklet's WSOLA pitch-preserving speed, sample-locked mix, per-stem
  gain/mute, unity full-mix routing, analyser hand-off, karaoke and
  default-muted behaviour are all unchanged.

  - **Feature-detected, content-driven.** Streaming engages only when a stem is
    served as `audio/wav`; desktop/Electron (served `audio/ogg`, a container
    that can't be sliced) keeps the existing full-decode path byte-for-byte.
  - **Sample-accurate seek.** A seek flushes the window and refetches every
    stem from the target so the stems stay phase-aligned. The plugin sends an
    HTTP `Range` request and uses a `206` response for O(1) seeks when the proxy
    supports it, falling back to re-streaming from the start (still exact, just
    slower over LAN) when it does not.
  - **Sample-rate pinning.** The `AudioContext` is run at the stems' native rate
    (the OS resamples to the device) so the streamed PCM feeds the worklet
    sample-exact with no in-JS resample.
  - **Backpressure + under-run safety.** The worklet reports its read frontier so
    the pump keeps ~2 s buffered ahead; if the network can't keep up the worklet
    stalls to silence (never reads unwritten PCM, never signals a false end) and
    resumes cleanly once fed. During such a stall the note highway (clocked off
    the `AudioContext`) can drift briefly ahead of the audio until the buffer
    refills — expected over a slow link, negligible on a LAN.

## [0.7.1] — iOS stem playback fix

### Fixed

- **Stem mixer now works on iOS (iPhone/iPad).** The `#audio` takeover shims for
  `play` / `pause` were installed with a direct `core.play = fn` assignment, which
  iOS WebKit rejects with "Attempted to assign to readonly property" (those methods
  are non-writable there, and the plugin runs as a strict-mode ES module). The
  throw left the critical-shim gate `shimsUsable` false, so `onSongReady()` aborted
  the sloppak takeover and handed playback back to the native `<audio>` element —
  which plays only `stems[0]`. On-device this looked like "only one stem plays and
  the mixer sliders do nothing." `play`/`pause` are now installed with
  `Object.defineProperty` (an own property on the instance), matching the
  currentTime/paused/duration shims and working on both WebKit and Chromium.
  Desktop/Electron was unaffected. Discovered while running the plugin through the
  native iOS client (`feedback-client-app`).

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

  Robustness: the full mix is only used when its length matches the stems within
  tolerance (and its posted length is clamped to the stems), so a mismatched /
  mis-encoded `original_audio` can't play past the song end or drop to silence
  mid-song — it's ignored and the separated stems play. The unity↔stems
  crossover (and any mid-playback mute/unmute) now **ramps gains over ~12 ms in
  the worklet** instead of hard-switching, so swapping the entire mix at the
  unity boundary doesn't click or jump in level (`tests/stretch-worklet.test.mjs`
  gains a ramp test; the exact pass-through and instant pre-start gains are
  unchanged).

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
