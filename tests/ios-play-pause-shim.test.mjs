// Regression test for the iOS WebKit #audio play/pause shim install.
//
// iOS WebKit exposes HTMLMediaElement.play / .pause as NON-writable properties,
// so a plain `core.play = fn` assignment throws "Attempted to assign to readonly
// property" in this plugin's strict-mode (ES module) execution context. That
// left playOk/pauseOk false, so onSongReady() refused the sloppak takeover and
// the browser played only stems[0] — the reported "only one stem, mixer sliders
// do nothing" on iPhone/iPad. Chromium/Electron silently allow the assignment,
// which is why it only bit on iOS. installAudioShims() must install play/pause
// with Object.defineProperty (an OWN property on the instance), which works even
// when the inherited method is non-writable.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('play/pause shims use defineProperty, not the assignment that throws on iOS', () => {
    // Strip full-line comments first: the surrounding comment in screen.js
    // literally reads "`core.play = fn` assignment" to explain the fix, and a
    // naive assignment-pattern match would trip on that prose instead of code.
    const codeOnly = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
        !/\bcore\.play\s*=(?!=)/.test(codeOnly),
        'core.play must not be installed via assignment of any kind (throws on iOS WebKit)'
    );
    assert.ok(
        !/\bcore\.pause\s*=(?!=)/.test(codeOnly),
        'core.pause must not be installed via assignment of any kind (throws on iOS WebKit)'
    );
    assert.match(src, /Object\.defineProperty\(core,\s*["']play["']/, 'core.play must use Object.defineProperty');
    assert.match(src, /Object\.defineProperty\(core,\s*["']pause["']/, 'core.pause must use Object.defineProperty');
});

test('defineProperty overrides a non-writable method where assignment throws (iOS WebKit model)', () => {
    // Model an iOS-style media element: play/pause are non-writable + configurable,
    // exactly the shape that makes `el.play = fn` throw but defineProperty succeed.
    const makeIOSElement = () => {
        const el = {};
        for (const name of ['play', 'pause']) {
            Object.defineProperty(el, name, {
                configurable: true,
                writable: false,
                value: () => `native ${name}`,
            });
        }
        return el;
    };

    // The OLD pattern throws (this file is a module, so already strict mode).
    const a = makeIOSElement();
    assert.throws(() => { a.play = () => 'shim'; }, /read.?only|assign/i);

    // The NEW pattern succeeds and the override actually takes effect.
    const b = makeIOSElement();
    assert.doesNotThrow(() => {
        Object.defineProperty(b, 'play', { configurable: true, writable: true, value: () => 'shim play' });
        Object.defineProperty(b, 'pause', { configurable: true, writable: true, value: () => 'shim pause' });
    });
    assert.equal(b.play(), 'shim play');
    assert.equal(b.pause(), 'shim pause');
});
