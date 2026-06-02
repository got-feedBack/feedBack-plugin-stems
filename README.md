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

## Capability Provider

Stems declares and registers the `stems` capability as an owner/provider. Other plugins should request stem automation through `window.slopsmith.capabilities` instead of changing Stems internals directly. The supported owner commands are `mute`, `restore`, `setVolume`, `list`, and `inspect`; `mute-guitar` and `unmute-guitar` remain compatibility aliases.

The manifest uses the current capability vocabulary: Stems owns public `commands`, emits `stems.ready` and `stems.manual-unmute`, observes `claim:released` so it can clear claim snapshots, declares `playback` observer intent for song lifecycle rebuild/teardown, and declares `audio-mix` fader-provider intent for per-stem mixer controls. Stem audio remains plugin-owned, while Slopsmith's capability hosts coordinate lifecycle, automation claims, mix controls, and diagnostics.

Automation uses session-only claim snapshots. For example, NAM claims `stems` while AMP is enabled and dispatches `stems.mute` for the guitar target; Stems stores the previous on/volume state, mutes the matching stem, and restores only that claim when NAM releases it. Capability mutes are not written to per-song localStorage.

Manual user actions take precedence. When a player toggles a stem in the Stems UI, Stems records a user override with the capability registry so matching automation is reported as overridden instead of silently re-muting the user's choice.

## Capability Migration Path

Current migration status:

- `stems` owner/provider metadata and runtime registration are active.
- `playback` lifecycle observation is active, so Stems rebuilds and tears down without wrapping `window.playSong`.
- The active stem graph registers with Slopsmith's audio-session coordinator via the core Stems owner API.
- Per-stem volume controls register as native `audio-mix` fader participants.
- Core audio synchronization uses removable event listeners instead of overwriting `core.onplay` / `core.onpause` / `core.onseeking` / `core.onratechange`.
- Legacy `song:*` events and `window.stems` remain compatibility surfaces while downstream plugins migrate.

Remaining 015-aligned migration work:

1. Move the player control strip from direct `#player-controls` injection into the `ui.player-controls` contribution host.
2. Move `settings.html` / settings metadata into the settings contribution path with explicit safety/redaction metadata.
3. Replace the remaining `window.showScreen` wrapper with `ui.navigation` or screen-lifecycle observation.
4. Keep reducing `window.stems` live-handle usage until raw Web Audio handles are compatibility-only internals.
5. Keep diagnostics and inspect payloads bounded and redacted: do not expose raw filenames, URLs, local storage values, DOM nodes, or live audio handles.

The intent is not to move stem playback ownership into core. Stems should continue to own the actual per-stem media elements and Web Audio graph; the migration is about using core hosts for lifecycle, UI placement, automation claims, mix control, and diagnostics.

## Requirements

Requires Slopsmith with `.sloppak` format support and a `song_info` payload that includes a `stems[]` array (available on the `feature/sloppak-format` branch and its merged descendants).

## Other Plugins

- [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) — convert archives into `.sloppak` files in-app, with optional Demucs stem splitting

## License

MIT
