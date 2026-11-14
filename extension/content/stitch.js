// LongShot 拼接器：像素级重叠检测（借鉴 ShareX 逐帧比对思路）
// 输出画布按设备像素累积。接缝决策分两级：
//   1) 先在"推算位置"做像素校验，通过则直接采纳（信任滚动，避免相似/重复内容被搜成假接缝）
//   2) 校验失败说明发生了布局回流（懒加载图片使内容长高），再在 ±60% 帧高窗口内搜索真实接缝
// 比对只使用"有纹理的行"：平坦背景行不提供证据，否则纯色主题下
// 全平坦候选窗口会以 SAD=0 击败真实接缝（Discord 深色主题实测踩坑）。
(() => {
  const LS = (globalThis.LongShot ||= {});
  const TAIL_ROWS = 64;   // 参与比对的输出尾部行数（设备像素）
  const CONF_MIN = 0.75;  // 置信度阈值（最终采纳下限）
  const RETRY_CONF = 0.9; // 搜索路径低于此值先重截一帧再定（回流可能还在进行）
  const VERIFY_SAD = 12;  // 推算位置的校验阈值：低于视为精确对齐，直接采纳

  // ImageData（或同构对象）→ 2×降采样灰度 { data, w, h }（纯函数，便于 Node 单测）
  function grayFromImageData(img) {
    const w = img.width, h = img.height, d = img.data;
    const gw = w >> 1, gh = h >> 1;
    const out = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      const r0 = gy * 2 * w, r1 = r0 + w;
      for (let gx = 0; gx < gw; gx++) {
        const c0 = (r0 + gx * 2) * 4, c1 = c0 + 4, c2 = (r1 + gx * 2) * 4, c3 = c2 + 4;
        out[gy * gw + gx] = (d[c0] + d[c0 + 1] + d[c0 + 2] + d[c1] + d[c1 + 1] + d[c1 + 2] +
          d[c2] + d[c2 + 1] + d[c2 + 2] + d[c3] + d[c3 + 1] + d[c3 + 2]) >> 2;
      }
    }
    return { data: out, w: gw, h: gh };
  }

  // 行是否有纹理（max-min 跨度 ≥ 8）：平坦行不参与比对
  // 判断灰度列 x（设备列 2x/2x+1）是否被动态掩码屏蔽（视频/画布区域）
  function colMasked(mask, gx) {
    return mask ? (mask[gx * 2] || mask[gx * 2 + 1]) : 0;
  }

  function texturedRows(gray, wmin, mask) {
    const rows = [];
    for (let r = 0; r < gray.h; r++) {
      const off = r * gray.w;
      let mn = 255, mx = 0;
      for (let x = 0; x < wmin; x++) {
        if (colMasked(mask, x)) continue;
        const v = gray.data[off + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mx - mn >= 8) rows.push(r);
    }
    return rows;
  }

  // 候选接缝 j 的平均差（灰度坐标）：尾部行 tr ↔ 帧行 j-(h-tr)，只累加纹理行
  // 返回 -1 表示证据不足
  function sadAtPosition(fg, tg, textured, j, mask) {
    const wmin = Math.min(fg.w, tg.w);
    let sad = 0, n = 0, rows = 0;
    for (const tr of textured) {
      const fr0 = j - (tg.h - tr);
      if (fr0 < 0) continue;
      const off = fr0 * fg.w, toff = tr * tg.w;
      for (let x = 0; x < wmin; x += 2) {
        if (colMasked(mask, x)) continue;
        sad += Math.abs(fg.data[off + x] - tg.data[toff + x]);
        n++;
      }
      rows++;
    }
    return rows < 2 ? -1 : sad / n;
  }

  // 在帧灰度 fg 中搜索接缝行 j（灰度坐标）：±slack2 窗口内取 SAD 最小者，
  // 平手时取最接近滚动推算值的候选；证据不足则回退推算值
  function matchSeam(fg, tg, expectedJ2, slack2, texturedPre, mask) {
    if (!tg || tg.h < 5 || fg.h < 5) return { j2: expectedJ2, conf: -1 };
    const wmin = Math.min(fg.w, tg.w);
    const textured = texturedPre ?? texturedRows(tg, wmin, mask);
    if (textured.length < 2) return { j2: expectedJ2, conf: -1 };
    let minSad = Infinity;
    const sads = new Map();
    const j0 = Math.max(0, expectedJ2 - slack2);
    const j1 = Math.min(fg.h, expectedJ2 + slack2 + 1);
    for (let j = j0; j < j1; j++) {
      const sad = sadAtPosition(fg, tg, textured, j, mask);
      if (sad < 0) continue;
      sads.set(j, sad);
      if (sad < minSad) minSad = sad;
    }
    if (minSad === Infinity) return { j2: expectedJ2, conf: -1 };
    let bestJ = expectedJ2, bestDist = Infinity;
    for (const [j, sad] of sads) {
      if (sad <= minSad + 2) {
        const d = Math.abs(j - expectedJ2);
        if (d < bestDist) { bestDist = d; bestJ = j; }
      }
    }
    return { j2: bestJ, conf: 1 - minSad / 255 };
  }

  // 单行全分辨率亮度（用于亚像素精修）
  function rowGray(d, w, row, out, outOff) {
    let di = row * w * 4, oi = outOff;
    for (let x = 0; x < w; x++, di += 4) out[oi++] = (d[di] * 299 + d[di + 1] * 587 + d[di + 2] * 114) / 1000 | 0;
  }

  LS.grayFromImageData = grayFromImageData;
  LS.matchSeam = matchSeam;

  class Stitcher {
    constructor(widthDev, scale) {
      this.w = widthDev;
      this.scale = scale;
      this.h = 0; // 已拼接高度（设备像素）
      this.cap = Math.max(2048, Math.min(8192, widthDev * 4));
      this.canvas = document.createElement('canvas');
      this.canvas.width = widthDev;
      this.canvas.height = this.cap;
      this.ctx = this.canvas.getContext('2d');
      this.tmp = document.createElement('canvas');
      this.tctx = this.tmp.getContext('2d', { willReadFrequently: true });
      this.tail = null;     // 输出尾部 2× 灰度（粗比对）
      this.tailFull = null; // 输出尾部 1× 亮度（精修）
      this.frames = 0;
      this.lowConfSeams = 0;
      this.verifiedSeams = 0;
    }

    ensureCap(need) {
      if (need <= this.cap) return;
      let n = this.cap;
      while (n < need) n = Math.ceil(n * 1.5);
      const c2 = document.createElement('canvas');
      c2.width = this.w; c2.height = n;
      c2.getContext('2d').drawImage(this.canvas, 0, 0);
      this.canvas = c2;
      this.ctx = c2.getContext('2d');
      this.cap = n;
    }

    // frameBitmap：整屏位图；crop：帧内裁剪区（设备像素 x/y/w/h）
    // expectedJ：输出底边在帧内的行号（设备像素，滚动推算）
    // final：false 时若接缝置信度过低则不提交像素，返回 { retry: true } 请求重截本帧
    append(frameBitmap, crop, expectedJ, final = false, colMask = null) {
      const { x, y, w, h } = crop;
      if (w !== this.w) throw new Error('裁剪宽度与输出宽度不一致');
      this.colMask = colMask;
      // 裁剪帧 → 位图数据（首帧也要用它构建比对尾部）
      this.tmp.width = w; this.tmp.height = h;
      this.tctx.drawImage(frameBitmap, x, y, w, h, 0, 0, w, h);
      const fimg = this.tctx.getImageData(0, 0, w, h);
      let j = 0, lowConf = false;
      if (this.h > 0) {
        const fg = grayFromImageData(fimg);
        const j2e = Math.round(expectedJ / 2);
        const wmin = Math.min(fg.w, this.tail?.w ?? fg.w);
        const mask = colMask && colMask.length === this.w ? colMask : null;
        const textured = this.tail ? texturedRows(this.tail, wmin, mask) : [];
        // 1) 校验推算位置：滚动精确时直接采纳（防重复内容假匹配）
        const sadExp = textured.length >= 2 ? sadAtPosition(fg, this.tail, textured, j2e, mask) : -1;
        if (sadExp >= 0 && sadExp <= VERIFY_SAD) {
          j = this.refine(fimg, w, h, j2e * 2);
          this.verifiedSeams++;
        } else {
          // 2) 校验失败 → 布局发生回流，扩大窗口搜索真实接缝
          const slack2 = Math.max(32, Math.round((h >> 1) * 0.8));
          const m = LS.matchSeam(fg, this.tail, j2e, slack2, textured, mask);
          j = m.j2 * 2;
          if (m.conf >= 0) j = this.refine(fimg, w, h, j);
          if (m.conf >= 0 && m.conf < RETRY_CONF) {
            if (!final) return { j, appended: 0, retry: true };
            if (m.conf < CONF_MIN) lowConf = true;
          }
        }
        j = Math.max(0, Math.min(h - 1, j));
      }
      const ap = h - j;
      if (ap <= 0) return { j, appended: 0 };
      this.ensureCap(this.h + ap);
      this.ctx.drawImage(frameBitmap, x, y + j, w, ap, 0, this.h, w, ap);
      this.h += ap;
      this.frames++;
      if (lowConf) this.lowConfSeams++;
      this.updateTail(fimg, w, h, j);
      return { j, appended: ap };
    }

    // ±3 设备像素内用全分辨率亮度精修接缝（同样只在纹理行上比对）
    refine(fimg, w, h, j0) {
      if (!this.tailFull) return j0;
      const R = this.tailFull.length / w;
      const rows = [];
      for (let r = 0; r < R; r++) {
        const off = r * w;
        let mn = 255, mx = 0;
        for (let x = 0; x < w; x++) {
          const v = this.tailFull[off + x];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx - mn >= 8) rows.push(r);
      }
      if (rows.length < 2) return j0;
      let minSad = Infinity;
      const cands = [];
      const buf = new Uint8Array(w);
      const mask = this.colMask;
      for (let cand = Math.max(0, j0 - 3); cand <= Math.min(h - 1, j0 + 3); cand++) {
        let sad = 0, n = 0, cnt = 0;
        for (const tr of rows) {
          const fr0 = cand - (R - tr);
          if (fr0 < 0) continue;
          rowGray(fimg.data, w, fr0, buf, 0);
          const toff = tr * w;
          for (let x = 0; x < w; x++) {
            if (mask && mask[x]) continue;
            sad += Math.abs(buf[x] - this.tailFull[toff + x]); n++;
          }
          cnt++;
        }
        if (cnt < 2) continue;
        sad /= n;
        cands.push([cand, sad]);
        if (sad < minSad) minSad = sad;
      }
      if (!cands.length) return j0;
      let best = j0, bestDist = Infinity;
      for (const [cand, sad] of cands) {
        if (sad <= minSad + 2) {
          const d = Math.abs(cand - j0);
          if (d < bestDist) { bestDist = d; best = cand; }
        }
      }
      return best;
    }

    // 尾部灰度 = 输出最后 TAIL_ROWS 行；新追加段足够长则直接取自当前帧
    updateTail(fimg, w, h, j) {
      const ap = h - j;
      // 2× 灰度尾部
      const fg = grayFromImageData(fimg);
      const fh = fg.h;
      const gRows = Math.min(TAIL_ROWS >> 1, fh);
      const g = new Uint8Array(gRows * fg.w);
      if ((ap >> 1) >= gRows) {
        g.set(fg.data.subarray((fh - gRows) * fg.w));
      } else {
        const own = ap >> 1;
        g.set(fg.data.subarray((fh - own) * fg.w), (gRows - own) * fg.w);
        if (this.tail) g.set(this.tail.data.subarray(0, (gRows - own) * this.tail.w), 0);
      }
      this.tail = { data: g, w: fg.w, h: gRows };
      // 1× 亮度尾部（精修用）
      if (ap >= TAIL_ROWS) {
        const t = new Uint8Array(TAIL_ROWS * w);
        for (let r = 0; r < TAIL_ROWS; r++) rowGray(fimg.data, w, h - TAIL_ROWS + r, t, r * w);
        this.tailFull = t;
      } else if (this.tailFull) {
        const t = new Uint8Array(TAIL_ROWS * w);
        const oldRows = TAIL_ROWS - ap;
        t.set(this.tailFull.subarray(oldRows * w, (oldRows + ap) * w), 0);
        for (let r = 0; r < ap; r++) rowGray(fimg.data, w, j + r, t, (oldRows + r) * w);
        this.tailFull = t;
      }
    }

    // 裁到实际高度输出
    finalize() {
      const out = document.createElement('canvas');
      out.width = this.w;
      out.height = Math.max(1, this.h);
      out.getContext('2d').drawImage(this.canvas, 0, 0, this.w, this.h, 0, 0, this.w, this.h);
      return out;
    }
  }

  LS.Stitcher = Stitcher;
})();
