// LongShot E2E：主世界注入内容脚本 + CDP 截图桥接，驱动 fixture 全流程
// （Chrome 137+ headless 不再支持 --load-extension，SW target 不可用，
//   故用 page.screenshot({captureBeyondViewport:false}) 等价模拟 captureVisibleTab）
// 用法：node run.mjs [用例名...]   （无参数 = 全部）
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const CONTENT = path.join(HERE, '..', '..', 'extension', 'content');
const FIXTURES = path.join(HERE, 'fixtures');
const PORT = 8321;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

fs.mkdirSync(OUT_DIR, { recursive: true });
const FILES = ['selector.js', 'capture.js', 'stitch.js', 'hud.js']
  .map((f) => fs.readFileSync(path.join(CONTENT, f), 'utf8'));

// ── 静态服务器 ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(FIXTURES) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const cases = {
  // A1：整页虚拟化无限列表（document 滚动 + 行卸载 + 无限加载 + dpr=1）
  a1: { url: `http://127.0.0.1:${PORT}/virtual-list.html`, dpr: 1, mode: 'drag', rect: [60, 80, 1000, 700] },
  // A2：同 A1 但 dpr=1.25（Windows 缩放场景，验证坐标换算）
  a2: { url: `http://127.0.0.1:${PORT}/virtual-list.html`, dpr: 1.25, mode: 'drag', rect: [60, 80, 1000, 700] },
  // B：sticky 头部/侧栏/固定按钮 + 懒加载图片
  b: { url: `http://127.0.0.1:${PORT}/sticky-lazy.html`, dpr: 1, mode: 'drag', rect: [10, 8, 1260, 700] },
  // C：Discord 式内层滚动（单击选滚动容器，虚拟化 + sticky 日期条 + 无限加载
  //    + absolute"跳转至当前"底栏——真实 Discord 撕裂元凶的完整复现）
  c: { url: `http://127.0.0.1:${PORT}/discord-like.html`, dpr: 1, mode: 'click', at: [800, 400], assertBarGone: true },
  // D：Esc 中途停止保留部分结果
  d: { url: `http://127.0.0.1:${PORT}/virtual-list.html`, dpr: 1, mode: 'drag', rect: [60, 80, 1000, 700], escAfterMs: 2500 },
  // E：回流压力——媒体完全入视后才加载、内容中途长高（Twitter 重复拼接的根因）
  e: { url: `http://127.0.0.1:${PORT}/reflow-list.html`, dpr: 1, mode: 'drag', rect: [60, 80, 1000, 700] },
  // F：视频页——rAF 噪声 canvas 模拟播放器（YouTube/Bilibili 卡死场景），掩码必须生效
  f: { url: `http://127.0.0.1:${PORT}/video-page.html`, dpr: 1, mode: 'drag', rect: [10, 60, 1270, 700], assertLowConf: true },
};

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases);
const results = [];

async function preparePage(browser, cfg) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => page.__errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.__errors.push(`console: ${m.text()}`); });
  page.__errors = [];

  // 桥接：页面内 chrome.runtime.sendMessage → Node 侧视口截图（等价 captureVisibleTab）
  await page.exposeFunction('__nodeCapture', async () => {
    const b64 = await page.screenshot({ encoding: 'base64', captureBeyondViewport: false, optimizeForSpeed: true });
    return `data:image/png;base64,${b64}`;
  });
  await page.evaluateOnNewDocument(() => {
    globalThis.chrome ||= {};
    chrome.runtime ||= {};
    chrome.runtime.sendMessage = async () => ({ error: null, dataUrl: await globalThis.__nodeCapture() });
  });

  await page.goto(cfg.url, { waitUntil: 'load', timeout: 15000 });
  for (const src of FILES) await page.evaluate(src); // 主世界注入内容脚本
  await page.evaluate(() => { LongShot.hud._lastResult = null; LongShot.lastStats = null; LongShot.start(); });
  return page;
}

for (const name of selected) {
  const cfg = cases[name];
  if (!cfg) { console.log(`跳过未知用例 ${name}`); continue; }
  console.log(`\n===== ${name} =====`);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars'],
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: cfg.dpr },
    });
    const page = await preparePage(browser, cfg);

    if (cfg.mode === 'drag') {
      const [x1, y1, x2, y2] = cfg.rect;
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
      await page.mouse.move(x2, y2, { steps: 4 });
      await page.mouse.up();
    } else {
      await page.mouse.click(cfg.at[0], cfg.at[1]);
    }

    if (cfg.escAfterMs) {
      await new Promise((r) => setTimeout(r, cfg.escAfterMs));
      await page.keyboard.press('Escape');
      console.log('已发送 Esc');
    }

    await page.waitForFunction(() =>
      globalThis.LongShot?.hud?._lastResult != null ||
      document.querySelector('.ls-card')?.textContent?.includes('截图失败'),
    { timeout: 180000, polling: 200 });
    const failText = await page.evaluate(() =>
      LongShot.hud._lastResult ? null : document.querySelector('.ls-card')?.textContent);
    if (failText) throw new Error(`页面内截图失败: ${failText}`);
    const info = await page.evaluate(() => ({
      w: LongShot.hud._lastResult.width,
      h: LongShot.hud._lastResult.height,
      stats: LongShot.lastStats,
    }));
    // 自检断言：重复拼接签名（同 y 大帧推进）+ 爬行签名（连续微推进）+ 底栏颜色
    const checks = await page.evaluate(() => {
      const c = LongShot.hud._lastResult;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let barRows = 0; // Discord 跳转条 #00b0f4
      for (let y = 0; y < c.height; y++) {
        let hit = 0, n = 0;
        for (let x = 0; x < c.width; x += 4) {
          const i = (y * c.width + x) * 4;
          n++;
          if (Math.abs(d[i]) < 28 && Math.abs(d[i + 1] - 176) < 28 && Math.abs(d[i + 2] - 244) < 28) hit++;
        }
        if (hit > n * 0.3) barRows++;
      }
      const log = LongShot.lastStats.frameLog ?? [];
      let dup = null, crawl = null, runLen = 0;
      for (let i = 1; i < log.length; i++) {
        if (log[i].y === log[i - 1].y && log[i].app > 50 && !dup) dup = { i, y: log[i].y, app: log[i].app };
      }
      for (const e of log) {
        if (e.app > 0 && e.app < 8) { runLen++; if (runLen >= 3 && !crawl) crawl = e; }
        else runLen = 0;
      }
      return {
        barRows, dup, crawl, log,
        frames: log.length,
        hidden: LongShot.lastStats.hiddenOverlays,
      };
    });
    const logTail = JSON.stringify(checks.log.slice(-6));
    if (checks.dup) throw new Error(`重复拼接: 帧${checks.dup.i} y=${checks.dup.y} app=${checks.dup.app}px | 末帧 ${logTail}`);
    if (checks.crawl) throw new Error(`爬行: y=${checks.crawl.y} app=${checks.crawl.app}px | 末帧 ${logTail}`);
    if (cfg.assertBarGone && checks.barRows > 2) throw new Error(`底栏残留 ${checks.barRows} 行 | 末帧 ${logTail}`);
    if (cfg.assertLowConf && info.stats.lowConfSeams > 0) {
      throw new Error(`低置信接缝 ${info.stats.lowConfSeams} 处（动态掩码应消除视频区影响）`);
    }
    console.log(`自检: 帧数=${checks.frames} 底栏残留行=${checks.barRows} 隐藏悬浮=${checks.hidden} 重复=${checks.dup ? '有' : '无'} 爬行=${checks.crawl ? '有' : '无'}`);
    const dataUrl = await page.evaluate(() => new Promise((res) => {
      LongShot.hud._lastResult.toBlob((b) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(b);
      }, 'image/png');
    }));
    const outFile = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(outFile, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`输出: ${info.w} × ${info.h}px  stats=${JSON.stringify(info.stats)}`);
    console.log(`文件: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
    const errs = page.__errors.filter((e) => !e.includes('favicon'));
    console.log(errs.length ? `页面错误: ${errs.join(' | ').slice(0, 400)}` : '页面无错误');
    results.push({ name, ok: true, ...info, errors: errs });
  } catch (e) {
    console.log(`失败: ${e.message}`);
    results.push({ name, ok: false, error: e.message });
  } finally {
    await browser?.close();
  }
}

server.close();
console.log('\n===== 汇总 =====');
for (const r of results) {
  const errs = r.errors?.length ? `  页面错误: ${r.errors.join(' | ').slice(0, 300)}` : '';
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? ` ${r.w}×${r.h}` : ` ${r.error}`}${errs}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
