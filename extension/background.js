// LongShot 后台：按需注入内容脚本 + 逐帧转发 captureVisibleTab 请求
const FILES = ['content/selector.js', 'content/capture.js', 'content/stitch.js', 'content/hud.js'];

async function startCapture(tab) {
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.LongShot?.start?.(),
    });
  } catch (e) {
    // chrome:// 等受限页面无法注入
    console.warn('[LongShot] 注入失败:', e?.message);
  }
}

chrome.action.onClicked.addListener(startCapture);

// 轻量保活事件：页面导航会唤醒 service worker（MV3 SW 惰性启动）
chrome.runtime.onInstalled.addListener(() => {});
chrome.tabs.onUpdated.addListener(() => {});

chrome.commands.onCommand.addListener(async (name) => {
  if (name !== 'start-capture') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  startCapture(tab);
});

// 内容脚本每帧请求一次可见区截图
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'longshot-frame' && sender.tab) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      sendResponse({ error: chrome.runtime.lastError?.message ?? null, dataUrl: dataUrl ?? null });
    });
    return true; // 异步响应
  }
  // 截图完成：暂存结果并打开查看器标签页
  if (msg?.type === 'longshot-result' && msg.dataUrl) {
    const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    resultStore.set(id, { dataUrl: msg.dataUrl, meta: msg.meta ?? {} });
    setTimeout(() => resultStore.delete(id), 120000); // 查看器早已取走，兜底清理
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '#' + id });
    sendResponse({ ok: true, id });
    return;
  }
});

// 查看器通过长连接取结果（端口保持 service worker 存活到传输完成）
const resultStore = new Map();
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name?.startsWith('longshot-viewer:')) return;
  const rec = resultStore.get(port.name.slice('longshot-viewer:'.length));
  port.postMessage(rec ? { ok: true, dataUrl: rec.dataUrl, meta: rec.meta } : { ok: false });
  if (rec) resultStore.delete(port.name.slice('longshot-viewer:'.length));
});
