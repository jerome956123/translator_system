// Compatibility command: build from complete source, never minified class names.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', 'realtime-text');
for (const args of [
    ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
    ['node_modules/vite/bin/vite.js', 'build'],
    ['scripts/package-static.mjs'],
]) execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
