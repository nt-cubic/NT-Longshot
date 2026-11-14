// LongShot 查看器：全尺寸查看长图，自选保存位置 / 复制 / 关闭
(() => {
  const id = location.hash.slice(1);
  const metaEl = document.getElementById('meta');
  const stage = document.getElementById('stage');
  const msg = document.getElementById('msg');
  let img = null;
  let fitWidth = true;
  let meta = null;
  let blob = null;

  function setMsg(text, isErr) {
    stage.innerHTML = '';
    const d = document.createElement('div');
    d.id = 'msg';
    if (isErr) d.className = 'err';
    d.textContent = text;
    stage.appendChild(d);
  }

  function applySize() {
    if (!img) return;
    if (fitWidth) {
      img.style.width = '100%';
      img.style.maxWidth = img.naturalWidth + 'px';
    } else {
      img.style.width = img.naturalWidth + 'px';
      img.style.maxWidth = 'none';
    }
  }

  function render(dataUrl, m) {
    meta = m;
    metaEl.textContent = `${m.width} × ${m.height} px · ${m.frames} 帧 · 来源：${m.title || ''}${m.note ? ' · ' + m.note : ''}`;
    img = document.createElement('img');
    img.src = dataUrl;
    img.onload = () => {
      stage.innerHTML = '';
      stage.appendChild(img);
      applySize();
      // 准备下载/复制用的 blob
      fetch(dataUrl).then((r) => r.blob()).then((b) => { blob = b; });
    };
    img.onerror = () => setMsg('图片解码失败', true);
  }

  document.getElementById('fitBtn').onclick = (e) => {
    fitWidth = !fitWidth;
    e.target.textContent = fitWidth ? '原始大小' : '适应宽度';
    applySize();
  };

  document.getElementById('saveBtn').onclick = async () => {
    if (!blob) return;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `longshot_${new URL(meta.url).hostname}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    try {
      // saveAs: true 弹出系统"另存为"，由用户决定保存位置
      const id = await chrome.downloads.download({ url: URL.createObjectURL(blob), filename: name, saveAs: true });
      if (!id) { // 用户取消
        return;
      }
    } catch {
      // downloads API 不可用时退回普通下载
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
    }
  };

  document.getElementById('copyBtn').onclick = async () => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      metaEl.textContent = '已复制到剪贴板 · ' + metaEl.textContent;
    } catch {
      metaEl.textContent = '复制失败（图片过大时浏览器会限制），请使用下载 · ' + metaEl.textContent;
    }
  };

  // 从后台取结果（长连接保持 service worker 存活直到传输完成）
  if (!id) { setMsg('缺少结果参数', true); }
  else {
    const port = chrome.runtime.connect({ name: 'longshot-viewer:' + id });
    port.onMessage.addListener((m) => {
      if (m.ok) render(m.dataUrl, m.meta);
      else setMsg('结果已过期（页面过早关闭），请重新截图', true);
    });
    port.onDisconnect.addListener(() => {
      if (!img) setMsg('与截图进程的连接已断开，请重新截图', true);
    });
  }
})();
