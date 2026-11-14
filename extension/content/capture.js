// LongShot 捕获控制器：滚动容器识别 / 滚动循环 / 懒加载等待 / 悬浮元素处理
//
// 语义（与 ShareX 滚动捕获一致）：拖选的范围是一个"取景窗口"——
// 左/右/上边界决定输出的起点与宽度，内容从窗口中滚过，一直截到
// 滚动容器的末尾（无限流则持续探测加载，Esc 随时停止并保留已截部分）。
(() => {
  const LS = (globalThis.LongShot ||= {});
  const OVERLAP_RATIO = 0.5;      // 相邻帧重叠比例（大重叠=小步慢滚，ShareX 式节奏）
  const SCROLL_SPEED = 520;       // 连续滚动速度（px/秒）：手机匀速下滑的节奏
  const SETTLE_QUIET = 220;       // DOM 静默判定窗口
  const SETTLE_MAX = 1600;        // 单帧最长等待
  const PROBE_MAX = 3200;         // 到底后探测无限加载的最长等待
  const PROBE_MINWAIT = 1800;     // 探测最短等待：给"到底才开始请求"的站点时间
  const PROBE_TIMES = 3;          // 到底探测次数
  const MAX_FRAMES = 600;
  const MAX_DIM = 65000;          // Chrome canvas 单边上限（留余量）
  const MAX_AREA = 260 * 1024 * 1024;

  LS.capture = { active: false, run, findScrollerAt };

  LS.cancelled = false;
  let hiddenMap = new Map();       // 被临时隐藏的悬浮元素 → 原内联 visibility
  let stickyComposites = null;     // 首帧中悬浮元素的位置（用于回贴）
  let lastRects = new Map();       // absolute 元素上一帧的视口 top（行为检测用）
  let lastScroll = null;           // 上一帧的滚动位置（行为检测用）
  let anchor = null;               // 输出底边的 DOM 锚点 { el, rel }

  async function run(rect) {
    if (LS.capture.active) { LS.hud.toast('已有截图任务进行中'); return; }
    LS.capture.active = true;
    LS.cancelled = false;
    hiddenMap = new Map();
    stickyComposites = null;
    lastRects.clear();
    lastScroll = null;

    let sc = null, freeze = null, savedScroll = null;
    const savedTitle = document.title;
    const onKey = (e) => { if (e.key === 'Escape') LS.cancelled = true; };
    window.addEventListener('keydown', onKey, true);

    try {
      // ── 1. 找滚动容器 ──
      sc = findScrollerFromRect(rect);

      // ── 2. 计算取景窗口（列范围固定；行范围每帧按内容流重算）──
      let left, width, cr = null, sbw = 0;
      if (sc.mode === 'inner') {
        cr = sc.el.getBoundingClientRect();
        sbw = Math.max(0, sc.el.offsetWidth - sc.el.clientWidth);
        left = Math.max(rect.left, cr.left);
        const right = Math.min(rect.right, cr.right - sbw);
        if (right - left < 40 || Math.min(rect.bottom, cr.bottom) - Math.max(rect.top, cr.top) < 40) {
          throw new Error('选择范围与滚动区域交集过小');
        }
        width = right - left;
      } else {
        const rootSbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        const right = rect.right >= window.innerWidth - rootSbw - 2 ? window.innerWidth - rootSbw : rect.right;
        if (rect.width < 40 || rect.height < 40 || right - rect.left < 40) throw new Error('选择范围过小');
        left = rect.left;
        width = right - rect.left;
      }
      // 起点内容坐标：范围上边界处的内容
      const contentTop = sc.mode === 'inner'
        ? sc.el.scrollTop + (Math.max(rect.top, cr.top) - cr.top)
        : window.scrollY + rect.top;
      // 每帧窗口高度（决定步进），按用户划出的可见高度估
      const baseWindowH = Math.min(
        rect.height,
        sc.mode === 'inner' ? sc.el.clientHeight : window.innerHeight,
      );
      const overlapCss = Math.max(48, Math.round(baseWindowH * OVERLAP_RATIO));
      const viewH = sc.mode === 'inner' ? sc.el.clientHeight : window.innerHeight;
      const contentEnd = () => sc.mode === 'inner' ? sc.el.scrollHeight : document.documentElement.scrollHeight;
      // 内容坐标 → 屏幕坐标（取景窗口上边缘）
      const screenTopOf = (c, s) => sc.mode === 'inner'
        ? sc.el.getBoundingClientRect().top + (c - s)
        : c - s;

      // ── 3. 冻结页面动画/平滑滚动/滚动锚定；无占位滚动条时隐藏滚动条 ──
      freeze = injectFreeze();

      // ── 4. 悬浮元素由 overlayPass 每帧检测（静态+行为+形状三重规则）──

      // ── 5. 保存现场并启动 HUD ──
      savedScroll = getScroll(sc);
      LS._frameLog = [];
      LS.hud.begin(() => { LS.cancelled = true; });

      // ── 6. 捕获循环 ──
      let stitcher = null, Y = null, frame0Crop = null, bmp0 = null;
      let frames = 0, failedProbes = 0, zeroAppend = 0, stuck = 0, crawl = 0, note = '';

      while (true) {
        if (LS.cancelled) { note = '已手动停止'; break; }
        let s = getScroll(sc);
        // 补偿跳变校验：仅在锚点失效时启用（锚点活着时它自己就是位移校准）。
        // 补偿跳变（prepend 重建 DOM）锚点必死 → 校验启用；
        // 到底后底部增长（旧内容不动）锚点仍活 → 跳过校验，正常循环续截。
        if (Y !== null && !anchorAliveNow()) {
          const drift = s - (Y - overlapCss);
          if (Math.abs(drift) > 60) {
            Y += drift;
            s = getScroll(sc);
          }
        }
        const atBottom = s >= maxScroll(sc) - 1;

        // 到底且锚点失效（虚拟化重建）：回退数学在底部不可靠，
        // 先探测增长并等下滚，再截帧——否则同一屏会被重复拼接
        if (Y !== null && atBottom && !anchorAliveNow()) {
          const grew = await probeGrowth(sc);
          if (!grew) {
            failedProbes++;
            if (failedProbes >= PROBE_TIMES) break;
          } else {
            failedProbes = 0;
          }
          continue;
        }

        // 已到底且输出已覆盖内容末尾：探测无限加载
        if (Y !== null && Y >= contentEnd() - 1) {
          const grew = await probeGrowth(sc);
          if (!grew) {
            failedProbes++;
            if (failedProbes >= PROBE_TIMES) break;
          } else {
            failedProbes = 0;
          }
          continue;
        }

        let frameTop = Y === null ? contentTop : Y - overlapCss; // 内容坐标
        let cropTop = screenTopOf(frameTop, s);
        if (cropTop < (sc.mode === 'inner' ? sc.el.getBoundingClientRect().top : 0)) {
          // 防御：滚动过冲时把裁剪顶截回可视区，并反推实际内容坐标
          cropTop = sc.mode === 'inner' ? sc.el.getBoundingClientRect().top : 0;
          frameTop = sc.mode === 'inner' ? s + (cropTop - sc.el.getBoundingClientRect().top) : s + cropTop;
        }
        let cropBot;
        if (sc.mode === 'inner') {
          const c = sc.el.getBoundingClientRect();
          cropBot = Math.min(c.bottom - sbw, c.top + (contentEnd() - s), window.innerHeight);
        } else {
          cropBot = Math.min(window.innerHeight, contentEnd() - s);
        }
        const cropH = cropBot - cropTop;
        if (cropH < 2) {
          // 窗口里没有新内容：到底探测
          const grew = await probeGrowth(sc);
          if (!grew) {
            failedProbes++;
            if (failedProbes >= PROBE_TIMES) break;
          } else {
            failedProbes = 0;
          }
          continue;
        }
        const crop = { left, width, top: cropTop, height: cropH };

        let bmp;
        if (!stitcher) {
          // 首帧双拍：先拍一张带悬浮元素的（作为回贴源），再隐藏全部悬浮元素、
          // 拍干净的拼接帧——悬浮条从第一帧起就不会进入长图和比对基准
          bmp = await captureFrame();
          bmp0 = bmp;
          overlayPass(sc, true, crop);
          LS.hud.hideForFrame();
          await raf2();
          bmp = await captureFrame();
          LS.hud.showAfterFrame();
        } else {
          overlayPass(sc, false, null); // 藏掉新判定/新挂载的悬浮元素
          LS.hud.hideForFrame();
          await raf2();
          bmp = await captureFrame();
          LS.hud.showAfterFrame();
        }

        const scale = bmp.width / window.innerWidth;
        const dev = devRect(crop, scale, bmp);
        const dynMask = collectDynamicMask(crop, scale);

        if (!stitcher) {
          stitcher = new LS.Stitcher(dev.w, scale);
          frame0Crop = crop;
        }
        // 接缝行候选：优先 DOM 锚点（精确，回流免疫），失效则滚动推算
        const jAnchor = anchorExpectedJ(cropTop, scale);
        const expectedJ = Y === null
          ? 0
          : Math.max(0, jAnchor ?? Math.round((Y - frameTop) * scale));
        let r = stitcher.append(bmp, dev, expectedJ, false, dynMask);
        for (let attempt = 0; r.retry && attempt < 2 && !LS.cancelled; attempt++) {
          // 接缝置信度低：可能有延迟加载正在改变布局，等它落地后重截本帧（未提交像素）
          bmp.close();
          LS.hud.progress(frames + 1, Math.round(stitcher.h / scale), '等待页面稳定…');
          await settle(sc, crop, 2400 + attempt * 1000);
          if (LS.cancelled) { note = '已手动停止'; break; }
          LS.hud.hideForFrame();
          await raf2();
          const bmp2 = await captureFrame();
          LS.hud.showAfterFrame();
          r = stitcher.append(bmp2, dev, expectedJ, attempt === 1, dynMask);
          bmp2.close();
        }
        if (bmp !== bmp0) bmp.close(); // close() 幂等，重试路径已关过也无害
        if (r.appended <= 0) { if (++zeroAppend >= 3) break; } else zeroAppend = 0;
        const appendedCss = r.appended / scale;
        // 爬行防护：连续多帧推进不足 8px（锚点/比对异常的信号）
        if (r.appended > 0 && appendedCss < 8) {
          if (++crawl >= 3) { note = '滚动推进异常，已停止'; break; }
        } else crawl = 0;
        Y = (Y === null ? frameTop : Y) + appendedCss;
        frames++;
        (LS._frameLog ??= []).push({ f: frames, y: Math.round(getScroll(sc)), app: +appendedCss.toFixed(1) });
        LS.hud.progress(frames, Math.round(stitcher.h / scale));

        recordAnchor(sc, crop);

        if (frames >= MAX_FRAMES) { note = '已达帧数上限'; break; }
        if (stitcher.h > MAX_DIM || stitcher.h * stitcher.w > MAX_AREA) { note = '已达最大长度'; break; }

        // 连续匀速滚动到"输出底边 - 重叠量"；jump = 虚拟化加载补偿跳变量
        const { moved, jump } = await glideScroll(sc, Y - overlapCss);
        if (jump) Y += jump; // 内容坐标随补偿重对齐
        if (moved < 0.5) {
          if (atBottom) {
            const grew = await probeGrowth(sc);
            if (!grew) {
              failedProbes++;
              if (failedProbes >= PROBE_TIMES) break;
            } else {
              failedProbes = 0;
            }
            continue;
          }
          // 页面中段滚不动（滚动劫持等）：连续两次则放弃
          if (++stuck >= 2) { note = '页面无法继续滚动'; break; }
          continue;
        }
        stuck = 0; failedProbes = 0;
        await settle(sc, crop);
      }

      if (!stitcher || stitcher.h === 0) throw new Error('未捕获到任何内容');

      // ── 7. 收尾：悬浮元素回贴 + 超限缩小 ──
      const scale = stitcher.scale;
      let final = stitcher.finalize();
      if (bmp0 && stickyComposites?.length) {
        const octx = final.getContext('2d');
        for (const c of stickyComposites) {
          const sw = Math.round(c.w * scale), sh = Math.round(c.h * scale);
          // bmp0 是整屏截图：源坐标用视口坐标，目标坐标用首帧裁剪区相对坐标
          const sx = Math.round(c.x * scale);
          const sy = Math.round(c.y * scale);
          const dx = Math.round((c.x - frame0Crop.left) * scale);
          const dy = Math.round((c.y - frame0Crop.top) * scale);
          if (sw > 0 && sh > 0) octx.drawImage(bmp0, sx, sy, sw, sh, dx, dy, sw, sh);
        }
      }
      bmp0?.close(); bmp0 = null;
      if (final.height > MAX_DIM || final.width * final.height > MAX_AREA) {
        const f = Math.min(MAX_DIM / final.height, Math.sqrt(MAX_AREA / (final.width * final.height)));
        const c2 = document.createElement('canvas');
        c2.width = Math.max(1, Math.round(final.width * f));
        c2.height = Math.max(1, Math.round(final.height * f));
        c2.getContext('2d').drawImage(final, 0, 0, c2.width, c2.height);
        final = c2;
        note = (note ? note + '，' : '') + '图过长已自动缩小';
      }
      if (stitcher.lowConfSeams > 0) {
        note = (note ? note + '，' : '') + `${stitcher.lowConfSeams} 处接缝置信度低`;
      }

      const hiddenCount = hiddenMap.size;
      restore(sc, freeze, savedScroll, savedTitle);
      LS.lastStats = { frames: stitcher.frames, lowConfSeams: stitcher.lowConfSeams, width: final.width, height: final.height, hiddenOverlays: hiddenCount, frameLog: LS._frameLog ?? [] };
      LS.hud.done(final, { frames: stitcher.frames, note });
    } catch (e) {
      restore(sc, freeze, savedScroll, savedTitle);
      if (LS.cancelled) LS.hud.toast('已取消');
      else LS.hud.fail(e?.message || String(e));
    } finally {
      window.removeEventListener('keydown', onKey, true);
      anchor = null;
      LS.capture.active = false;
    }
  }

  // ────────────────────────── 滚动容器 ──────────────────────────

  function findScrollerFromRect(rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let el = document.elementFromPoint(cx, cy)
      || document.elementFromPoint(rect.left + 2, rect.top + 2);
    while (el && el !== document.documentElement && el !== document.body) {
      if (isScrollableY(el)) return { el, mode: 'inner' };
      el = el.parentElement;
    }
    return { el: null, mode: 'doc' };
  }

  function findScrollerAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement && el !== document.body) {
      if (isScrollableY(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isScrollableY(el) {
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
    return el.scrollHeight - el.clientHeight > 4;
  }

  // ────────────────────────── 滚动 ──────────────────────────

  function getScroll(sc) { return sc.mode === 'inner' ? sc.el.scrollTop : window.scrollY; }

  function maxScroll(sc) {
    if (sc.mode === 'inner') return Math.max(0, sc.el.scrollHeight - sc.el.clientHeight);
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function setScroll(sc, v) {
    v = Math.max(0, Math.min(v, maxScroll(sc)));
    if (sc.mode === 'inner') sc.el.scrollTop = v;
    else window.scrollTo(0, v);
    return v;
  }

  // 连续匀速滚动到目标：每个动画帧滚 SCROLL_SPEED×dt，观感与手机匀速下滑一致；
  // 直接设置无效时降级派发滚轮事件；连续无进展则提前结束（由调用方处理到底/卡死）。
  // 跳变检测：虚拟化列表加载时会做 scrollTop 补偿（实际位置瞬间偏离指令），
  // 跳变量返回给调用方计入内容坐标，否则拼接会整帧重复（实测 Discord）。
  function glideScroll(sc, targetCss) {
    return new Promise((resolve) => {
      const start = getScroll(sc);
      let last = performance.now();
      let noProgress = 0;
      let jump = 0;
      let intended = start;
      const step = (now) => {
        const dt = Math.min(64, now - last);
        last = now;
        if (LS.cancelled) return resolve({ moved: getScroll(sc) - start, jump });
        const cur = getScroll(sc);
        if (Math.abs(cur - intended) > 60) {
          const dj = cur - intended;
          jump += dj;
          targetCss += dj; // 目标内容随补偿整体下移
          (LS._frameLog ??= []).push({ f: -1, y: Math.round(cur), app: 0, jump: Math.round(dj) });
        }
        const remaining = targetCss - cur;
        if (Math.abs(remaining) < 1) return resolve({ moved: getScroll(sc) - start, jump });
        const d = Math.sign(remaining) * Math.min(Math.abs(remaining), (SCROLL_SPEED * dt) / 1000);
        intended = cur + d;
        setScroll(sc, intended);
        if (Math.abs(getScroll(sc) - cur) < 0.3) {
          // 直接设置无效：派发滚轮事件（自管滚动页面）；连续无效则结束
          const t = sc.el || document.documentElement;
          t.dispatchEvent(new WheelEvent('wheel', {
            deltaY: remaining, bubbles: true, cancelable: true, clientX: 12, clientY: 12,
          }));
          if (++noProgress >= 3) return resolve({ moved: getScroll(sc) - start, jump });
        } else {
          noProgress = 0;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  async function probeGrowth(sc) {
    const before = maxScroll(sc);
    // 轻推滚动（上→下）：重新触发"接近底部才发起加载"的站点逻辑（Discord 等）
    const vh = sc.mode === 'inner' ? sc.el.clientHeight : window.innerHeight;
    const cur = getScroll(sc);
    const nudge = Math.max(120, Math.round(vh * 0.3));
    setScroll(sc, Math.max(0, cur - nudge));
    await sleep(150);
    setScroll(sc, cur);
    // 最短等待：DOM 静默可能发生在"请求还没发出"时，过早判死会漏掉增长
    const t0 = performance.now();
    await settle(sc, null, PROBE_MAX);
    const remain = PROBE_MINWAIT - (performance.now() - t0);
    if (remain > 0) await sleep(remain);
    return maxScroll(sc) > before + 2;
  }

  const raf2 = () => new Promise((res) => {
    let n = 0;
    const step = () => (++n >= 2 ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
    setTimeout(res, 150); // 后台标签 rAF 节流兜底
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ────────────────────────── 等待页面稳定 ──────────────────────────

  // 条件：滚动位置不再变化 + DOM 静默 + 窗口附近图片加载完成；超时则尽力而为
  function settle(sc, crop, maxMs = SETTLE_MAX) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let lastMut = performance.now();
      const obs = new MutationObserver((muts) => { if (muts.length) lastMut = performance.now(); });
      obs.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
      });
      const imgs = crop ? snapshotImgs(crop, Math.round(
        (sc.mode === 'inner' ? sc.el.clientHeight : window.innerHeight) * 0.6,
      )) : [];
      let lastPos = getScroll(sc);
      (function poll() {
        if (LS.cancelled) { obs.disconnect(); return resolve(false); }
        const pos = getScroll(sc);
        const pending = imgs.some((im) => !im.complete);
        if (pos === lastPos && performance.now() - lastMut >= SETTLE_QUIET && !pending) {
          obs.disconnect();
          return resolve(true);
        }
        lastPos = pos;
        if (performance.now() - t0 >= maxMs) { obs.disconnect(); return resolve(false); }
        setTimeout(poll, 120);
      })();
    });
  }

  function snapshotImgs(crop, margin) {
    const out = [];
    const list = document.images;
    const cl = crop.left - margin, ct = crop.top - margin;
    const cr = crop.left + crop.width + margin, cb = crop.top + crop.height + margin;
    for (let i = 0; i < list.length && out.length < 400; i++) {
      const im = list[i];
      if (im.complete) continue;
      const r = im.getBoundingClientRect();
      if (r.right < cl || r.left > cr || r.bottom < ct || r.top > cb) continue;
      out.push(im);
    }
    return out;
  }

  // ────────────────────────── 截图 ──────────────────────────

  async function captureFrame() {
    for (let i = 0; i < 2; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'longshot-frame' });
        if (res?.dataUrl && !res.error) {
          const blob = await (await fetch(res.dataUrl)).blob();
          return await createImageBitmap(blob);
        }
        throw new Error(res?.error || '无返回');
      } catch (e) {
        if (i === 1) throw new Error(`截图失败：${e?.message || e}（请保持标签页在前台）`);
        await sleep(250);
      }
    }
  }

  function devRect(r, scale, bmp) {
    let x = Math.max(0, Math.round(r.left * scale));
    let y = Math.max(0, Math.round(r.top * scale));
    let w = Math.round(r.width * scale), h = Math.round(r.height * scale);
    if (bmp) { w = Math.min(w, bmp.width - x); h = Math.min(h, bmp.height - y); }
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  }

  // ────────────────────────── 悬浮/覆盖元素（三重检测）──────────────────────────
  // Discord 的"您正在查看历史消息 / 跳转至当前"条是 position:absolute，
  // 静态规则抓不到；它每帧贴在画面底部被拼进长图，还占据每帧底部数十字行、
  // 污染拼接比对基准，是实测撕裂的主要根源。因此三管齐下：
  //   ① 静态：position fixed/sticky 一定悬浮
  //   ② 行为：页面滚动而元素视口位置不动 → 悬浮 overlay
  //   ③ 形状：贴底宽短条直接判悬浮（首帧与新挂载的底栏）
  // 悬浮元素若不隐藏，既会逐帧盖进长图，也会毒化比对基准。

  // 深度遍历所有元素（穿透 Shadow DOM——部分页面的浮动条渲染在 shadow root 里）
  function* deepElements(root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* deepElements(el.shadowRoot);
    }
  }

  function isViewportShell(r) {
    // 覆盖 ≥95% 视口的元素多半是页面外壳（隐藏会截出空白）
    return r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95;
  }

  function hideEl(el) {
    hiddenMap.set(el, el.style.visibility);
    el.style.visibility = 'hidden';
  }

  function isBottomOverlay(r, sc) {
    const edge = sc.mode === 'inner' ? sc.el.getBoundingClientRect().bottom : window.innerHeight;
    const w = sc.mode === 'inner' ? sc.el.clientWidth : window.innerWidth;
    return r.height >= 20 && r.height <= 150 && r.width >= w * 0.55 &&
           r.bottom >= edge - 14 && r.top >= edge - 170;
  }

  // 每帧调用：判定并隐藏全部悬浮/覆盖元素。
  // isFirst：同时记录 fixed/sticky 元素与首帧裁剪区相交的位置（结束后回贴）。
  function overlayPass(sc, isFirst, frame0Crop) {
    const s = getScroll(sc);
    const dScroll = lastScroll == null ? null : s - lastScroll;
    const scEl = sc.el;
    const toHide = [];
    for (const el of deepElements(document.body ?? document)) {
      if (hiddenMap.has(el)) continue;
      if (scEl && (el === scEl || el.contains(scEl))) continue; // 不能隐藏滚动容器的祖先
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (cs.position !== 'fixed' && cs.position !== 'sticky' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < -2 || r.top > window.innerHeight + 2) continue;
      if (isViewportShell(r)) continue;
      let floating = cs.position === 'fixed' || cs.position === 'sticky';
      if (!floating && cs.position === 'absolute' && !(scEl && scEl.contains(el))) {
        // 滚动器内部的内容级 absolute（消息装饰等）不参与判定，防误伤
        const prevTop = lastRects.get(el);
        if (prevTop != null && dScroll != null && Math.abs(dScroll) > 24 &&
            Math.abs(r.top - prevTop) <= Math.max(4, Math.abs(dScroll) * 0.15)) {
          floating = true; // 行为：滚动而它不动
        } else if (isBottomOverlay(r, sc)) {
          floating = true; // 形状：贴底宽短条
        }
      }
      if (floating) {
        toHide.push(el);
      } else if (cs.position === 'absolute') {
        lastRects.set(el, r.top); // 跟踪未判定的 absolute，供下帧行为比对
      }
      if (isFirst && (cs.position === 'fixed' || cs.position === 'sticky') && frame0Crop) {
        const il = Math.max(r.left, frame0Crop.left);
        const it = Math.max(r.top, frame0Crop.top);
        const ir = Math.min(r.right, frame0Crop.left + frame0Crop.width);
        const ib = Math.min(r.bottom, frame0Crop.top + frame0Crop.height);
        if (ir - il >= 2 && ib - it >= 2) {
          stickyComposites ??= [];
          stickyComposites.push({ x: il, y: it, w: ir - il, h: ib - it });
        }
      }
    }
    lastScroll = s;
    if (lastRects.size > 600) lastRects.clear();
    for (const el of toHide) hideEl(el);
  }

  // ────────────────────────── 动态像素掩码 ──────────────────────────
  // video/canvas 每帧像素都在变，不能参与接缝比对；把它们的视口矩形投到
  // 裁剪区列掩码上，比对（含纹理判定/精修）跳过这些列，其余列仍是有效证据。

  function collectDynamicMask(crop, scale) {
    const n = Math.max(1, Math.round(crop.width * scale));
    const mask = new Uint8Array(n);
    for (const el of document.querySelectorAll('video, canvas')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const x0 = Math.max(0, Math.round((r.left - crop.left) * scale));
      const x1 = Math.min(n, Math.round((r.right - crop.left) * scale));
      for (let x = x0; x < x1; x++) mask[x] = 1;
    }
    return mask;
  }

  // ────────────────────────── DOM 锚点 ──────────────────────────
  // 记录"输出底边像素"所属的 DOM 元素与相对偏移。下一帧直接问该元素现在的位置，
  // 接缝行由 DOM 精确算出——内容长高（回流）被自动吸收，重复内容无法干扰对齐。
  // 仅当锚点失效（元素被卸载/隐藏）时回退到滚动推算 + 像素搜索。

  function recordAnchor(sc, crop) {
    anchor = null;
    try {
      const x = Math.round(crop.left + crop.width / 2);
      const y = Math.round(crop.top + crop.height - 2);
      const el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement || el === document.body) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') return; // 视口稳定元素不可作锚点
      const scEl = sc?.el;
      // 锚点必须是滚动器内部的内容元素：滚动器自身/祖先在 inner 模式下视口位置
      // 固定不动，会让接缝每帧只前进 1~2px（实测 Discord 1px 爬行的根因）
      if (scEl && (el === scEl || !scEl.contains(el))) return;
      const r = el.getBoundingClientRect();
      if (r.height < 1) return;
      anchor = { el, rel: y - r.top };
    } catch { anchor = null; }
  }

  // 锚点当前是否仍指向活着的页面内容
  function anchorAliveNow() {
    if (!anchor) return false;
    const el = anchor.el;
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.height >= 1 && r.width >= 1;
  }

  // 返回接缝行（设备像素）或 null（锚点失效）
  function anchorExpectedJ(cropTopCss, scale) {
    if (!anchor) return null;
    const el = anchor.el;
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.height < 1 || r.width < 1) return null; // 被虚拟化隐藏
    const seamY = r.top + anchor.rel;
    const j = (seamY - cropTopCss) * scale;
    if (!isFinite(j) || j < -2 || j > 1e7) return null;
    return Math.round(j);
  }

  // ────────────────────────── 页面冻结与还原 ──────────────────────────

  function injectFreeze() {
    const s = document.createElement('style');
    s.textContent = `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition: none !important;
        scroll-snap-type: none !important;
        overflow-anchor: none !important;
      }`;
    // 无占位滚动条（overlay）时隐藏滚动条，避免滚动条被截进画面（不引起回流）
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    if (sbw <= 0) s.textContent += `
      ::-webkit-scrollbar { display: none !important; }
      * { scrollbar-width: none !important; }`;
    document.documentElement.appendChild(s);
    return s;
  }

  function restore(sc, freeze, savedScroll, savedTitle) {
    for (const [el, v] of hiddenMap) el.style.visibility = v;
    hiddenMap.clear();
    stickyComposites = null;
    if (sc && savedScroll != null) setScroll(sc, savedScroll);
    freeze?.remove();
    document.title = savedTitle;
    LS.hud.close();
  }
})();
