const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePage, assertNoConflicts } = require('../scripts/check-page.cjs');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the current uploadable page and microphone code pass validation', () => {
    assert.equal(validatePage(html).worklet, true);
});

test('merge markers are rejected even when hidden inside a valid JavaScript string', () => {
    const conflict = ['<'.repeat(7) + ' Updated upstream', 'old', '='.repeat(7), 'new', '>'.repeat(7) + ' Stashed changes'].join('\n');
    const broken = html.replace('class Pcm16Resampler', conflict + '\nclass Pcm16Resampler');
    assert.throws(() => validatePage(broken), /Git 合併衝突/);
});

test('invalid main script fails before packaging or uploading', () => {
    const broken = html.replace('<script type="module">', '<script type="module">const broken = ;');
    assert.throws(() => validatePage(broken), /程式語法錯誤/);
});

test('invalid embedded microphone code is caught separately from the main script', () => {
    const broken = html.replace('class Pcm16Resampler extends', 'class Pcm16Resampler broken extends');
    assert.throws(() => validatePage(broken), /持續收音程式語法錯誤/);
});

test('ignore rules with leftover branch conflict markers are rejected', () => {
    const rules = '.pnpm-store/\n' + '>'.repeat(7) + ' Stashed changes\n';
    assert.throws(() => assertNoConflicts(rules, '.gitignore'), /\.gitignore:2/);
});
