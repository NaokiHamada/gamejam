import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync} from 'node:fs';
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({headless: true, ...(existsSync(chrome) ? {executablePath: chrome} : {})});
const errors = [];
mkdirSync('artifacts', {recursive: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#name').fill('ひとり雀士');
  await page.locator('#create').click(); await page.locator('#lobby').waitFor({state: 'visible'});
  for (let i = 1; i <= 3; i++) {
    await page.locator('#add-npc').click();
    await page.waitForFunction(n => state.players.length === n && !busy, i + 1);
  }
  assert.equal(await page.locator('#add-npc').isDisabled(), true);
  await page.locator('[data-remove-npc]').first().click();
  await page.waitForFunction(() => state.players.length === 3 && !busy);
  await page.locator('#add-npc').click();
  await page.waitForFunction(() => state.players.length === 4 && !busy);
  await page.screenshot({path: 'artifacts/npc-lobby-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'artifacts/npc-lobby-mobile.png', fullPage: true});
  await page.locator('#ready').click();
  await page.waitForFunction(() => state.players[0].ready && !busy);
  await page.locator('#start').click();
  await page.locator('#game').waitFor({state: 'visible'});
  await page.waitForFunction(() => !busy);
  // Play only the human's turns. The server must take every NPC turn itself.
  let discards = 0;
  while (true) {
    const view = await page.evaluate(() => state);
    if (view.status === 'finished' || discards >= 4) break;
    await page.waitForFunction(() => state.can_discard || state.status === 'finished', null, {timeout: 25000});
    if (await page.evaluate(() => state.status === 'finished')) break;
    await page.locator('#hand button').last().click(); await page.locator('#discard').click();
    await page.waitForFunction(() => !busy); discards++;
    await page.waitForFunction(() => state.can_discard || state.status === 'finished', null, {timeout: 25000});
  }
  const view = await page.evaluate(() => state);
  assert.ok(view.players.some(p => p.npc && p.river.length > 0) || view.result?.winner > 0);
  assert.equal(view.ai_calls, 0);
  await page.reload(); await page.locator('#game').waitFor({state: 'visible'});
  assert.equal(await page.evaluate(() => state.players.filter(p => p.npc).length), 3);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'artifacts/npc-game-mobile.png', fullPage: true});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, humanPlayers: 1, npcs: 3, humanDiscards: discards,
    npcDiscards: view.players.filter(p => p.npc).map(p => p.river.length), reload: true, mobile: true, aiCalls: view.ai_calls, errors}));
} finally { await browser.close(); }
