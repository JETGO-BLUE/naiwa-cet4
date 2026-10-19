'use strict';

// 可选的真实 DOM/布局检查：浏览器运行生产 popup，扩展 API 仍为隔离 Mock。
// 不安装依赖；使用现有 Playwright，可通过环境变量指定其模块与浏览器路径。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { background } = require('./test-merge-regressions');

async function main() {
  const bg = background({ learningMode: 'quiz', captureStatus_7: { videoId: 'qaVideo', status: 'saved', cueCount: 3 } });
  await bg.send({ type: 'CAPTIONS_DELTA', videoId: 'qaVideo', title: '本地合并修复验证',
    identityConfirmed: true, cues: [{ text: 'animal development abandon', start: 2.2 }] });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cet4-popup-qa-'));
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 580 }, offline: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => void dialog.accept());
    await page.exposeFunction('__backgroundMessage', (message) => bg.send(message));
    await page.exposeFunction('__readStorage', (keys) => bg.chrome.storage.local.get(keys));
    await page.exposeFunction('__writeStorage', (values) => bg.chrome.storage.local.set(values));
    bg.changes.push((event) => { void page.evaluate((value) => window.__notifyStorage && window.__notifyStorage(value), event).catch(() => {}); });
    await page.addInitScript(() => {
      const listeners = [];
      window.__notifyStorage = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
      window.chrome = {
        runtime: { lastError: null, getURL: (file) => file,
          sendMessage(message, callback) { window.__backgroundMessage(message).then(callback); } },
        storage: { local: { get: (keys) => window.__readStorage(keys), set: (values) => window.__writeStorage(values) },
          onChanged: { addListener(fn) { listeners.push(fn); } } },
        tabs: {
          query(options, callback) { const result = [{ id: 7 }]; if (callback) callback(result); return Promise.resolve(result); },
          sendMessage(tabId, message, callback) { callback(message.type === 'GET_STATE'
            ? { ok: true, state: { videoId: 'qaVideo', identityConfirmed: true, debug: {} } }
            : { ok: message.videoId === 'qaVideo' }); }, create() {},
        },
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'popup.html')).href);
    await page.waitForSelector('.deck-card .opt');
    assert.equal(await page.locator('.deck-card').count(), 3);
    const answer = async (word) => {
      const quiz = (await bg.send({ type: 'GET_QUIZ_BATCH', words: [word] })).quizzes[word];
      await page.locator('.deck-card[data-word="' + word + '"] .opt').nth(quiz.answer).click();
      await page.waitForFunction((w) => document.querySelector('.deck-card[data-word="' + w + '"]').classList.contains('solved'), word);
    };
    await answer('animal');
    await page.locator('#searchInput').fill('development');
    await page.waitForFunction(() => document.querySelectorAll('.deck-card').length === 1);
    await answer('development');
    await page.locator('#searchInput').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.deck-card').length === 3);
    assert.equal(await page.locator('.deck-card.solved').count(), 2);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.deck-card.solved').length === 2);
    const anchor = await page.locator('.deck-now').textContent();
    await bg.send({ type: 'CAPTIONS_DELTA', videoId: 'qaVideo', cues: [{ text: 'planning', start: 201 }] });
    await page.waitForFunction(() => document.querySelectorAll('.deck-card').length === 4);
    assert.equal(await page.locator('.deck-now').textContent(), anchor);
    await page.screenshot({ path: path.join(output, 'quiz.png') });
    await page.locator('#dictChip').click();
    await page.locator('#learningModeSelect').selectOption('normal');
    await page.waitForSelector('.normal-meaning');
    assert.equal(await page.locator('.opt').count(), 0);
    await page.locator('h1').click();
    const height = await page.locator('header').evaluate((element) => element.getBoundingClientRect().height);
    await bg.chrome.storage.local.set({ captureStatus_7: { videoId: 'qaVideo', status: 'error', detail: '长错误原因'.repeat(100) } });
    assert.equal(await page.locator('header').evaluate((element) => element.getBoundingClientRect().height), height);
    await page.screenshot({ path: path.join(output, 'normal.png') });
    await page.locator('#dictFile').setInputFiles({ name: 'custom.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ animal: '自定义释义' })) });
    await page.waitForFunction(() => document.getElementById('dictChip').textContent.includes('custom'));
    await page.waitForFunction(() => document.querySelectorAll('.deck-card').length === 1);
    assert((await page.locator('.vocabulary-tags').first().textContent()).includes('custom'));
    assert((await page.locator('.normal-meaning').textContent()).includes('自定义释义'));
    await page.screenshot({ path: path.join(output, 'custom.png') });
    assert.deepEqual(errors, []);
    const geometry = await page.locator('.deck-next').evaluate((element) => {
      const rect = element.getBoundingClientRect(); return { bottom: rect.bottom, right: rect.right };
    });
    assert(geometry.bottom <= 580 && geometry.right <= 420, 'navigation must stay in the popup');
    console.log('Browser DOM checks passed: answer persistence, search, live update, normal/quiz mode, custom import, fixed header and visible navigation.');
    console.log('Screenshots: ' + output);
    console.log('This uses Mock extension APIs; real video/extension acceptance remains separate.');
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
