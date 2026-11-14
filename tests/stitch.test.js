// LongShot 拼接算法单测：node test_stitch.js
// stitch.js 顶层只做命名空间定义与纯函数，Node 下可直接 eval
'use strict';
const fs = require('fs');
const path = require('path');
eval(fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'stitch.js'), 'utf8'));
const { matchSeam, grayFromImageData } = globalThis.LongShot;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail ?? ''}`); }
}

// 用伪随机序列构造内容（可复现）
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function contentRow(row, w) {
  // 每行一个基色 + 慢变纹理，接近真实页面（Discord 纯色区也用 uniform 模式测）
  const base = (row * 13) % 251;
  return base;
}
function makeFull(w, h, uniform = false) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const base = uniform ? 64 : contentRow(y, w);
    for (let x = 0; x < w; x++) {
      const v = uniform ? 64 + (x % 7) : Math.max(0, Math.min(255, base + Math.round(Math.sin(x * 0.05) * 30 + (rnd() - 0.5) * 8)));
      const i = (y * w + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

// 与 Stitcher.updateTail 相同的方式构造尾部：输出最后 64 设备行的 2× 灰度
function tailFrom(full, outH) {
  const w = full.width, R = 64;
  const rows = Math.min(R, outH);
  const crop = { data: full.data.subarray((outH - rows) * w * 4, outH * w * 4), width: w, height: rows };
  const g = grayFromImageData(crop); // 2×
  return g;
}

function frameFrom(full, startRow, frameH) {
  const w = full.width;
  return { data: full.data.subarray(startRow * w * 4, (startRow + frameH) * w * 4), width: w, height: frameH };
}

console.log('== 常规内容：精确接缝 ==');
{
  const w = 400, outH = 2000, frameH = 800;
  const full = makeFull(w, outH + frameH);
  const tg = tailFrom(full, outH);
  const TRUE_J = 190, EXP_J = 150;
  const fg = frameFrom(full, outH - TRUE_J, frameH); // 帧第 TRUE_J 行 = 输出底边
  const g = grayFromImageData(fg);
  const r = matchSeam(g, tg, EXP_J >> 1, 100);
  check('接缝行精确', r.j2 === TRUE_J >> 1, `got ${r.j2 * 2}, want ${TRUE_J}`);
  check('置信度高', r.conf >= 0.75, `conf=${r.conf.toFixed(3)}`);
}

console.log('== 漂移：推算值偏差 60 设备像素仍能找回 ==');
{
  const w = 400, outH = 2000, frameH = 800;
  const full = makeFull(w, outH + frameH);
  const tg = tailFrom(full, outH);
  const TRUE_J = 260, EXP_J = 200; // 懒加载插入内容导致布局下移
  const fg = frameFrom(full, outH - TRUE_J, frameH);
  const g = grayFromImageData(fg);
  const r = matchSeam(g, tg, EXP_J >> 1, 130);
  check('找到真实接缝', r.j2 === TRUE_J >> 1, `got ${r.j2 * 2}, want ${TRUE_J}`);
}

console.log('== 纯色平坦区域：平手回中到推算值 ==');
{
  const w = 400, outH = 2000, frameH = 800;
  const full = makeFull(w, outH + frameH, true);
  const tg = tailFrom(full, outH);
  const TRUE_J = 200, EXP_J = 200;
  const fg = frameFrom(full, outH - TRUE_J, frameH);
  const g = grayFromImageData(fg);
  const r = matchSeam(g, tg, EXP_J >> 1, 120);
  check('平坦区接缝=推算值', r.j2 === EXP_J >> 1, `got ${r.j2 * 2}, want ${EXP_J}`);
}

console.log('== 平坦背景+稀疏纹理：全平坦候选窗口必须被拒绝 ==');
{
  // 模拟 Discord 式深色纯色主题：平坦背景 + 伪随机稀疏"文字带"（非周期，贴近真实）
  const w = 400, outH = 2000, frameH = 800;
  const hgt = outH + frameH;
  const bandAt = (y) => (((y * 2654435761) >>> 0) % 61) < 8;
  const d = new Uint8ClampedArray(w * hgt * 4);
  for (let y = 0; y < hgt; y++) {
    const band = bandAt(y);
    for (let x = 0; x < w; x++) {
      const v = band ? 30 + ((x * 13 + y * 7) % 60) : 51;
      const i = (y * w + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  const full = { data: d, width: w, height: hgt };
  const tg = tailFrom(full, outH);
  const TRUE_J = 190, EXP_J = 150;
  const fg = frameFrom(full, outH - TRUE_J, frameH);
  const g = grayFromImageData(fg);
  const r = matchSeam(g, tg, EXP_J >> 1, 130);
  check('真实接缝胜出', r.j2 === TRUE_J >> 1, `got ${r.j2 * 2}, want ${TRUE_J}`);
  check('置信度高', r.conf >= 0.75, `conf=${r.conf.toFixed(3)}`);
}

console.log('== 完全平坦：回退推算值 ==');
{
  // 全平坦尾部无纹理证据 → conf=-1 且返回推算值
  const w = 400, outH = 2000, frameH = 800;
  const d = new Uint8ClampedArray(w * (outH + frameH) * 4).fill(51);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  const full = { data: d, width: w, height: outH + frameH };
  const tg = tailFrom(full, outH);
  const fg = frameFrom(full, outH - 190, frameH);
  const g = grayFromImageData(fg);
  const r = matchSeam(g, tg, 75, 130);
  check('无纹理回退推算', r.j2 === 75 && r.conf === -1, `got ${r.j2}, conf=${r.conf}`);
}

console.log('== 噪声无匹配：低置信度回退 ==');
{
  const w = 400, frameH = 800;
  const noise = makeFull(w, frameH);
  // 帧用另一段独立噪声，与尾部无任何重叠
  seed = 999;
  const noise2 = makeFull(w, frameH);
  const tg = tailFrom(noise, 2000);
  const g = grayFromImageData(noise2);
  const r = matchSeam(g, tg, 100, 100);
  check('置信度低于阈值', r.conf < 0.75, `conf=${r.conf.toFixed(3)}`);
}

console.log('== 首帧/小尾部保护 ==');
{
  const g = { data: new Uint8Array(10), w: 5, h: 2 };
  const tg = { data: new Uint8Array(10), w: 5, h: 2 };
  const r = matchSeam(g, tg, 0, 10);
  check('尾部过小返回推算值', r.j2 === 0 && r.conf === -1);
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
