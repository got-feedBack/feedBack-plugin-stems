import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _manifest() -> dict:
    return json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))


def test_manifest_declares_stems_owner_provider_with_new_event_fields():
    manifest = _manifest()

    assert "capability-pipelines.v1" in manifest["standards"]
    assert "plugin-runtime-idempotent.v1" in manifest["standards"]
    stems = manifest["capabilities"]["stems"]
    assert stems["roles"] == ["owner", "provider"]
    assert stems["kind"] == "command"
    assert stems["commands"] == ["mute", "restore", "setVolume", "list", "inspect", "mute-guitar", "unmute-guitar"]
    assert stems["emits"] == ["stems.ready", "stems.manual-unmute"]
    assert stems["observes"] == ["claim:released"]
    assert "events" not in stems
    assert stems["compatibility"] == "legacy-window-shim"
    assert stems["ownership"] == "exclusive-owner"
    assert stems["safety"] == "safe"
    assert stems["version"] == 1


def test_manifest_declares_playback_observer_for_lifecycle_migration():
    manifest = _manifest()

    playback = manifest["capabilities"]["playback"]
    assert playback["roles"] == ["observer"]
    assert playback["kind"] == "lifecycle"
    assert playback["observes"] == ["loading", "ready", "stopped", "ended"]
    assert playback["compatibility"] == "shim-allowed"
    assert playback["ownership"] == "observer-only"
    assert playback["safety"] == "safe"
    assert playback["version"] == 1


def test_screen_no_longer_wraps_window_play_song():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "window.playSong =" not in src
    assert "basePlaySong" not in src


def test_manifest_declares_audio_mix_fader_provider():
    manifest = _manifest()

    audio_mix = manifest["capabilities"]["audio-mix"]
    assert audio_mix["roles"] == ["provider"]
    assert audio_mix["operations"] == ["fader.get-value", "fader.set-value"]
    assert audio_mix["events"] == ["fader-value-changed", "fader-unavailable"]
    assert audio_mix["compatibility"] == "none"
    assert audio_mix["ownership"] == "multi-provider"
    assert audio_mix["safety"] == "safe"
    assert audio_mix["version"] == 1
    assert "domains" not in manifest


def test_screen_uses_008_audio_session_contracts():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "registerStemOwner" in src
    assert "recordStemManualOverride" in src
    assert "registerMixParticipant" in src
    assert "unregisterMixParticipant" in src


def test_screen_uses_buffer_transport_shims_via_property_handlers():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    # play/pause are installed with Object.defineProperty rather than a plain
    # `core.play = fn` assignment: iOS WebKit exposes HTMLMediaElement.play /
    # .pause as non-writable, so a direct assignment throws in strict mode.
    assert "Object.defineProperty(core, 'currentTime'" in src
    assert "Object.defineProperty(core, 'play'" in src
    assert "Object.defineProperty(core, 'pause'" in src
    assert "core.addEventListener('ratechange'" in src
    assert "core.onplay =" not in src
    assert "core.onpause =" not in src
    assert "core.onseeking =" not in src
    assert "core.onratechange =" not in src


def test_screen_reports_empty_mute_targets_as_unhandled():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "outcome: 'no-owner'" in src
    assert "outcome: 'no-target'" in src
    assert "No matching stem target is available" in src


def test_screen_redacts_song_identity_from_capability_payloads():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "currentSongKey" in src
    assert "redactedSongRef" in src
    assert "songKey" in src
    assert "filename: currentFilename" not in src
    assert "filename, activeClaims" not in src


def test_screen_reports_missing_set_volume_target():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "const committed = stemsApi.setVolume" in src
    assert "if (committed === undefined)" in src
    assert "Stem ${stem.id} is no longer available" in src
    assert "committedValue: committed" in src


def test_screen_requires_claim_id_for_restore():
    src = (ROOT / "screen.js").read_text(encoding="utf-8")

    assert "Restore requires a claimId" in src
    assert "if (previous.claimId !== claimId) continue" in src
    assert "if (claimId && previous.claimId !== claimId) continue" not in src
