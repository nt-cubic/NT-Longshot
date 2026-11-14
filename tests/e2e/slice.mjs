// 把超长输出 PNG 切成可目检的片段：node slice.mjs a1 0 5000 12000 20000 34000
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MIME = { '.png': 'image/png', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const p = path.join(OUT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8322, '127.0.0.1', r));

const specs = {
  a1: [0, 6000, 12000, 18000, 37700],
  a2: [0, 24000, 47000],
  b: [0, 4000, 9000],
  c: [0, 8000, 16000, 24000, 26800],
  d: [0],
  e: [0, 3000, 5000, 7000, 8500],
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(specs);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-first-run'],
  defaultViewport: { width: 1100, height: 700 },
});
const page = await browser.newPage();

for (const name of names) {
  const file = path.join(OUT, `${name}.png`);
  if (!fs.existsSync(file)) { console.log(`缺少 ${name}.png`); continue; }
  const meta = await page.goto(`http://127.0.0.1:8322/${name}.png`).then(() =>
    page.evaluate(() => new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = location.href;
    })));
  for (const y of specs[name]) {
    const outPath = path.join(OUT, `${name}_y${y}.png`);
    const dataUrl = await page.evaluate(async ({ url, y }) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej; i.src = url;
      });
      const cropH = Math.min(600, img.naturalHeight - y);
      const c = document.createElement('canvas');
      c.width = Math.min(1000, img.naturalWidth); c.height = cropH;
      c.getContext('2d').drawImage(img, 0, y, c.width, cropH, 0, 0, c.width, cropH);
      return new Promise((res) => c.toBlob((b) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b);
      }, 'image/png'));
    }, { url: `http://127.0.0.1:8322/${name}.png`, y });
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${outPath}  (y=${y}/${meta.h})`);
  }
}
await browser.close();
server.close();
