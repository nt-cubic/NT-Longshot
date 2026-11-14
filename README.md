<div align="center">

# NT Longshot

**浏览器滚动长截图扩展 · 拖选范围 → 匀速下滑 → 像素级拼接**

*Scrolling long-screenshot extension for Chrome/Edge — drag a region, glide down, pixel-perfect stitching.*

</div>

---

## 中文

一个专门为**现代动态页面**设计的滚动长截图扩展。专为 Twitter / X、Discord、微博、B 站、YouTube 这类页面而生——它们会让几乎所有主流长截图插件翻车。

### 为什么再写一个？

GoFullPage、FireShot 这些主流插件的核心逻辑停留在 2010 年代："按 scrollY 精确滚动 → 截图 → 直接拼接"。这个假设在遇到以下现代页面技术时全部崩塌，而本项目逐一解决：

| 动态页面的坑 | 主流插件的表现 | NT Longshot 的解法 |
|---|---|---|
| 虚拟化列表（Twitter 时间线、Discord 频道）：滚过的消息从 DOM 卸载 | 错位、缺失、重复 | DOM 锚点追踪 + 帧级遥测 |
| 消息卡片/引用推文异步展开，内容中途长高数百 px | 整条消息重复拼接 | 锚点自动吸收位移 + 验收失败自动重截 |
| 播放器画面每帧都在变（B 站/YouTube） | 比对永不收敛，卡在"等待稳定" | video/canvas 动态列掩码，跳过播放器列比对 |
| Discord「跳转至当前」等 absolute 定位浮条 | 浮条盖满整张长图 | 静态 + 行为 + 形状三重悬浮检测（穿透 Shadow DOM） |
| 懒加载图片没就绪就截图 | 大片灰占位块 | 每帧等待 DOM 静默 + 图片就绪，置信度不足自动重截 |

### 功能

- **拖选范围**截图，或**单击**直接选中所在滚动区域
- **连续匀速滚动**（约 520px/秒），观感与手机下滑一致
- 滚动到底自动探测无限加载；`Esc` 随时停止并保留已截部分
- 完成后**新标签页查看大图**：适应宽度 / 原始大小切换、下载 PNG（弹系统"另存为"，自选位置）、复制到剪贴板
- 悬浮元素（顶栏/侧栏/浮条）自动隐藏，只在长图首帧位置出现一次
- 输出原始分辨率 PNG（devicePixelRatio 缩放自动处理）

### 已知限制

- 视频区域定格在截图瞬间的画面（所有长截图工具的共性）
- 不支持横向滚动页面
- 超长截图受 Chrome canvas 面积上限（约 16384² 像素）约束，超限自动等比缩小

### 安装

1. 下载或克隆本仓库
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/` 目录
4. 建议固定到工具栏；默认快捷键 `Alt+Shift+S`

### 使用

1. 点击工具栏图标（或按快捷键）
2. **拖拽**划出范围；或**单击**某处，自动选中它所在的滚动区域（Discord 里点一下消息区即可）
3. 插件匀速下滑逐帧截取，`Esc` 随时停止并保留已截部分
4. 完成后自动打开新标签页：查看大图、下载 PNG（自选位置）、复制到剪贴板

**范围的语义**：左/右/上边界决定输出的起点与宽度；内容像流水一样从窗口中滚过，
一直截到滚动容器的末尾（无限流则持续探测加载）。

## English

A scrolling long-screenshot extension designed for **modern dynamic pages** — Twitter/X, Discord, Weibo, Bilibili, YouTube — the exact sites that break nearly every mainstream capture extension.

### Why another one?

The mainstream tools (GoFullPage, FireShot, …) are built on a 2010s assumption: *scroll by exact scrollY → capture → concatenate*. Every modern-page technique listed below breaks that assumption. NT Longshot rebuilds the pipeline around them:

| Dynamic-page pitfall | Mainstream behavior | NT Longshot |
|---|---|---|
| Virtualized lists (Twitter timeline, Discord channels): scrolled-away messages are unmounted | Misaligned, missing, duplicated output | DOM anchor tracking + per-frame telemetry |
| Cards / quoted tweets expand asynchronously, growing content mid-capture | Entire messages duplicated | Anchors absorb the shift; low-confidence seams are re-captured automatically |
| Player pixels change every frame (Bilibili/YouTube) | Matching never converges, stuck on "waiting for stability" | video/canvas column mask — player columns are excluded from matching |
| `absolute`-positioned overlays like Discord's "Jump to present" bar | Bar stamped across the whole screenshot | Triple overlay detection (static + behavioral + shape), piercing Shadow DOM |
| Lazy images not loaded yet | Big gray placeholders | Per-frame settle wait (DOM quiet + images complete), auto re-capture on low confidence |

### Features

- **Drag** a region, or **single-click** to capture the scroll container under the cursor
- **Continuous constant-velocity scrolling** (~520 px/s), like scrolling on a phone
- Infinite feeds are detected and followed automatically; `Esc` stops anytime and keeps what was captured
- On finish, a **new tab opens with the full-size image**: fit-width / 1:1 toggle, PNG download (system "Save as" dialog), copy to clipboard
- Floating elements (headers, sidebars, bars) are hidden automatically and stamped once at their first-frame position
- Full-resolution PNG output with devicePixelRatio handling

### Known limitations

- Video regions are frozen at the moment of capture (true for every scroll-capture tool)
- Horizontal scrolling pages are not supported
- Very tall captures are bounded by Chrome's canvas area limit (~16384² px); oversized output is scaled down automatically

### Install

1. Clone this repo
2. Open `chrome://extensions` (Edge: `edge://extensions`)
3. Enable Developer mode → *Load unpacked* → select the `extension/` folder
4. Pin it to the toolbar; default shortcut is `Alt+Shift+S`

### Usage

1. Click the toolbar icon (or press the shortcut)
2. **Drag** a region; or **click** somewhere to capture its scroll container (in Discord, click the message area)
3. The extension glides down and stitches frames; press `Esc` anytime to stop and keep the result
4. A new tab opens automatically: view, download PNG (choose location), copy to clipboard

**Region semantics**: the left/right/top edges define the output origin and width; content flows
through the window until the end of the scroll container (infinite feeds are followed via probing).

## 工作原理 / How it works

```
background.js        service worker：注入脚本、逐帧转发 captureVisibleTab、结果通道
content/selector.js  拖拽 / 单击范围选择覆盖层
content/capture.js   滚动容器识别、连续匀速滚动（rAF ≈520px/秒）、懒加载等待、
                     低置信接缝自动重截（最多两次）、补偿跳变检测、悬浮元素三重检测、
                     DOM 锚点追踪
content/stitch.js    接缝决策：DOM 锚点 → 像素校验 → ±80% 帧高搜索（只比对"有纹理的行"，
                     video/canvas 列掩码跳过动态像素）
content/hud.js       进度条 / 结果通道
viewer.html/js       新标签页查看器（适应宽度 / 原始大小 / 下载 / 复制）
```

**DOM 锚点 / DOM anchor**（反撕裂的核心）：每帧截完后记住"输出底边那个像素属于页面里哪个元素的哪个位置"，下一帧直接读该元素的新坐标算出接缝行——内容中途长高被自动吸收，与旧内容相似的新内容无法干扰对齐。锚点被虚拟化卸载时才回退到滚动推算与像素比对。

## 开发与测试 / Development & testing

```bash
cd tests
node stitch.test.js        # 拼接算法单测（Node，无依赖）/ stitching unit tests
cd e2e && npm install
node run.mjs               # 7 个端到端用例 / 7 E2E cases（自带重复/爬行/底栏/低置信断言）
node verify_rows.mjs e.png # 程序化行序校验 / programmatic row-order verification
node slice.mjs <case>      # 切片目检 / slice tall outputs for inspection
```

E2E 通过 CDP 截图桥接模拟 `captureVisibleTab`（Chrome 137+ 的 headless 不再支持
`--load-extension`），内容脚本注入页面主世界执行；fixtures 完整复现真实站点的
破坏性场景。The E2E harness bridges CDP screenshots to simulate `captureVisibleTab`
and injects the content scripts into the page's main world; the fixtures reproduce
every destructive behavior observed on real sites.

## License

MIT
