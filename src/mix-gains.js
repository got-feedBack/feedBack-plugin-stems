// Pure gain-routing decision for the stems mixer: play the pristine full mix
// when every stem is on at unity, else mix the separated stems (full silent).
// feedBack#580 / core #583. No DOM/state — real-import tested in
// tests/mix-routing.test.mjs.
export function computeMixGains(stems, hasFull) {
    const unity = !!hasFull && stems.length > 0
        && stems.every((s) => s.on && Math.abs((s.vol == null ? 1 : s.vol) - 1) < 1e-3);
    const stemGains = stems.map((s) => (unity ? 0 : (s.on ? (s.vol == null ? 1 : s.vol) : 0)));
    return { unity, stemGains, fullGain: hasFull ? (unity ? 1 : 0) : null };
}
