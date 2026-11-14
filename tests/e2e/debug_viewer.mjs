import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const EXT = path.join(process.cwd(), '..', '..', 'extension');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = path.join(EXT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(8321, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-first-run', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
// 生成 1081×7621 测试长图：顶部红条 + 渐变 + 底部蓝条
const testDataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1081; c.height = 7621;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#e33'; x.fillRect(0, 0, c.width, 90);           // 顶部红条
  x.fillStyle = '#111'; x.font = '48px sans-serif';
  x.fillText('TOP OF IMAGE 顶部', 30, 60);
  for (let y = 100; y < c.height - 100; y += 4) { x.fillStyle = `rgb(${y/40|0},${(y*2)%255|0},120)`; x.fillRect(0, y, c.width, 2); }
  x.fillStyle = '#33e'; x.fillRect(0, c.height - 90, c.width, 90); // 底部蓝条
  x.fillStyle = '#fff'; x.font = '48px sans-serif';
  x.fillText('BOTTOM OF IMAGE 底部', 30, c.height - 30);
  return c.toDataURL('image/png');
});
// shim chrome.runtime.connect
await page.evaluateOnNewDocument((dataUrl) => {
  window.chrome = { runtime: { connect: () => ({
    onMessage: { addListener: (fn) => setTimeout(() => fn({
      ok: true, dataUrl,
      meta: { width: 1081, height: 7621, frames: 1, note: '', title: '知乎 - 测试', url: 'https://www.zhihu.com/test' },
    }), 120) },
    onDisconnect: { addListener: () => {} },
  }) } };
}, testDataUrl);
await page.goto('http://127.0.0.1:8321/viewer.html#test', { waitUntil: 'load' });
await page.waitForSelector('#stage img', { timeout: 10000 });
await new Promise(r => setTimeout(r, 400));
const m = await page.evaluate(() => {
  const img = document.querySelector('#stage img');
  const stage = document.getElementById('stage');
  const ir = img.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  return {
    imgW: img.clientWidth, imgH: img.clientHeight, natural: [img.naturalWidth, img.naturalHeight],
    stageW: stage.clientWidth, stageH: stage.clientHeight,
    scrollHeight: stage.scrollHeight, scrollTop: stage.scrollTop,
    imgTopOffset: +(ir.top - sr.top).toFixed(1),
    stretchH: img.style.height || '(auto)',
    objectFit: getComputedStyle(img).objectFit,
  };
});
console.log('尺寸/布局:', JSON.stringify(m, null, 1));
// 回到顶部并目检
await page.evaluate(() => { document.getElementById('stage').scrollTop = 0; });
await new Promise(r => setTimeout(r, 200));
await page.screenshot({ path: 'out/viewer_top.png' });
const topVisible = await page.evaluate(() => {
  const img = document.querySelector('#stage img');
  const stage = document.getElementById('stage');
  return +(img.getBoundingClientRect().top - stage.getBoundingClientRect().top).toFixed(1);
});
console.log('置顶后 img 顶边相对 stage 顶边:', topVisible, '(0 = 顶部可见)');
await browser.close(); server.close();
