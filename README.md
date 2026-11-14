<div align="center">

**English** | [简体中文](README.zh-CN.md)

# NT Longshot

**Scrolling long-screenshot extension for Chrome/Edge — drag a region, glide down, pixel-perfect stitching.**

A scrolling long-screenshot extension designed for **modern dynamic pages** — Twitter/X, Discord, Weibo, Bilibili, YouTube — the exact sites that break nearly every mainstream capture extension.

[Download v0.2.0](https://github.com/nt-cubic/NT-Longshot/releases/latest) · [How it works](#how-it-works) · [Install](#install)

</div>

---

## Why another one?

The mainstream tools (GoFullPage, FireShot, …) are built on a 2010s assumption: *scroll by exact scrollY → capture → concatenate*. Every modern-page technique listed below breaks that assumption. NT Longshot rebuilds the pipeline around them:

| Dynamic-page pitfall | Mainstream behavior | NT Longshot |
|---|---|---|
| Virtualized lists (Twitter timeline, Discord channels): scrolled-away messages are unmounted | Misaligned, missing, duplicated output | DOM anchor tracking + per-frame telemetry |
| Cards / quoted tweets expand asynchronously, growing content mid-capture | Entire messages duplicated | Anchors absorb the shift; low-confidence seams are re-captured automatically |
| Player pixels change every frame (Bilibili/YouTube) | Matching never converges, stuck on "waiting for stability" | video/canvas column mask — player columns are excluded from matching |
| `absolute`-positioned overlays like Discord's "Jump to present" bar | Bar stamped across the whole screenshot | Triple overlay detection (static + behavioral + shape), piercing Shadow DOM |
| Lazy images not loaded yet | Big gray placeholders | Per-frame settle wait (DOM quiet + images complete), auto re-capture on low confidence |

## Features

- **Drag** a region, or **single-click** to capture the scroll container under the cursor
- **Continuous constant-velocity scrolling** (~520 px/s), like scrolling on a phone
- Infinite feeds are detected and followed automatically; `Esc` stops anytime and keeps what was captured
- On finish, a **new tab opens with the full-size image**: fit-width / 1:1 toggle, PNG download (system "Save as" dialog), copy to clipboard
- Floating elements (headers, sidebars, bars) are hidden automatically and stamped once at their first-frame position
- Full-resolution PNG output with devicePixelRatio handling

## Install

1. Clone this repo, or download the [latest release zip](https://github.com/nt-cubic/NT-Longshot/releases/latest)
2. Open `chrome://extensions` (Edge: `edge://extensions`)
3. Enable Developer mode → *Load unpacked* → select the `extension/` folder
4. Pin it to the toolbar; default shortcut is `Alt+Shift+S`

## Usage

1. Click the toolbar icon (or press the shortcut)
2. **Drag** a region; or **click** somewhere to capture its scroll container (in Discord, click the message area)
3. The extension glides down and stitches frames; press `Esc` anytime to stop and keep the result
4. A new tab opens automatically: view, download PNG (choose location), copy to clipboard

**Region semantics**: the left/right/top edges define the output origin and width; content flows
through the window until the end of the scroll container (infinite feeds are followed via probing).

## Known limitations

- Video regions are frozen at the moment of capture (true for every scroll-capture tool)
- Horizontal scrolling pages are not supported
- Very tall captures are bounded by Chrome's canvas area limit (~16384² px); oversized output is scaled down automatically

## How it works

```
background.js        service worker: injects scripts, relays per-frame captureVisibleTab, result channel
content/selector.js  drag / single-click region selection overlay
content/capture.js   scroll-container detection, constant-velocity glide (rAF ≈520px/s),
                     lazy-load settle, auto re-capture of low-confidence seams (up to twice),
                     compensation-jump detection, triple overlay detection, DOM anchor tracking
content/stitch.js    seam decision: DOM anchor → pixel verification → ±80% frame-height search
                     (texture rows only; video/canvas column mask skips dynamic pixels)
content/hud.js       progress HUD / result channel
viewer.html/js       result viewer tab (fit-width / 1:1 / download / copy)
```

**DOM anchor** — the core anti-tearing mechanism: after each frame, remember *which DOM element and which offset within it* the "output bottom pixel" belongs to; on the next frame, read that element's new position to compute the seam row exactly. Content that grows mid-capture is absorbed automatically, and look-alike content can never fool the alignment. Only when the anchor element is unmounted by virtualization does the pipeline fall back to scroll math and pixel matching.

Floating elements (`fixed` / `sticky` / viewport-stable `absolute`) are detected with three strategies — static, behavioral (page scrolled but the element didn't move), and shape (bottom-anchored wide bar) — piercing Shadow DOM; they are hidden during capture and stamped once at their first-frame position.

## Development & testing

```bash
cd tests
node stitch.test.js        # stitching unit tests (Node, no dependencies)
cd e2e && npm install
node run.mjs               # 7 E2E cases with built-in duplication/crawl/overlay/low-confidence assertions
node verify_rows.mjs e.png # programmatic row-order verification
node slice.mjs <case>      # slice tall outputs for inspection
```

The E2E harness bridges CDP screenshots to simulate `captureVisibleTab` (headless Chrome 137+ no longer supports `--load-extension`) and injects the content scripts into the page's main world. The fixtures reproduce every destructive behavior observed on real sites: virtualized infinite lists, history preloading with scroll compensation, `absolute` bottom bars, and rAF-noise canvas "players".

## License

MIT
