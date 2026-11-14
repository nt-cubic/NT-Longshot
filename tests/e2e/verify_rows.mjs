// 程序化校验回流测试输出（v2）：只认「L≈90% 且色相=i*37°」的行背景像素段
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const file = process.argv[2] ?? 'e.png';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = http.createServer((req, res) => {
  const p = path.join(OUT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'image/png' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8323, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-first-run'],
  defaultViewport: { width: 1100, height: 700 },
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:8323/${file}`);
const report = await page.evaluate(() => new Promise((res) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const W = c.width, H = c.height;
    const col = c.getContext('2d').getImageData(W - 3, 0, 1, H).data;

    const rgb2hsl = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      if (mx === mn) return [0, 0, l];
      const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      let h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [(h * 60 + 360) % 360, s, l];
    };
    // 行 i 的背景 hsl(i*37, 65%, 90%)
    const rowHues = [];
    for (let i = 0; i < 30; i++) rowHues.push((i * 37) % 360);
    const classify = (r, g, b) => {
      const [h, s, l] = rgb2hsl(r, g, b);
      if (Math.abs(l - 0.9) > 0.025 || s < 0.3 || s > 0.8) return -1; // 非行背景
      let bi = -1, bd = 1e9;
      rowHues.forEach((e, i) => {
        const d = Math.min(Math.abs(h - e), 360 - Math.abs(h - e));
        if (d < bd) { bd = d; bi = i; }
      });
      return bd <= 8 ? bi : -1;
    };
    // 逐像素分类 → 连续段
    const runs = []; // {row, start, end, px}
    let cur = -1, start = 0;
    for (let y = 0; y <= H; y++) {
      const row = y < H ? classify(col[y * 4], col[y * 4 + 1], col[y * 4 + 2]) : -1;
      if (row !== cur) {
        if (cur >= 0 && y - start >= 12) runs.push({ row: cur, start, end: y - 1, px: y - start });
        else if (cur >= 0) runs.push({ row: cur, start, end: y - 1, px: y - start, short: true });
        cur = row; start = y;
      }
    }
    const solid = runs.filter((r) => !r.short);
    // 合并"同一行"的相邻检出（媒体行的上下 padding 各露出一截同色背景属正常页面结构）
    const merged = [];
    for (const r of solid) {
      const last = merged[merged.length - 1];
      if (last && last.row === r.row && r.start - last.end < 1200) {
        last.end = r.end;
      } else {
        merged.push({ ...r });
      }
    }
    const seq = merged.map((r) => r.row);
    const issues = [];
    const counts = {};
    seq.forEach((row, idx) => {
      counts[row] = (counts[row] ?? 0) + 1;
      if (idx > 0 && row < seq[idx - 1]) issues.push(`❌ 行序倒退 ${seq[idx - 1]} → ${row}（段${idx} y=${merged[idx].start}）`);
    });
    for (let i = 0; i < 30; i++) {
      if ((counts[i] ?? 0) === 0) issues.push(`⚠️ 行 ${i} 未检出（可能整行被跳过/裁剪）`);
      if ((counts[i] ?? 0) > 1) issues.push(`❌ 行 ${i} 出现 ${counts[i]} 次`);
    }
    res({ W, H, seq, issues, counts });
  };
  img.src = location.href;
}));
console.log(JSON.stringify(report, null, 1));
await browser.close();
server.close();
