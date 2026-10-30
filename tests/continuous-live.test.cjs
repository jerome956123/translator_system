// Legacy command delegates to source tests instead of minified class names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('continuous capture, recognizer and diagnostics source tests', () => {
    const root = path.resolve(__dirname, '..', 'realtime-text');
    const result = spawnSync(process.execPath, [
        'node_modules/vitest/vitest.mjs', 'run', 'tests/browser-session.test.ts',
        'tests/browser-stt.test.ts', 'tests/recent-audio.test.ts', 'tests/diagnostics.test.ts',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
