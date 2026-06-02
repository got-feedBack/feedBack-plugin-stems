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


def test_manifest_does_not_declare_deferred_audio_mix_domain():
    manifest = _manifest()

    assert "audio-mix" not in manifest.get("capabilities", {})
    assert "domains" not in manifest
