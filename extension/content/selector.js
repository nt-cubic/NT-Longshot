// LongShot 范围选择覆盖层：拖拽划矩形 / 单击选滚动区域 / Esc 取消
(() => {
  const LS = (globalThis.LongShot ||= {});
  const Z = 2147483647;
  let layer = null, onKey = null;

  LS.start = start;

  function start() {
    if (LS.capture?.active) return; // 截图进行中不重复启动
    remove();
    layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed', inset: '0', zIndex: Z,
      cursor: 'crosshair', userSelect: 'none',
    });
    const hint = document.createElement('div');
    hint.textContent = '拖拽选择范围 · 单击选择滚动区域 · Esc 取消';
    Object.assign(hint.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(15,18,25,.92)', color: '#fff',
      font: '13px/1.6 system-ui, "Microsoft YaHei", sans-serif',
      padding: '8px 18px', borderRadius: '999px', pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0,0,0,.35)',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', display: 'none', pointerEvents: 'none',
      border: '1.5px solid #4c8dff', background: 'rgba(76,141,255,.14)',
      boxShadow: '0 0 0 100000px rgba(0,0,0,.35)',
    });
    const size = document.createElement('div');
    Object.assign(size.style, {
      position: 'fixed', display: 'none', pointerEvents: 'none', whiteSpace: 'nowrap',
      background: 'rgba(15,18,25,.92)', color: '#fff', font: '12px system-ui, sans-serif',
      padding: '3px 8px', borderRadius: '6px',
    });
    layer.append(box, size, hint);
    document.documentElement.appendChild(layer);

    let sx = 0, sy = 0, dragging = false;

    onKey = (e) => { if (e.key === 'Escape') remove(); };
    window.addEventListener('keydown', onKey, true);

    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      box.style.display = size.style.display = 'block';
      move(e);
    });
    layer.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    layer.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const r = normRect(sx, sy, e.clientX, e.clientY);
      // 单击：选择所在滚动区域；找不到则退化为当前可视区
      if (r.width < 4 && r.height < 4) {
        const el = LS.capture?.findScrollerAt?.(e.clientX, e.clientY);
        remove();
        let region;
        if (el) {
          const cr = el.getBoundingClientRect();
          region = {
            left: Math.max(cr.left, 0),
            top: Math.max(cr.top, 0),
            right: Math.min(cr.right, document.documentElement.clientWidth),
            bottom: Math.min(cr.bottom, window.innerHeight),
          };
        } else {
          region = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        }
        region.width = region.right - region.left;
        region.height = region.bottom - region.top;
        if (region.width >= 40 && region.height >= 40) { LS.capture.run(region); return; }
        LS.hud.toast('该位置范围过小，请拖拽选择');
        setTimeout(() => LS.start(), 300);
        return;
      }
      if (r.width < 40 || r.height < 40) {
        remove();
        LS.hud.toast('范围太小，请拖出更大的区域');
        return;
      }
      remove();
      LS.capture.run(r);
    });

    function move(e) {
      const r = normRect(sx, sy, e.clientX, e.clientY);
      Object.assign(box.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      Object.assign(size.style, { left: r.left + 'px', top: Math.max(0, r.top - 26) + 'px' });
      size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    }
  }

  function normRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    return { left, top, right: Math.max(x1, x2), bottom: Math.max(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  function remove() {
    layer?.remove();
    layer = null;
    if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; }
  }
})();
