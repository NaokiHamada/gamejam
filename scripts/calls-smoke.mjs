// Browser regression with the real Room model and a local, deterministic transport.
// Workers/SQLite/WebSocket integration is covered separately by platform.test.js.
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Room} from '../worker/game.js';

const server = createServer(async (req, res) => {
  const files = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml']};
  const file = files[req.url];
  if (!file) {res.writeHead(404).end(); return;}
  res.setHeader('Content-Type', file[1]);
  res.end(await readFile(new URL('../public/' + file[0], import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({headless: true, ...(existsSync(chrome) ? {executablePath: chrome} : {})});
  await mkdir('artifacts', {recursive: true});
  for (const [type, tile, owned] of [['pon', '5z', ['5z', '5z']], ['chi', '3m', ['1m', '2m']], ['kan', '5z', ['5z', '5z', '5z']]]) {
    const room = new Room('ABCDE');
    for (let i = 0; i < 4; i++) room.join(`参加者${i}`).ready = true;
    room.start(room.players[0]);
    const losing = '1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s'.split(' ');
    room.players.forEach(p => {p.hand = [...losing]; p.river = [];});
    room.players[0].river = [tile]; room.players[1].hand.splice(0, owned.length, ...owned);
    // Keep a competing ron alive so the UI must show a pending call first.
    room.programs = [{id: 'test-ron', title: 'テスト用あがり条件', code: JSON.stringify([{on: 'win_check', when: ['==', ['get', 'actor'], 2], do: [['win']]}]), memory: [{}, {}, {}, {}]}];
    room.claim = {from: 0, tile, passed: [], requests: [], deadline: Date.now() / 1000 + 60};
    const pages = [], contexts = [], sockets = new Set(), errors = [];
    const broadcast = () => {for (const {ws, seat} of sockets) ws.send(JSON.stringify({state: room.snapshot(room.players[seat])}));};
    try {
      for (let seat = 1; seat <= 2; seat++) {
        const context = await browser.newContext({viewport: {width: 1440, height: 1100}}); contexts.push(context);
        await context.addInitScript(session => sessionStorage.setItem('ittamon-session', JSON.stringify(session)), {code: room.code, token: room.players[seat].token});
        const page = await context.newPage(); pages.push(page); page.on('pageerror', e => errors.push(e.message));
        await page.route('**/api/**', async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/api/health') return route.fulfill({json: {ai: false, daily_ai_limit: 100, transport: 'websocket'}});
          try {
            if (path === '/api/action') {const data = route.request().postDataJSON(); room.action(data.action, room.players[seat], data); broadcast();}
            await route.fulfill({json: {state: room.snapshot(room.players[seat])}});
          } catch (e) {await route.fulfill({status: 400, json: {error: e.message}});}
        });
        await page.routeWebSocket('**/api/ws/**', ws => {
          const entry = {ws, seat}; sockets.add(entry);
          ws.onMessage(message => {if (message === 'ping') ws.send('pong');});
          ws.onClose(() => sockets.delete(entry));
          ws.send(JSON.stringify({state: room.snapshot(room.players[seat])}));
        });
        await page.goto(base); await page.locator('#game').waitFor({state: 'visible'});
      }
      const caller = pages[0], other = pages[1];
      const name = {pon: 'ポン', chi: 'チー', kan: 'カン'}[type];
      await caller.setViewportSize({width: 390, height: 844});
      await caller.locator('.hand-panel').screenshot({path: `artifacts/call-${type}-options-mobile.png`});
      await caller.setViewportSize({width: 1440, height: 1100});
      await caller.getByRole('button', {name: new RegExp('^' + name + ' ')}).first().click();
      await caller.waitForFunction(() => state.call_pending);
      assert.equal(await caller.locator('#call-options button').count(), 0);
      await other.locator('#pass').click();
      await caller.waitForFunction(() => !state.claim && state.players[1].melds.length === 1);
      assert.equal(await caller.locator('#my-melds .tile').count(), type === 'kan' ? 4 : 3);
      assert.equal(await other.locator('#opponent-left .meld .tile').count(), type === 'kan' ? 4 : 3);
      assert.equal(await caller.locator('#hand button').count(), 11);
      assert.equal(await caller.locator('#tsumo').isVisible(), false);
      await caller.screenshot({path: `artifacts/call-${type}-desktop.png`, fullPage: true});
      await caller.setViewportSize({width: 390, height: 844});
      await caller.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await caller.locator('.hand-panel').screenshot({path: `artifacts/call-${type}-hand-mobile.png`});
      await caller.screenshot({path: `artifacts/call-${type}-mobile.png`, fullPage: true});
      assert.ok(await caller.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow');
      await other.setViewportSize({width: 390, height: 844});
      await other.locator('.table').screenshot({path: `artifacts/call-${type}-opponent-mobile.png`});
      const fits=await other.locator('#opponent-left .meld').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.closest('.opponent').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right;});
      assert.ok(fits, 'opponent meld exceeds its column');
      await caller.reload(); await caller.waitForFunction(() => state?.players[1].melds.length === 1);
      await caller.locator('#hand button').first().click();
      assert.equal(await caller.locator('#discard').isEnabled(), true);
      await caller.locator('#discard').click();
      await caller.waitForFunction(() => !state.can_discard);
      assert.deepEqual(errors, []);
      console.log(`${name}: pending request, pass, melds, discard, reload, desktop and 390px passed`);
    } finally {for (const context of contexts) await context.close();}
  }
} finally {await browser?.close(); await new Promise(resolve => server.close(resolve));}
