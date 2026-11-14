// LongShot HUD：截图进度条 / 结果预览卡片 / 轻提示
(() => {
  const LS = (globalThis.LongShot ||= {});
  const Z = 2147483647;
  let root = null, onKey = null, styleInjected = false;

  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const s = document.createElement('style');
    s.textContent = `
      .ls-card { position: fixed; right: 20px; bottom: 20px; z-index: ${Z};
        background: rgba(18,22,30,.96); color: #e8eaf0;
        font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif;
        border-radius: 12px; padding: 14px 16px; box-shadow: 0 8px 30px rgba(0,0,0,.45);
        display: flex; gap: 12px; align-items: center; max-width: min(560px, calc(100vw - 40px)); }
      .ls-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .ls-btns { display: flex; gap: 8px; }
      .ls-card button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 8px;
        background: #2f6fed; color: #fff; font: 12.5px system-ui, sans-serif; white-space: nowrap; }
      .ls-card button.ghost { background: rgba(255,255,255,.14); }
      .ls-card button:hover { filter: brightness(1.15); }
      .ls-card button:disabled { opacity: .5; cursor: default; }
      .ls-thumb { height: 150px; max-width: 110px; object-fit: contain; border-radius: 6px; background: #262b36; flex: none; }
      .ls-sub { color: #9aa3b2; font-size: 12px; }
      .ls-toast { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: ${Z};
        background: rgba(18,22,30,.96); color: #fff; font: 13px system-ui, "Microsoft YaHei", sans-serif;
        padding: 9px 20px; border-radius: 999px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }`;
    document.documentElement.appendChild(s);
  }

  function mkCard() {
    close();
    root = document.createElement('div');
    root.className = 'ls-card';
    document.documentElement.appendChild(root);
    return root;
  }

  function close() {
    root?.remove(); root = null;
    if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; }
  }

  // 回退：后台不可用时在页面内展示预览卡（自测环境用）
  function legacyCard(canvas, info) {
    mkCard();
    const img = document.createElement('img');
    img.className = 'ls-thumb';
    img.src = thumbURL(canvas);
    const col = document.createElement('div');
    col.className = 'ls-col';
    const title = document.createElement('div');
    title.textContent = `${canvas.width} × ${canvas.height} px · ${info.frames} 帧`;
    const sub = document.createElement('div');
    sub.className = 'ls-sub';
    sub.textContent = info.note || '点击「保存 PNG」导出';
    const btns = document.createElement('div');
    btns.className = 'ls-btns';
    const save = document.createElement('button');
    save.textContent = '保存 PNG';
    save.onclick = () => {
      save.disabled = true; save.textContent = '导出中…';
      canvas.toBlob((blob) => {
        if (!blob) { save.textContent = '导出失败'; return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `longshot_${location.hostname}_${stamp()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        LS.hud.toast('已保存到下载目录');
        close();
      }, 'image/png');
    };
    const quit = document.createElement('button');
    quit.className = 'ghost';
    quit.textContent = '关闭';
    quit.onclick = () => close();
    btns.append(save, quit);
    col.append(title, sub, btns);
    root.append(img, col);
    onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey, true);
  }

  function thumbURL(canvas) {
    const scale = Math.min(110 / canvas.width, 150 / canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * scale));
    c.height = Math.max(1, Math.round(canvas.height * scale));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  LS.hud = {
    begin(onCancel) {
      injectStyle();
      mkCard();
      const text = document.createElement('div');
      text.textContent = '正在截图…';
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '取消 (Esc)';
      btn.onclick = () => onCancel();
      root.append(text, btn);
      root._text = text;
    },
    progress(frames, px, phase) {
      if (root?._text) {
        root._text.textContent = phase || `正在截图… 第 ${frames} 帧 · 已拼接 ${px} px`;
      }
    },
    // 截图瞬间隐藏 HUD，避免它出现在画面里
    hideForFrame() { if (root) root.style.visibility = 'hidden'; },
    showAfterFrame() { if (root) root.style.visibility = ''; },
    done(canvas, info) {
      this._lastResult = canvas; // 测试钩子：保留最终画布引用
      injectStyle();
      canvas.toBlob(async (blob) => {
        if (!blob) { this.fail('导出失败'); return; }
        const dataUrl = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.readAsDataURL(blob);
        });
        let opened = false;
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'longshot-result', dataUrl,
            meta: {
              width: canvas.width, height: canvas.height, frames: info.frames,
              note: info.note || '', title: document.title, url: location.href,
            },
          });
          opened = !!(res && (res.ok || res.dataUrl));
        } catch { opened = false; }
        if (opened) {
          close();
          LS.hud.toast('已在新标签页打开长图');
        } else {
          legacyCard(canvas, info); // 后台不可用（自测环境）：页面内预览卡
        }
      }, 'image/png');
    },
    fail(msg) {
      mkCard();
      const col = document.createElement('div');
      col.className = 'ls-col';
      const t = document.createElement('div');
      t.textContent = `截图失败：${msg}`;
      const btns = document.createElement('div');
      btns.className = 'ls-btns';
      const quit = document.createElement('button');
      quit.textContent = '关闭';
      quit.onclick = () => close();
      btns.append(quit);
      col.append(t, btns);
      root.append(col);
      onKey = (e) => { if (e.key === 'Escape') close(); };
      window.addEventListener('keydown', onKey, true);
    },
    toast(msg, ms = 2600) {
      injectStyle();
      const t = document.createElement('div');
      t.className = 'ls-toast';
      t.textContent = msg;
      document.documentElement.appendChild(t);
      setTimeout(() => t.remove(), ms);
    },
    close,
  };
})();
