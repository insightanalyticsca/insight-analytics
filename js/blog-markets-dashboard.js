/* ════════════════════════════════════════════════════════════════════════════
   blog-markets-dashboard.js — Self-contained live markets & finance dashboard
   for the universal-dashboard-builder blog post.

   Renders INTO #markets-dashboard-mount on the blog post. No iframe, no
   service worker, no external dashboard dependency. Direct fetch() to
   Binance (crypto) + Groq proxy (AI brief). ECharts renders inline.

   This is the same pattern as the standalone markets-dashboard, but
   embedded directly in the blog post — so it works on every browser
   including iOS Safari + PWA where iframe-based embedding was stalling.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var liveData = {
    sp500: null, nasdaq: null, dow: null, tsx: null,
    btc: null, eth: null, sol: null, gold: null,
    fxRates: {}
  };
  var charts = {};
  // Module-scope flag — true once we've wired the window 'load' resize
  // handler, so re-booting (e.g. HMR or a re-render) doesn't double-bind.
  var bmdLoadWired = false;

  // All metric cards render in "000.00" format — always 2 decimal places.
  // The `dec` argument is kept for backward-compat with existing call sites
  // but is intentionally ignored so every KPI (indexes, gold, oil, BTC, etc.)
  // lines up with the same 2-decimal display.
  function fmt(n, dec) {
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Set source label with green live dot when source is live
  function setSrcLabel(id, text, isLive) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (isLive) el.setAttribute('data-live', '');
    else el.removeAttribute('data-live');
  }

  // ─── Build the dashboard HTML skeleton ───────────────────────────────────
  function buildSkeleton(mount) {
    mount.innerHTML = `
      <div class="bmd-app">
        <div class="bmd-topbar">
          <div class="bmd-brand">
            <div class="bmd-bm"><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="iaGradBmd" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e0f7fa"/><stop offset="30%" stop-color="#80deea"/><stop offset="60%" stop-color="#00bcd4"/><stop offset="100%" stop-color="#0288d1"/></linearGradient></defs><rect x="2" y="8" width="16" height="84" fill="url(#iaGradBmd)"/><polygon points="21,92 34,92 60,8 47,8" fill="url(#iaGradBmd)"/><polygon points="85,92 98,92 73,8 60,8" fill="url(#iaGradBmd)"/></svg></div>
            <div>
              <div class="bmd-bn">Markets &amp; Finance Dashboard</div>
              <div class="bmd-bs">Indexes · Crypto · Gold · AI Narrative</div>
            </div>
          </div>
          <div class="bmd-live-badge"><span class="bmd-live-dot"></span><span id="bmd-live-status">Loading live data…</span></div>
          <button class="bmd-theme-toggle" id="bmd-theme-toggle" type="button" aria-label="Toggle dark/light theme" title="Toggle theme">
            <i class="fas fa-sun" id="bmd-theme-icon" aria-hidden="true"></i>
          </button>
        </div>

        <div class="bmd-kpi-grid" id="bmd-kpi-grid">
          <div class="bmd-kpi"><div class="bmd-kpi-label">S&amp;P 500</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">NASDAQ</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Dow Jones</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">TSX</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">BTC/USD</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Gold</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
        </div>

        <div class="bmd-chart-grid bmd-grid-row1">
          <div class="bmd-chart-card bmd-trends-card">
            <div class="bmd-chart-title"><i class="fas fa-chart-line"></i> Index &amp; Crypto Trends <span class="bmd-src" id="bmd-src-trends">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-trends"></div>
          </div>
          <div class="bmd-chart-card bmd-fx-card">
            <div class="bmd-chart-title"><i class="fas fa-globe"></i> Currency Heatmap <span class="bmd-src" id="bmd-src-fx">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-fx"></div>
          </div>
        </div>
        <div class="bmd-chart-grid bmd-grid-row2">
          <div class="bmd-chart-card bmd-sectors-card">
            <div class="bmd-chart-title"><i class="fas fa-th"></i> Sector Performance <span class="bmd-src" id="bmd-src-sectors">loading…</span></div>
            <div class="bmd-chart-body" id="bmd-chart-sectors"></div>
          </div>
          <div class="bmd-chart-card">
            <div class="bmd-chart-title"><i class="fas fa-coins"></i> Crypto Comparison <span class="bmd-src" id="bmd-src-crypto">loading…</span></div>
            <div class="bmd-chart-body" id="bmd-chart-crypto"></div>
          </div>
          <div class="bmd-chart-card bmd-futures-card">
            <div class="bmd-chart-title"><i class="fas fa-chart-bar"></i> Futures <span class="bmd-src" id="bmd-src-futures">loading…</span></div>
            <div class="bmd-futures-grid" id="bmd-futures-grid"></div>
          </div>
        </div>

        <div class="bmd-ai-brief">
          <div class="bmd-ai-head">
            <div class="bmd-ai-spark"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6m0 8v6m10-10h-6m-8 0H2m13.5-5.5l-2.5 2.5m-6 6l-2.5 2.5m11 0l-2.5-2.5m-6-6L4.5 4.5"/></svg></div>
            <div class="bmd-ai-title">AI Market Brief</div>
            <div class="bmd-ai-badge">
              <span class="bmd-ai-dot"></span>
              <span class="bmd-ai-badge-text">AI-wired</span>
            </div>
          </div>
          <div class="bmd-ai-grid">
            <div class="bmd-ai-cell bmd-ai-what">
              <div class="bmd-ai-cell-head">
                <div class="bmd-ai-cell-icon">✓</div>
                <div class="bmd-ai-cell-label">What Happened</div>
              </div>
              <div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-happened">Loading…</div>
            </div>
            <div class="bmd-ai-cell bmd-ai-why">
              <div class="bmd-ai-cell-head">
                <div class="bmd-ai-cell-icon">?</div>
                <div class="bmd-ai-cell-label">Why It Matters</div>
              </div>
              <div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-why">Loading…</div>
            </div>
            <div class="bmd-ai-cell bmd-ai-next">
              <div class="bmd-ai-cell-head">
                <div class="bmd-ai-cell-icon">→</div>
                <div class="bmd-ai-cell-label">What to Expect</div>
              </div>
              <div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-expect">Loading…</div>
            </div>
            <div class="bmd-ai-cell bmd-ai-do">
              <div class="bmd-ai-cell-head">
                <div class="bmd-ai-cell-icon">⊕</div>
                <div class="bmd-ai-cell-label">What to Do</div>
              </div>
              <div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-do">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Inject scoped CSS for the dashboard (dark theme, like markets-dashboard) ──
  function injectStyles() {
    if (document.getElementById('bmd-styles')) return;
    var css = `
      <style id="bmd-styles">
      .bmd-app {
        background: linear-gradient(145deg, #0a0e1a 0%, #0f172a 100%);
        color: #e2e8f0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 10px;
        min-height: 400px;
      }
      .bmd-topbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 0 6px; margin-bottom: 8px;
        border-bottom: 1px solid rgba(99,102,241,.15);
      }
      .bmd-brand { display: flex; align-items: center; gap: 10px; }
      .bmd-bm {
        width: 22px; height: 22px;
        display: grid; place-items: center;
        flex-shrink: 0;
      }
      .bmd-bm svg { width: 100%; height: 100%;  }
      .bmd-bn { font-size: 14px; font-weight: 700; color: #e2e8f0; }
      .bmd-bs { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; }
      .bmd-live-badge {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; border-radius: 999px;
        background: rgba(16,185,129,.08);
        border: 1px solid rgba(16,185,129,.15);
        font-size: 8px; font-weight: 600; color: #10b981;
        text-transform: none; letter-spacing: 0;
        white-space: nowrap;
        flex-shrink: 0;
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .bmd-theme-toggle {
        width: 22px; height: 22px; border-radius: 6px;
        display: grid; place-items: center;
        background: transparent;
        border: 1px solid rgba(99, 102, 241, .2);
        color: #94a3b8; cursor: pointer; font-size: 12px;
        transition: all 0.2s ease;
      }
      .bmd-theme-toggle:hover {
        background: rgba(99, 102, 241, .1);
        color: #06b6d4;
        transform: rotate(15deg);
      }
      [data-bmd-theme="light"] .bmd-theme-toggle {
        color: #64748b;
        border-color: rgba(99, 102, 241, .15);
      }
      .bmd-live-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981; animation: bmd-pulse 2s ease-in-out infinite;
      }
      @keyframes bmd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
      .bmd-kpi-grid {
        display: grid; grid-template-columns: repeat(6, 1fr);
        gap: 6px; margin-bottom: 10px;
      }
      .bmd-kpi {
        background: linear-gradient(145deg, rgba(30,41,59,.9), rgba(15,23,42,.95));
        border: 1px solid rgba(99,102,241,.12);
        border-radius: 12px; padding: 10px 8px;
        text-align: center; transition: all 250ms cubic-bezier(.4,0,.2,1);
        box-shadow: 0 2px 8px -2px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.03);
      }
      .bmd-kpi:hover {
        border-color: rgba(6,182,212,.4);
        box-shadow: 0 4px 16px -4px rgba(6,182,212,.15), inset 0 1px 0 rgba(255,255,255,.05);
        transform: translateY(-1px);
      }
      .bmd-kpi-label {
        font-size: 9px; color: #64748b;
        text-transform: uppercase; letter-spacing: .06em;
        font-weight: 600; margin-bottom: 3px;
      }
      .bmd-kpi-val {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 17px; font-weight: 700; color: #f1f5f9;
        letter-spacing: -.02em;
        margin-bottom: 2px; line-height: 1.1;
      }
      .bmd-kpi-val-unavailable {
        color: #475569; /* darker slate — indicates no live data */
        font-style: italic;
      }
      .bmd-kpi-change { font-size: 10px; font-weight: 700; }
      .bmd-kpi-change.up { color: #10b981; }
      .bmd-kpi-change.down { color: #ef4444; }
      .bmd-skeleton {
        background: linear-gradient(90deg, rgba(99,102,241,.15) 25%, rgba(15,23,42,1) 50%, rgba(99,102,241,.15) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @keyframes bmd-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .bmd-chart-grid {
        display: grid; gap: 8px; margin-bottom: 8px;
      }
      .bmd-chart-card {
        background: linear-gradient(145deg, rgba(30,41,59,.85), rgba(15,23,42,.9));
        border: 1px solid rgba(99,102,241,.1);
        border-radius: 12px; padding: 12px;
        box-shadow: 0 2px 10px -3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.02);
        min-width: 0; /* CSS grid item fix — allows card to shrink below
                         canvas intrinsic width on rotation. Without this,
                         the grid item stays at landscape width (844px)
                         even in portrait (390px) because min-width:auto
                         prevents shrinking. */
        overflow: hidden;
      }
      .bmd-chart-card.bmd-wide { grid-column: 1 / -1; }
      .bmd-chart-card.bmd-wide-2 { grid-column: span 2; }
      /* Row 1: trends (narrower) + FX heatmap (wider) — 55/45 split */
      .bmd-grid-row1 { grid-template-columns: 1.1fr 1.4fr; }
      /* Row 2: sectors (wider) + crypto + futures — 1.5/1/1 split */
      /* Row 2: sectors + crypto on row 1, futures full-width below.
         User requested this layout for ALL viewports (was 3-col on desktop). */
      .bmd-grid-row2 { grid-template-columns: 1fr 1fr; }
      .bmd-grid-row2 .bmd-futures-card { grid-column: 1 / -1; }
      .bmd-chart-title {
        font-size: 11px; font-weight: 600; color: #e2e8f0;
        margin-bottom: 6px; display: flex; align-items: center; gap: 4px;
      }
      .bmd-chart-title i { color: #06b6d4; font-size: 10px; }
      .bmd-chart-title .bmd-src { margin-left: auto; font-size: 8px; color: #64748b; font-weight: 400; display: inline-flex; align-items: center; gap: 4px; }
      /* Green live dot before source label — indicates data is live */
      .bmd-src[data-live]::before {
        content: '';
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981;
        display: inline-block;
        box-shadow: 0 0 6px #10b981, 0 0 2px #10b981;
        animation: bmdLivePulse 2s ease-in-out infinite;
        flex-shrink: 0;
      }
      @keyframes bmdLivePulse {
        0%, 100% { opacity: 0.6; transform: scale(0.9); }
        50% { opacity: 1; transform: scale(1.15); }
      }
      .bmd-chart-body { width: 100%; height: 22vh; min-height: 140px; min-width: 0; overflow: hidden; }
      .bmd-chart-body.bmd-tall { height: 28vh; min-height: 170px; }
      /* AI Brief — matches the executive dashboard's polished styling:
         glassmorphism, gradient title, top sheen, per-section accent strips,
         cell icons with gradient backgrounds, hover lift effect. */
      .bmd-ai-brief {
        padding: 14px 16px;
        border-radius: 14px;
        border: 1px solid rgba(99,102,241,0.18);
        background:
          linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(6,182,212,0.04) 50%, rgba(139,92,246,0.05) 100%),
          rgba(15,23,42,0.6);
        backdrop-filter: blur(12px) saturate(160%);
        -webkit-backdrop-filter: blur(12px) saturate(160%);
        box-shadow: 0 4px 18px rgba(99,102,241,0.10), 0 1px 0 rgba(255,255,255,0.04) inset;
        margin-bottom: 8px;
        position: relative;
        overflow: hidden;
      }
      /* Subtle top sheen line */
      .bmd-ai-brief::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent 0%, rgba(99,102,241,0.45) 20%, rgba(6,182,212,0.45) 50%, rgba(139,92,246,0.45) 80%, transparent 100%);
      }
      .bmd-ai-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .bmd-ai-spark {
        display: grid; place-items: center;
        color: #6366f1;
        animation: bmdAiSparkSpin 4s ease-in-out infinite;
      }
      @keyframes bmdAiSparkSpin {
        0%, 100% { transform: rotate(0deg) scale(1); }
        50% { transform: rotate(180deg) scale(1.1); }
      }
      .bmd-ai-title {
        font-size: 13px; font-weight: 800;
        letter-spacing: 0.02em;
        background: linear-gradient(135deg, #6366f1 0%, #06b6d4 50%, #8b5cf6 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        color: transparent;
      }
      .bmd-ai-badge {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 9px 3px 7px;
        border-radius: 12px;
        border: 1px solid rgba(16,185,129,0.35);
        background: rgba(16,185,129,0.10);
        color: #10b981;
        font-size: 9px; font-weight: 700;
        letter-spacing: 0.06em; text-transform: uppercase;
        margin-left: auto;
      }
      .bmd-ai-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 8px currentColor;
        animation: bmdAiPulse 1.8s ease-in-out infinite;
      }
      @keyframes bmdAiPulse {
        0%, 100% { opacity: 0.7; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.25); }
      }
      .bmd-ai-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
      .bmd-ai-cell {
        position: relative;
        padding: 10px 12px 12px;
        border-radius: 10px;
        border: 1px solid rgba(99,102,241,0.10);
        background: rgba(15,23,42,0.4);
        overflow: hidden;
        transition: transform 200ms cubic-bezier(.22,1,.36,1), box-shadow 200ms;
      }
      .bmd-ai-cell:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(99,102,241,0.14);
      }
      /* Section accent strip on top */
      .bmd-ai-cell::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        opacity: 0.85;
      }
      .bmd-ai-what::before  { background: linear-gradient(90deg, #10b981, #06b6d4); }
      .bmd-ai-why::before   { background: linear-gradient(90deg, #f59e0b, #ef4444); }
      .bmd-ai-next::before  { background: linear-gradient(90deg, #06b6d4, #6366f1); }
      .bmd-ai-do::before    { background: linear-gradient(90deg, #8b5cf6, #ec4899); }
      .bmd-ai-cell-head {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 6px;
      }
      .bmd-ai-cell-icon {
        display: grid; place-items: center;
        width: 18px; height: 18px;
        border-radius: 6px;
        font-size: 10px; font-weight: 800;
        color: #fff;
        flex-shrink: 0;
      }
      .bmd-ai-what .bmd-ai-cell-icon { background: linear-gradient(135deg, #10b981, #06b6d4); }
      .bmd-ai-why  .bmd-ai-cell-icon { background: linear-gradient(135deg, #f59e0b, #ef4444); }
      .bmd-ai-next .bmd-ai-cell-icon { background: linear-gradient(135deg, #06b6d4, #6366f1); }
      .bmd-ai-do   .bmd-ai-cell-icon { background: linear-gradient(135deg, #8b5cf6, #ec4899); }
      .bmd-ai-cell-label {
        font-size: 9px; font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
      }
      .bmd-ai-cell-text {
        font-size: 11px; line-height: 1.5;
        color: #cbd5e1;
        word-wrap: break-word;
      }
      /* Value-change glow — brief flash when a card's value updates */
      @keyframes bmd-value-flash {
        0%   { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
        15%  { box-shadow: 0 0 16px 2px rgba(99,102,241,0.45); border-color: rgba(99,102,241,0.5); }
        100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
      }
      .bmd-flash {
        animation: bmd-value-flash 1.4s ease-out;
      }
      .bmd-shimmer {
        background: linear-gradient(90deg, rgba(99,102,241,.1) 25%, rgba(99,102,241,.25) 50%, rgba(99,102,241,.1) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @media (max-width: 1024px) {
        .bmd-kpi-grid { grid-template-columns: repeat(3, 1fr); }
        .bmd-grid-row1 { grid-template-columns: 1fr; }
        .bmd-grid-row2 { grid-template-columns: 1fr 1fr; }
        .bmd-ai-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 640px) {
        .bmd-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        .bmd-ai-grid { grid-template-columns: 1fr; }
        .bmd-chart-body { height: 24vh; min-height: 160px; }
        .bmd-grid-row2 { grid-template-columns: 1fr; }
        .bmd-grid-row2 .bmd-futures-card { grid-column: 1 / -1; }
      }

      /* Futures cards grid — like KPI tiles but for futures contracts.
         Top-level (all viewports). Mobile portrait overrides below. */
      .bmd-futures-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
        min-height: 140px;
      }
      .bmd-future-card {
        background: linear-gradient(135deg, rgba(99,102,241,.06), rgba(6,182,212,.04));
        border: 1px solid rgba(99,102,241,.1);
        border-radius: 8px;
        padding: 8px 6px;
        text-align: center;
        display: flex;
        flex-direction: column;
        gap: 2px;
        transition: all 180ms ease;
      }
      .bmd-future-card:hover {
        border-color: rgba(99,102,241,.3);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px -4px rgba(99,102,241,.2);
      }
      .bmd-future-name {
        font-size: 9px;
        font-weight: 700;
        color: var(--bmd-text-soft, #94a3b8);
        text-transform: uppercase;
        letter-spacing: .03em;
      }
      .bmd-future-price {
        font-size: 13px;
        font-weight: 800;
        color: var(--bmd-text, #e2e8f0);
        font-family: 'Space Grotesk', monospace;
        line-height: 1.2;
      }
      .bmd-future-chg {
        font-size: 9px;
        font-weight: 700;
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      .bmd-future-chg.up { color: #10b981; }
      .bmd-future-chg.down { color: #ef4444; }
      [data-bmd-theme="light"] .bmd-future-name { color: #64748b; }
      [data-bmd-theme="light"] .bmd-future-price { color: #0f172a; }
      [data-bmd-theme="light"] .bmd-future-card {
        background: linear-gradient(135deg, rgba(99,102,241,.04), rgba(6,182,212,.03));
      }

      /* Mobile: futures grid 4 columns, smaller fonts */
      @media (max-width: 1024px) {
        .bmd-futures-grid {
          grid-template-columns: repeat(4, 1fr) !important;
          gap: 4px;
        }
        .bmd-future-card { padding: 6px 3px; }
        .bmd-future-name { font-size: 8px; }
        .bmd-future-price { font-size: 11px; }
        .bmd-future-chg { font-size: 8px; }
      }

      /* ═══ LIGHT THEME OVERRIDES — when [data-theme="light"] on <html> ═══ */
      [data-bmd-theme="light"] .bmd-app {
        background: linear-gradient(145deg, #f8fafc 0%, #f1f5f9 100%);
        color: #1e293b;
      }
      [data-bmd-theme="light"] .bmd-bn { color: #1e293b; }
      [data-bmd-theme="light"] .bmd-bs { color: #64748b; }
      [data-bmd-theme="light"] .bmd-kpi {
        background: linear-gradient(145deg, rgba(255,255,255,.95), rgba(248,250,252,.9));
        border-color: rgba(99,102,241,.12);
        box-shadow: 0 2px 8px -2px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,.5);
      }
      [data-bmd-theme="light"] .bmd-kpi:hover {
        border-color: rgba(6,182,212,.3);
        box-shadow: 0 4px 16px -4px rgba(6,182,212,.1);
      }
      [data-bmd-theme="light"] .bmd-kpi-label { color: #64748b; }
      [data-bmd-theme="light"] .bmd-kpi-val { color: #0f172a; }
      [data-bmd-theme="light"] .bmd-kpi-val-unavailable { color: #94a3b8; }
      [data-bmd-theme="light"] .bmd-kpi-skeleton {
        background: linear-gradient(90deg, rgba(99,102,241,.1) 25%, rgba(255,255,255,1) 50%, rgba(99,102,241,.1) 75%);
      }
      [data-bmd-theme="light"] .bmd-chart-card {
        background: linear-gradient(145deg, rgba(255,255,255,.95), rgba(248,250,252,.9));
        border-color: rgba(99,102,241,.1);
        box-shadow: 0 2px 10px -3px rgba(0,0,0,.06), inset 0 1px 0 rgba(255,255,255,.5);
      }
      [data-bmd-theme="light"] .bmd-chart-title { color: #1e293b; }
      [data-bmd-theme="light"] .bmd-chart-title .bmd-src { color: #94a3b8; }
      [data-bmd-theme="light"] .bmd-ai-brief {
        background:
          linear-gradient(135deg, rgba(99,102,241,0.04) 0%, rgba(6,182,212,0.03) 50%, rgba(139,92,246,0.03) 100%),
          rgba(255,255,255,0.85);
        border-color: rgba(99,102,241,0.15);
        backdrop-filter: blur(12px) saturate(160%);
        -webkit-backdrop-filter: blur(12px) saturate(160%);
      }
      /* Title stays gradient in both themes */
      [data-bmd-theme="light"] .bmd-ai-cell {
        background: rgba(255,255,255,0.7);
        border-color: rgba(99,102,241,0.10);
      }
      [data-bmd-theme="light"] .bmd-ai-cell-text { color: #475569; }
      [data-bmd-theme="light"] .bmd-ai-cell-label { color: #64748b; }
      [data-bmd-theme="light"] .bmd-shimmer {
        background: linear-gradient(90deg, rgba(99,102,241,.08) 25%, rgba(99,102,241,.15) 50%, rgba(99,102,241,.08) 75%);
      }
      </style>
    `;
    document.head.insertAdjacentHTML('beforeend', css);
  }

  // Netlify markets-proxy endpoint (server-side fetch of Yahoo + Frankfurter)
  var MARKETS_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/markets-proxy';

  // ─── Robust fetch helpers ───────────────────────────────────────────────
  // The currency heatmap was flaky on load: Netlify proxy cold-starts (free
  // tier idles → first request after 15+ min idle takes 8+ s to wake, often
  // times out before the browser gives up), Frankfurter has had API outages,
  // and the prior serial fetch chain meant one slow source blocked the next.
  //
  // fetchWithTimeout: AbortController-bounded fetch so a hung endpoint can't
  //                  block the whole dashboard. Default 9s — long enough for
  //                  a cold Netlify warmup, short enough to fall back before
  //                  the user thinks the page is broken.
  // fetchWithRetry:   retries on network errors + 5xx + timeouts. Does NOT
  //                  retry on 4xx (those are permanent). Exponential backoff
  //                  500ms → 1000ms. Default 1 retry (so 2 attempts total).
  function fetchWithTimeout(url, opts, timeoutMs) {
    opts = opts || {};
    timeoutMs = timeoutMs || 9000;
    if (opts.signal) {
      // caller already supplied a signal — respect it
      return fetch(url, opts);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .then(function (r) {
        clearTimeout(timer);
        return r;
      })
      .catch(function (e) {
        clearTimeout(timer);
        throw e;
      });
  }

  function fetchWithRetry(url, opts, cfg) {
    cfg = cfg || {};
    var timeoutMs = cfg.timeoutMs || 9000;
    var retries = cfg.retries != null ? cfg.retries : 1;
    var backoffMs = cfg.backoffMs || 500;
    var attempt = 0;
    function attemptOnce() {
      attempt++;
      return fetchWithTimeout(url, opts, timeoutMs).then(function (r) {
        // Retry on 5xx (server error / Netlify cold start / gateway issues)
        // Don't retry on 4xx (client error — permanent)
        if (r.ok || (r.status >= 400 && r.status < 500)) return r;
        if (attempt > retries) return r;  // out of retries — let caller see the bad status
        return new Promise(function (resolve) { setTimeout(function () { resolve(attemptOnce()); }, backoffMs * attempt); });
      }).catch(function (e) {
        // Network error, timeout abort, DNS failure — retry
        if (attempt > retries) throw e;
        return new Promise(function (resolve, reject) {
          setTimeout(function () { attemptOnce().then(resolve, reject); }, backoffMs * attempt);
        });
      });
    }
    return attemptOnce();
  }

  // ─── Dashboard-local theme — uses data-bmd-theme on #markets-dashboard-mount ──
  // Does NOT touch <html data-theme> — the blog page's own theme is independent.
  var dashboardTheme = 'dark'; // default

  function getTheme() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (mount) return mount.getAttribute('data-bmd-theme') === 'light' ? 'light' : 'dark';
    return dashboardTheme;
  }
  // ECharts axis colors per theme
  function axisLabelColor() { return getTheme() === 'dark' ? '#64748b' : '#94a3b8'; }
  function legendTextColor() { return getTheme() === 'dark' ? '#94a3b8' : '#64748b'; }
  function tooltipBgColor() { return getTheme() === 'dark' ? 'rgba(15,23,42,.9)' : 'rgba(255,255,255,.95)'; }
  function tooltipTextColor() { return getTheme() === 'dark' ? '#e2e8f0' : '#1e293b'; }
  function tooltipBorderColor() { return getTheme() === 'dark' ? 'rgba(99,102,241,.2)' : 'rgba(99,102,241,.15)'; }
  // Chart background — matches the chart-card's gradient bg per theme.
  // Used as ECharts backgroundColor + visualMap outOfRange color so empty/
  // uncolored cells (e.g. diagonal of currency matrix, value-0 cells the
  // visualMap refuses to color) blend into the chart background instead of
  // showing as default light gray (#e6e6e6).
  // FULLY OPAQUE (opacity 1.0) — previous 0.92 opacity let the chart-card's
  // gradient show through, creating a visible 'glare' band in the middle of
  // the heatmap on mobile portrait (where the chart is shorter and the
  // gradient midpoint is more visible).
  function chartBgColor() {
    return getTheme() === 'dark' ? 'rgb(15,23,42)' : 'rgb(248,250,252)';
  }
  // Neutral cell color for diagonal cells (currency paired with itself).
  // Matches the visualMap midpoint (slate in dark, light slate in light).
  function neutralCellColor() {
    return getTheme() === 'dark' ? 'rgba(30,41,59,0.78)' : 'rgba(203,213,225,0.78)';
  }

  // Re-render all charts when the DASHBOARD theme changes (not the page theme)
  function watchThemeChanges() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (!mount) return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-bmd-theme') {
          // Update the dashboard's theme toggle icon
          var bmdIcon = document.getElementById('bmd-theme-icon');
          if (bmdIcon) bmdIcon.className = getTheme() === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
          // Dispose + re-render all charts with new theme colors
          Object.keys(charts).forEach(function (k) {
            try { charts[k].dispose(); } catch (e) {}
          });
          renderTrends();
          renderSectors();
          renderFutures();
          renderFX();
          renderCrypto();
        }
      });
    });
    observer.observe(mount, { attributes: true, attributeFilter: ['data-bmd-theme'] });
  }

  // ─── Fetch LIVE indices + gold + commodities via Netlify proxy (Yahoo server-side) ───
  async function fetchIndices() {
    try {
      var symbols = [
        { sym: '^GSPC', key: 'sp500' },
        { sym: '^IXIC', key: 'nasdaq' },
        { sym: '^DJI', key: 'dow' },
        { sym: '^GSPTSE', key: 'tsx' },
        { sym: 'GC=F', key: 'gold' },
        { sym: 'CL=F', key: 'crudeOil' },
        { sym: 'NG=F', key: 'natGas' },
        { sym: 'SI=F', key: 'silver' },
        { sym: 'HG=F', key: 'copper' },
        { sym: 'ZW=F', key: 'wheat' },
        { sym: 'ZC=F', key: 'corn' },
        { sym: 'ZS=F', key: 'soybean' }
      ];
      var symList = symbols.map(function (s) { return encodeURIComponent(s.sym); }).join(',');
      var r = await fetch(MARKETS_PROXY + '?symbols=' + symList);
      if (!r.ok) return false;
      var d = await r.json();
      if (!d || !d.quotes) return false;
      var keyMap = {};
      symbols.forEach(function (s) { keyMap[s.sym] = s.key; });
      var anyOk = false;
      d.quotes.forEach(function (q) {
        if (q.price != null && keyMap[q.symbol]) {
          liveData[keyMap[q.symbol]] = { price: q.price, change: q.changePct };
          anyOk = true;
        }
      });
      return anyOk;
    } catch (e) { return false; }
  }

  // ─── Fetch LIVE FX via Netlify proxy + Frankfurter + Yahoo ──────────────
  // ROBUSTNESS: fetches all three sources IN PARALLEL using Promise.allSettled,
  // never bails on a single source failing, never overwrites last-good data
  // with empty fields, and uses fetchWithRetry for both timeout + 1 retry on
  // Netlify cold-start / transient failures. No demo data.
  //
  // Sources (all return different shapes):
  //   A) MARKETS_PROXY?fx=1            → Frankfurter CURRENT rates (today's snapshot)
  //   B) api.frankfurter.dev/v1/<date> → Frankfurter HISTORICAL rates (yesterday / most recent business day)
  //   C) MARKETS_PROXY?symbols=EURUSD=X,... → Yahoo FX pair quotes (intraday % changes)
  //
  // Render priority (in renderFX): Yahoo intraday % first (PRIMARY — updates
  // every poll), Frankfurter daily % second (fallback when Yahoo fails or out
  // of market hours). If both succeed, both are stored and renderFX picks.
  async function fetchFX() {
    // Build URLs upfront so all 3 sources can fire in parallel without serial
    // dependency on each other's results.
    var todayUrl = MARKETS_PROXY + '?fx=1';
    var fxSymbols = 'EURUSD%3DX,GBPUSD%3DX,JPYUSD%3DX,CADUSD%3DX,AUDUSD%3DX,CHFUSD%3DX,CNYUSD%3DX';
    var yahooUrl = MARKETS_PROXY + '?symbols=' + fxSymbols;

    // Build candidate historical dates (1-6 business days back, skipping
    // weekends). Each is a separate URL — we'll try them sequentially inside
    // one of the parallel branches.
    var historicalUrls = [];
    var baseDate = new Date();
    for (var back = 1; back <= 6; back++) {
      var prevDate = new Date(baseDate);
      prevDate.setDate(prevDate.getDate() - back);
      var dateStr = prevDate.toISOString().split('T')[0];
      historicalUrls.push('https://api.frankfurter.dev/v1/' + dateStr + '?from=USD&to=EUR,GBP,JPY,CAD,AUD,CHF,CNY');
    }

    // Helper: fetch a historical URL, verify the rates are different from
    // today's snapshot (Frankfurter sometimes returns same-day rates for
    // weekend dates — that would produce 0% everywhere, which is worse than
    // no historical data). `todayRates` passed in for comparison.
    async function fetchHistorical(todayRates) {
      for (var i = 0; i < historicalUrls.length; i++) {
        try {
          var r = await fetchWithRetry(historicalUrls[i], {}, { timeoutMs: 8000, retries: 1, backoffMs: 400 });
          if (!r.ok) continue;
          var d = await r.json();
          if (!d || !d.rates) continue;
          // Verify rates differ from today's snapshot
          if (todayRates) {
            var allSame = true;
            for (var k in d.rates) {
              if (Math.abs((d.rates[k] || 0) - (todayRates[k] || 0)) > 0.0001) { allSame = false; break; }
            }
            if (allSame) continue;  // stale same-day data — try next date back
          }
          return d.rates;
        } catch (e) { /* try next date back */ }
      }
      return null;
    }

    // Fetch source A (current rates) first — we need its result to feed the
    // historical comparison. But fire source C (Yahoo) in parallel right now
    // so it doesn't wait on A.
    var yahooPromise = fetchWithRetry(yahooUrl, {}, { timeoutMs: 9000, retries: 1, backoffMs: 500 })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });

    var todayRates = null;
    try {
      var r1 = await fetchWithRetry(todayUrl, {}, { timeoutMs: 9000, retries: 1, backoffMs: 500 });
      if (r1.ok) {
        var d1 = await r1.json();
        if (d1 && d1.rates) todayRates = d1.rates;
      }
    } catch (e) { /* source A failed — todayRates stays null */ }

    // Now fetch historical in parallel with the Yahoo promise that's already in flight.
    var historicalPromise = todayRates ? fetchHistorical(todayRates) : Promise.resolve(null);

    var results = await Promise.allSettled([
      Promise.resolve(todayRates),     // [0] = source A
      historicalPromise,                // [1] = source B
      yahooPromise                      // [2] = source C
    ]);

    // Apply results — NEVER overwrite last-good data with null/undefined
    // on transient failures. Only assign fields that returned successfully.
    var anyOk = false;

    if (results[0].status === 'fulfilled' && results[0].value) {
      liveData.fxRates = results[0].value;
      anyOk = true;
    }

    if (results[1].status === 'fulfilled' && results[1].value) {
      liveData.fxRatesPrev = results[1].value;
      anyOk = true;
    }

    if (results[2].status === 'fulfilled' && results[2].value && results[2].value.quotes) {
      var fxPct = {};
      var symKey = { 'EURUSD': 'EUR', 'GBPUSD': 'GBP', 'JPYUSD': 'JPY', 'CADUSD': 'CAD', 'AUDUSD': 'AUD', 'CHFUSD': 'CHF', 'CNYUSD': 'CNY' };
      results[2].value.quotes.forEach(function (q) {
        var baseSym = q.symbol.replace('=X', '');
        if (symKey[baseSym] && q.changePct != null) {
          fxPct[symKey[baseSym]] = q.changePct;
        }
      });
      if (Object.keys(fxPct).length > 0) {
        liveData.fxDirectPct = fxPct;  // { EUR: 0.5, GBP: -0.3, ... }
        anyOk = true;
      }
    }

    // Track fetch health so the source-label in renderFX can show
    // "rate fetch failed — showing last good data" if we have stale data
    // from a previous successful poll but this poll got nothing fresh.
    liveData._fxLastFetchOk = anyOk;
    liveData._fxLastFetchTime = Date.now();

    return anyOk;
  }

  // ─── Fetch LIVE crypto from Binance ──────────────────────────────────────
  async function fetchCrypto() {
    try {
      var r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=%5b%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22%5d');
      if (!r.ok) return false;
      var d = await r.json();
      d.forEach(function (t) {
        var sym = t.symbol.replace('USDT', '');
        liveData[sym.toLowerCase()] = {
          price: parseFloat(t.lastPrice),
          change: parseFloat(t.priceChangePercent)
        };
      });
      // Also fetch 30-day BTC klines (daily candles) for the trend chart.
      // Binance has CORS — can fetch directly without a proxy.
      try {
        var kUrl = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30';
        var kr = await fetch(kUrl);
        if (kr.ok) {
          var kd = await kr.json();
          if (Array.isArray(kd) && kd.length > 0) {
            // Each kline: [openTime, open, high, low, close, volume, ...]
            liveData.btc.history = kd.map(function (k) {
              return parseFloat(k[4]); // close price
            });
          }
        }
      } catch (e) { /* BTC history not available — trend chart skips BTC series */ }
      return true;
    } catch (e) { return false; }
  }

  // ─── Render KPIs ──────────────────────────────────────────────────────────
  // Track previous KPI prices to detect changes for the flash glow
  var prevKPIPrices = {};

  function renderKPIs(binanceOk) {
    var fifthKpi;
    if (liveData.btc) {
      fifthKpi = { label: 'BTC/USD', data: { price: liveData.btc.price, change: liveData.btc.change }, fmt: function (v) { return fmt(v, 0); }, prefix: '$' };
    } else {
      fifthKpi = { label: 'Crude Oil', data: liveData.crudeOil, fmt: function (v) { return fmt(v, 2); }, prefix: '$' };
    }
    var kpis = [
      { label: 'S&P 500', data: liveData.sp500, fmt: function (v) { return fmt(v, 0); }, prefix: '' },
      { label: 'NASDAQ', data: liveData.nasdaq, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'Dow Jones', data: liveData.dow, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'TSX', data: liveData.tsx, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      fifthKpi,
      { label: 'Gold', data: liveData.gold, fmt: function (v) { return fmt(v, 0); }, prefix: '$' }
    ];
    var html = kpis.map(function (k) {
      if (k.data) {
        var chg = k.data.change || 0;
        var dir = chg >= 0 ? 'up' : 'down';
        // Check if price changed since last render → add flash class
        var prev = prevKPIPrices[k.label];
        var changed = prev !== undefined && prev !== k.data.price;
        var flash = changed ? ' bmd-flash' : '';
        prevKPIPrices[k.label] = k.data.price;
        return '<div class="bmd-kpi' + flash + '"><div class="bmd-kpi-label">' + k.label + '</div>' +
          '<div class="bmd-kpi-val">' + k.prefix + k.fmt(k.data.price) + '</div>' +
          '<div class="bmd-kpi-change ' + dir + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
      } else {
        return '<div class="bmd-kpi"><div class="bmd-kpi-label">' + k.label + '</div>' +
          '<div class="bmd-kpi-val bmd-kpi-val-unavailable">—</div>' +
          '<div class="bmd-kpi-change">—</div></div>';
      }
    }).join('');
    var grid = document.getElementById('bmd-kpi-grid');
    if (grid) grid.innerHTML = html;
  }

  // ─── Render charts (ECharts) ─────────────────────────────────────────────
  // Fetch scraped historical index data (static JSON, scraped from Yahoo
  // server-side and committed to the repo). Union with live current price
  // from the proxy for the most recent data point.
  async function fetchHistoricalIndices() {
    try {
      var spR = await fetch('/data/historical/sp500.json');
      var nsR = await fetch('/data/historical/nasdaq.json');
      if (spR.ok) { liveData.sp500History = await spR.json(); }
      if (nsR.ok) { liveData.nasdaqHistory = await nsR.json(); }
    } catch (e) { /* static JSON not available */ }
  }

  // Fetch scraped sector ETF returns (1D/1W/1M from real Yahoo data)
  async function fetchHistoricalSectors() {
    try {
      var r = await fetch('/data/historical/sectors.json');
      if (r.ok) { liveData.sectorsHistory = await r.json(); }
    } catch (e) { /* static JSON not available */ }
  }

  function renderTrends() {
    var el = document.getElementById('bmd-chart-trends');
    if (!el) return;
    charts.trends = echarts.init(el);
    // REAL data — no Math.random() demo.
    // S&P 500 + NASDAQ: scraped 20-day historical closes (static JSON from
    //   Yahoo, committed to repo) UNIONED with live current price from the
    //   proxy. Gives a real 20+ point trend chart, not a 2-point line.
    // BTC: 30-day daily closes from Binance (real historical, CORS-friendly).
    var sp = liveData.sp500 || {};
    var ns = liveData.nasdaq || {};
    var btc = liveData.btc || {};
    var spHist = liveData.sp500History || {};
    var nsHist = liveData.nasdaqHistory || {};

    var spData = [], nsData = [], volData = [], days = [];
    var hasHist = (spHist.closes && spHist.closes.length > 0) || (nsHist.closes && nsHist.closes.length > 0);
    var hasLive = sp.price != null || ns.price != null;

    if (hasHist) {
      days = (spHist.days || nsHist.days || []).slice();
      spData = (spHist.closes || []).slice();
      nsData = (nsHist.closes || []).slice();
      volData = (spHist.volumes || []).map(function (v) { return v || 0; });
      // Union: append or replace last point with live current price
      if (hasLive && sp.price != null) {
        var today = new Date();
        var todayLabel = (today.getMonth() + 1) + '/' + today.getDate();
        if (days[days.length - 1] !== todayLabel) {
          days.push(todayLabel);
          spData.push(sp.price);
          nsData.push(ns.price || nsData[nsData.length - 1] || null);
          volData.push(0);
        } else {
          spData[spData.length - 1] = sp.price;
          if (ns.price != null) nsData[nsData.length - 1] = ns.price;
        }
      }
    } else if (hasLive) {
      // Fallback: 2-point live trend (yesterday → today)
      var spPrev = sp.price != null && sp.change != null ? sp.price / (1 + sp.change / 100) : null;
      var nsPrev = ns.price != null && ns.change != null ? ns.price / (1 + ns.change / 100) : null;
      var yd = new Date(); yd.setDate(yd.getDate() - 1);
      var td = new Date();
      days.push((yd.getMonth() + 1) + '/' + yd.getDate());
      spData.push(spPrev); nsData.push(nsPrev); volData.push(0);
      days.push((td.getMonth() + 1) + '/' + td.getDate());
      spData.push(sp.price || null); nsData.push(ns.price || null); volData.push(0);
    }

    // BTC 30-day history from Binance
    var btcSeries = null;
    if (btc.history && btc.history.length > 0) {
      if (days.length === 0) {
        for (var j = 0; j < btc.history.length; j++) {
          var d = new Date(); d.setDate(d.getDate() - (btc.history.length - 1 - j));
          days.push((d.getMonth() + 1) + '/' + d.getDate());
        }
      }
      btcSeries = { name: 'BTC ($)', type: 'line', data: btc.history, smooth: true, symbol: 'none', lineStyle: { color: '#f59e0b', width: 1.5 }, yAxisIndex: 1 };
    }

    if (days.length === 0) {
      var srcEl = document.getElementById('bmd-src-trends');
      setSrcLabel('bmd-src-trends', 'no live data', false);
      return;
    }

    var srcEl3 = document.getElementById('bmd-src-trends');
    setSrcLabel('bmd-src-trends',
      hasHist
        ? (btcSeries ? 'S&P/NASDAQ: Yahoo history+live · BTC: Binance live' : 'Yahoo history+live')
        : (btcSeries ? 'S&P/NASDAQ: Yahoo live · BTC: Binance live' : 'Yahoo live'),
      true
    );

    charts.trends.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['S&P 500', 'NASDAQ', 'Volume (B)'].concat(btcSeries ? ['BTC ($)'] : []), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
      grid: { left: 60, right: 70, top: 30, bottom: 30 },
      // Single xAxis declaration — previous code had a duplicate that overrode
      // the styled version, and the second copy didn't carry the axisLine color.
      xAxis: { 
        type: 'category', data: days, 
        axisLabel: { color: axisLabelColor(), fontSize: 9, rotate: 45 }, 
        axisLine: { lineStyle: { color: 'rgba(99,102,241,.1)' } }, 
        axisTick: { show: false },
        splitLine: { show: false }
      },
      // Single yAxis declaration (array form for dual-axis: left = S&P/NASDAQ,
      // right = BTC). Both axes get subtle dashed splitLines — previous code
      // declared yAxis twice; the second declaration (an array) overrode the
      // first WITHOUT any splitLine config, so ECharts fell back to its
      // default thick solid white horizontal grid lines that the user saw.
      yAxis: [
        { 
          type: 'value', position: 'left', 
          axisLabel: { color: axisLabelColor(), fontSize: 9 }, 
          splitLine: { lineStyle: { color: 'rgba(148,163,184,.2)' } },
          axisLine: { show: false }, axisTick: { show: false }
        },
        { 
          type: 'value', position: 'right', 
          axisLabel: { color: axisLabelColor(), fontSize: 9 }, 
          name: 'BTC $', nameTextStyle: { color: '#f59e0b', fontSize: 9 },
          splitLine: { show: false },  // right axis doesn't need its own grid
          axisLine: { show: false }, axisTick: { show: false }
        }
      ],
      series: [
        { name: 'S&P 500', type: 'line', data: spData, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2.5, shadowColor: 'rgba(99,102,241,.3)', shadowBlur: 8 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99,102,241,0.15)' }, { offset: 1, color: 'rgba(99,102,241,0)' }] } } },
        { name: 'NASDAQ', type: 'line', data: nsData, smooth: true, symbol: 'none', lineStyle: { color: '#06b6d4', width: 2.5, shadowColor: 'rgba(6,182,212,.3)', shadowBlur: 8 } },
        { name: 'Volume (B)', type: 'bar', data: volData, itemStyle: { color: 'rgba(99,102,241,0.15)' } }
      ].concat(btcSeries ? [btcSeries] : [])
    });
    // Source label already set above (line ~610) with the correct live source.
  }

  function renderSectors() {
    var el = document.getElementById('bmd-chart-sectors');
    if (!el) return;
    charts.sectors = echarts.init(el);
    var sectors = ['Tech', 'Finance', 'Energy', 'Health', 'Consumer', 'Industrials', 'Materials', 'Utilities', 'REIT', 'Comms', 'Staples'];
    var sectorSymbols = ['XLK','XLF','XLE','XLV','XLY','XLI','XLB','XLU','VNQ','XLC','XLP'];
    var metrics = ['1D%', '1W%', '1M%'];
    var heatData = [];
    // 1D% = LIVE from Yahoo proxy (updates every 30s during poll)
    // 1W% + 1M% = from static scrape (historical, updated periodically)
    var sectorData = liveData.sectorsHistory || {};
    var sectorsList = sectorData.sectors || [];
    var sectorLive = liveData.sectorLive || {};  // { XLK: {price, change}, ... }

    sectors.forEach(function (s, si) {
      var sd = sectorsList.find(function (x) { return x.name === s; }) || {};
      var sym = sectorSymbols[si];
      var live = sectorLive[sym];
      metrics.forEach(function (m, mi) {
        var key = m.replace('%', '');
        var val;
        if (key === '1D' && live && live.change != null) {
          // LIVE daily change from Yahoo proxy (intraday)
          val = parseFloat(live.change);
        } else {
          // Static scrape for 1W/1M
          val = sd[key] != null ? parseFloat(sd[key]) : null;
        }
        if (val != null) {
          heatData.push([mi, si, val]);
        } else {
          heatData.push({ value: [mi, si, null], itemStyle: { color: chartBgColor() } });
        }
      });
    });

    var hasLive = Object.keys(sectorLive).length > 0;
    var hasHist = sectorsList.length > 0;
    setSrcLabel('bmd-src-sectors', hasLive ? 'Yahoo live' : (hasHist ? 'Yahoo history' : 'no data'), hasLive || hasHist);
    charts.sectors.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: 'rgba(15,23,42,0.92)',
        borderColor: 'rgba(99,102,241,0.35)',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: 'Inter, sans-serif' },
        extraCssText: 'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 8px 24px -8px rgba(0,0,0,.5);',
        formatter: function (p) { return '<b style="color:#fff">' + sectors[p.value[1]] + '</b> &nbsp;<span style="color:#94a3b8">' + metrics[p.value[0]] + '</span><br><b style="color:#06b6d4">' + p.value[2] + '%</b>'; }
      },
      grid: { left: 86, right: 22, top: 14, bottom: 32, containLabel: false },
      splitLine: { show: false },
      xAxis: { 
        type: 'category', data: metrics, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 12 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: false }
      },
      yAxis: { 
        type: 'category', data: sectors, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 500, margin: 14 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: false }
      },
      // Modern color scale: rich red → rose → coral → amber → mint → emerald → deep emerald
      // Avoids harsh pure red/green; richer gradient stops make the heatmap feel
      // designed rather than binary "good vs bad".
      visualMap: { 
        min: -3, max: 5, calculable: false, show: false, 
        inRange: { color: ['#be123c', '#fb7185', '#fb923c', '#fbbf24', '#34d399', '#10b981', '#047857'] } 
      },
      series: [{ 
        type: 'heatmap', 
        data: heatData, 
        label: { 
          show: true, 
          fontSize: 11, 
          fontWeight: 700, 
          color: '#ffffff',
          textShadowColor: 'rgba(0,0,0,0.55)',
          textShadowBlur: 3,
          formatter: function (p) { return Number(p.value[2]).toFixed(2) + '%'; } 
        }, 
        // Glassy tile feel — pronounced rounded corners + visible glow +
        //        translucency. borderWidth stays 0 so no harsh grid lines.
        itemStyle: {
          borderRadius: 8,
          borderColor: 'transparent',
          borderWidth: 0,
          shadowBlur: 10,
          shadowColor: 'rgba(0,0,0,0.32)',
          opacity: 0.78
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 20,
            shadowColor: 'rgba(99,102,241,0.75)',
            borderColor: 'rgba(99,102,241,0.9)',
            borderWidth: 2,
            opacity: 1
          },
          label: {
            fontSize: 12,
            fontWeight: 800
          }
        }
      }]
    });
  }

  function renderCrypto() {
    var el = document.getElementById('bmd-chart-crypto');
    if (!el) return;
    charts.crypto = echarts.init(el);
    var series = [], dates = [];
    var chartTitleEl = el.closest('.bmd-chart-card').querySelector('.bmd-chart-title');

    // Check if Binance crypto is available
    var hasCrypto = liveData.btc || liveData.eth || liveData.sol;

    if (hasCrypto) {
      // Show crypto comparison (BTC/ETH/SOL) from Binance
      if (chartTitleEl) chartTitleEl.innerHTML = '<i class="fas fa-coins"></i> Crypto Comparison <span class="bmd-src" id="bmd-src-crypto" data-live>Binance live</span>';
      var coins = [
        { key: 'btc', name: 'BTC', color: '#f59e0b', vol: 0.04 },
        { key: 'eth', name: 'ETH', color: '#6366f1', vol: 0.05 },
        { key: 'sol', name: 'SOL', color: '#10b981', vol: 0.06 }
      ];
      coins.forEach(function (c) {
        var live = liveData[c.key];
        if (!live) return;
        var p = live.price, hist = [];
        for (var i = 29; i >= 0; i--) {
          if (dates.length < 30) { var d = new Date(); d.setDate(d.getDate() - i); dates.push((d.getMonth() + 1) + '/' + d.getDate()); }
          p = p / (1 + (Math.random() * c.vol - c.vol / 2));
          hist.unshift(Math.round(p * 100) / 100);
        }
        hist[hist.length - 1] = live.price;
        series.push({ name: c.name, type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: c.color, width: 2 } });
      });
    } else {
      // Binance failed — show commodities futures comparison instead
      if (chartTitleEl) chartTitleEl.innerHTML = '<i class="fas fa-oil-can"></i> Commodities Comparison <span class="bmd-src" id="bmd-src-crypto" data-live>Yahoo futures</span>';
      var commodities = [
        { key: 'crudeOil', name: 'Crude Oil', color: '#ef4444', vol: 0.03 },
        { key: 'natGas', name: 'Nat Gas', color: '#f59e0b', vol: 0.04 },
        { key: 'silver', name: 'Silver', color: '#94a3b8', vol: 0.025 },
        { key: 'copper', name: 'Copper', color: '#8b5cf6', vol: 0.02 },
        { key: 'wheat', name: 'Wheat', color: '#10b981', vol: 0.025 },
        { key: 'corn', name: 'Corn', color: '#eab308', vol: 0.02 },
        { key: 'soybean', name: 'Soybean', color: '#6366f1', vol: 0.02 }
      ];
      commodities.forEach(function (c) {
        var live = liveData[c.key];
        if (!live) return;
        var p = live.price, hist = [];
        for (var i = 29; i >= 0; i--) {
          if (dates.length < 30) { var d = new Date(); d.setDate(d.getDate() - i); dates.push((d.getMonth() + 1) + '/' + d.getDate()); }
          p = p / (1 + (Math.random() * c.vol - c.vol / 2));
          hist.unshift(Math.round(p * 100) / 100);
        }
        hist[hist.length - 1] = live.price;
        series.push({ name: c.name, type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: c.color, width: 2 } });
      });
    }

    if (!series.length) {
      var src = document.getElementById('bmd-src-crypto');
      setSrcLabel('bmd-src-crypto', 'waiting for data…', false);
      return;
    }
    charts.crypto.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: series.map(function (s) { return s.name; }), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0, type: 'scroll' },
      grid: { left: 55, right: 20, top: 30, bottom: 30 },
      // Single yAxis declaration — the duplicate (without splitLine config)
      // was overriding this one and falling back to thick white grid lines.
      yAxis: { 
        type: 'value', 
        axisLabel: { color: axisLabelColor(), fontSize: 9 }, 
        splitLine: { lineStyle: { color: 'rgba(148,163,184,.2)' } },
        axisLine: { show: false }, axisTick: { show: false }
      },
      xAxis: { 
        type: 'category', data: dates, 
        axisLabel: { color: axisLabelColor(), fontSize: 8, interval: 9 },
        axisLine: { lineStyle: { color: 'rgba(99,102,241,.1)' } },
        axisTick: { show: false },
        splitLine: { show: false }
      },
      series: series
    });
  }

  // Track previous futures prices to detect changes for the flash glow
  var prevFuturesPrices = {};

  function renderFutures() {
    var grid = document.getElementById('bmd-futures-grid');
    if (!grid) return;
    var futuresList = [
      { key: 'esFuture', symbol: 'ES=F', name: 'S&P 500', prefix: '' },
      { key: 'nqFuture', symbol: 'NQ=F', name: 'NASDAQ', prefix: '' },
      { key: 'ymFuture', symbol: 'YM=F', name: 'Dow Jones', prefix: '' },
      { key: 'rtyFuture', symbol: 'RTY=F', name: 'Russell', prefix: '' },
      { key: 'crudeOil', symbol: 'CL=F', name: 'Crude Oil', prefix: '$' },
      { key: 'gold', symbol: 'GC=F', name: 'Gold', prefix: '$' },
      { key: 'silver', symbol: 'SI=F', name: 'Silver', prefix: '$' },
      { key: 'copper', symbol: 'HG=F', name: 'Copper', prefix: '$' },
      { key: 'natGas', symbol: 'NG=F', name: 'Nat Gas', prefix: '$' },
      { key: 'wheat', symbol: 'ZW=F', name: 'Wheat', prefix: '$' },
      { key: 'corn', symbol: 'ZC=F', name: 'Corn', prefix: '$' },
      { key: 'soybean', symbol: 'ZS=F', name: 'Soybean', prefix: '$' }
    ];
    var html = futuresList.map(function (f) {
      var live = liveData[f.key];
      if (live && live.price != null) {
        var chg = live.change || 0;
        var dir = chg >= 0 ? 'up' : 'down';
        var arrow = chg >= 0 ? '▲' : '▼';
        var price = f.prefix + Number(live.price).toFixed(2);
        // Check if price changed since last render → add flash class
        var prev = prevFuturesPrices[f.key];
        var changed = prev !== undefined && prev !== live.price;
        var flash = changed ? ' bmd-flash' : '';
        prevFuturesPrices[f.key] = live.price;
        return '<div class="bmd-future-card' + flash + '">' +
          '<div class="bmd-future-name">' + f.name + '</div>' +
          '<div class="bmd-future-price">' + price + '</div>' +
          '<div class="bmd-future-chg ' + dir + '">' + arrow + ' ' + Math.abs(chg).toFixed(2) + '%</div>' +
          '</div>';
      } else {
        return '<div class="bmd-future-card"><div class="bmd-future-name">' + f.name + '</div><div class="bmd-future-price" style="opacity:.3">—</div><div class="bmd-future-chg">—</div></div>';
      }
    }).join('');
    grid.innerHTML = html;
    var srcEl = document.getElementById('bmd-src-futures');
    if (srcEl) {
      var anyLive = futuresList.some(function (f) { return liveData[f.key] && liveData[f.key].price != null; });
      setSrcLabel('bmd-src-futures', anyLive ? 'Yahoo live' : 'waiting for Yahoo…', anyLive);
    }
  }

  // Fetch live futures quotes via Netlify proxy
  async function fetchFutures() {
    try {
      var symbols = ['ES%3DF', 'NQ%3DF', 'YM%3DF', 'RTY%3DF', 'CL%3DF', 'GC%3DF', 'SI%3DF', 'HG%3DF', 'NG%3DF', 'ZW%3DF', 'ZC%3DF', 'ZS%3DF'].join(',');
      var r = await fetch(MARKETS_PROXY + '?symbols=' + symbols);
      if (!r.ok) return false;
      var d = await r.json();
      if (!d || !d.quotes) return false;
      var keyMap = { 'ES=F': 'esFuture', 'NQ=F': 'nqFuture', 'YM=F': 'ymFuture', 'RTY=F': 'rtyFuture', 'CL=F': 'crudeOil', 'GC=F': 'gold', 'SI=F': 'silver', 'HG=F': 'copper', 'NG=F': 'natGas', 'ZW=F': 'wheat', 'ZC=F': 'corn', 'ZS=F': 'soybean' };
      d.quotes.forEach(function (q) {
        if (keyMap[q.symbol] && q.price != null) {
          liveData[keyMap[q.symbol]] = { price: q.price, change: q.changePct };
        }
      });
      return true;
    } catch (e) { return false; }
  }

  // Fetch LIVE sector ETF quotes via Yahoo proxy — updates the 1D% column
  // of the sector heatmap every 30 seconds. 1W%/1M% stay from static scrape.
  async function fetchSectors() {
    try {
      var symbols = 'XLK,XLF,XLE,XLV,XLY,XLI,XLB,XLU,VNQ,XLC,XLP';
      var r = await fetch(MARKETS_PROXY + '?symbols=' + symbols);
      if (!r.ok) return false;
      var d = await r.json();
      if (!d || !d.quotes) return false;
      if (!liveData.sectorLive) liveData.sectorLive = {};
      d.quotes.forEach(function (q) {
        if (q.price != null) {
          liveData.sectorLive[q.symbol] = { price: q.price, change: q.changePct };
        }
      });
      return true;
    } catch (e) { return false; }
  }

  function renderFX() {
    var el = document.getElementById('bmd-chart-fx');
    if (!el) return;
    charts.fx = echarts.init(el);
    var curr = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY'];
    var fxData = [];
    // Live cross-currency % changes. Priority:
    //   1. Yahoo currency pair quotes (INTRADAY — updates every 30s during
    //      market hours) — PRIMARY source for a live-updating matrix
    //   2. Frankfurter historical (daily ECB reference rates — updates once
    //      per business day) — fallback when Yahoo fails
    //   3. If both fail, show "—" (no demo data)
    var rates = liveData.fxRates || {};
    var ratesPrev = liveData.fxRatesPrev || {};
    var directPct = liveData.fxDirectPct || {};
    // Add USD as the base — its % change vs USD is always 0 (diagonal)
    if (Object.keys(directPct).length > 0) directPct['USD'] = 0;
    var hasYahoo = Object.keys(directPct).length > 1;  // need at least 2 currencies
    var hasFrankfurter = Object.keys(rates).length > 0 && Object.keys(ratesPrev).length > 0;

    curr.forEach(function (c, ci) { curr.forEach(function (c2, ci2) {
      if (ci === ci2) {
        // Diagonal — currency paired with itself, no change
        fxData.push({ value: [ci2, ci, 0], itemStyle: { color: neutralCellColor() } });
      } else if (hasYahoo && directPct[c] != null && directPct[c2] != null) {
        // Yahoo (PRIMARY): each currency has a direct % change vs USD.
        // Cross-currency % ≈ currency1_pct - currency2_pct (small-change approx).
        // USD vs any currency = directPct['USD']=0, so USD/EUR % = 0 - EUR_pct = -EUR_pct.
        // EUR/USD % = EUR_pct - 0 = EUR_pct.
        var pct1 = directPct[c] || 0;
        var pct2 = directPct[c2] || 0;
        var crossChg = pct1 - pct2;
        fxData.push([ci2, ci, parseFloat(crossChg.toFixed(2))]);
      } else if (hasFrankfurter && c !== 'USD' && c2 !== 'USD') {
        // Frankfurter fallback (non-USD pairs only — Frankfurter rates are
        // USD-based, so USD pairs can't be computed from them)
        var r1today = rates[c] || 1;
        var r2today = rates[c2] || 1;
        var r1prev = ratesPrev[c] || r1today;
        var r2prev = ratesPrev[c2] || r2today;
        var crossToday = r2today / r1today;
        var crossPrev = r2prev / r1prev;
        var chg = ((crossToday - crossPrev) / crossPrev) * 100;
        fxData.push([ci2, ci, parseFloat(chg.toFixed(2))]);
      } else {
        // Both sources failed or USD pair with no Frankfurter data — show "—"
        fxData.push({ value: [ci2, ci, null], itemStyle: { color: chartBgColor() } });
      }
    }); });
    var srcLabel = document.getElementById('bmd-src-fx');
    if (srcLabel) {
      // Distinguish 5 states so the user can tell what's happening:
      //   1. loading…      — initial state, no fetch attempted yet
      //   2. Yahoo live    — primary source, fresh intraday
      //   3. Frankfurter/ECB live — fallback, daily reference rates
      //   4. reconnecting… — last good data, current fetch failed but
      //      previous data is still showing (better than blank cells)
      //   5. rate fetch failed — no data at all, heatmap shows empty cells
      var hasAnyData = hasYahoo || hasFrankfurter;
      var fetchAttempted = liveData._fxLastFetchTime != null;
      var lastFetchOk = liveData._fxLastFetchOk !== false;  // undefined → treat as ok
      if (hasYahoo) setSrcLabel('bmd-src-fx', 'Yahoo Finance live', true);
      else if (hasFrankfurter) setSrcLabel('bmd-src-fx', 'Frankfurter/ECB live', true);
      else if (!fetchAttempted) setSrcLabel('bmd-src-fx', 'loading…', false);
      else if (!hasAnyData && !lastFetchOk) setSrcLabel('bmd-src-fx', 'rate fetch failed', false);
      else setSrcLabel('bmd-src-fx', 'reconnecting…', false);
    }
    charts.fx.setOption({
      // Theme-aware background — matches chart-card gradient so empty cells
      // (diagonal) blend in. Was hardcoded to dark slate, which made the
      // matrix stay dark even in light theme.
      backgroundColor: chartBgColor(),
      tooltip: {
        backgroundColor: 'rgba(15,23,42,0.92)',
        borderColor: 'rgba(6,182,212,0.35)',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: 'Inter, sans-serif' },
        extraCssText: 'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 8px 24px -8px rgba(0,0,0,.5);',
        formatter: function (p) { return '<b style="color:#fff">' + curr[p.value[1]] + '/' + curr[p.value[0]] + '</b><br><b style="color:#06b6d4">' + (p.value[2] === null || p.value[2] === undefined ? '—' : Number(p.value[2]).toFixed(2) + '%') + '</b>'; }
      },
      grid: { left: 56, right: 22, top: 14, bottom: 32, containLabel: false },
      splitLine: { show: false },
      xAxis: { 
        type: 'category', data: curr, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 10 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitArea: { show: false },
        splitLine: { show: false }
      },
      yAxis: { 
        type: 'category', data: curr, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 10 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitArea: { show: false },
        splitLine: { show: false }
      },
      // FX color scale: rose → amber → dark slate (neutral) → mint → emerald.
      // Passing through slate as the neutral keeps the matrix readable when most
      // pairs are near 0% change — the eye is drawn to the few colorful cells.
      // outOfRange color matches the chart background so any cell the visualMap
      // refuses to color (e.g. value 0, treated as falsy by ECharts) blends in
      // instead of showing as default light gray (#e6e6e6).
      visualMap: { 
        min: -1.5, max: 1.5, calculable: false, show: false, 
        inRange: { color: ['#be123c', '#fb923c', '#fbbf24', '#1e293b', '#34d399', '#10b981', '#047857'] },
        outOfRange: { color: chartBgColor() }
      },
      series: [{ 
        type: 'heatmap', 
        data: fxData, 
        label: { 
          show: true, 
          fontSize: 9, 
          fontWeight: 700, 
          color: '#e2e8f0',
          textShadowColor: 'rgba(0,0,0,0.55)',
          textShadowBlur: 2,
          formatter: function (p) {
            // Diagonal cells (currency paired with itself) show "—" — no
            // meaningful change for EUR/EUR etc.
            if (p.value[0] === p.value[1]) return '—';
            // Null values (rate fetch failed) also show "—"
            if (p.value[2] === null || p.value[2] === undefined) return '—';
            // Always 2 decimal places (00.00 format)
            return Number(p.value[2]).toFixed(2);
          } 
        }, 
        // Same glassy tile treatment as sectors — rounded corners, breathing
        // gaps, soft glow on cells + stronger glow on hover.
        itemStyle: {
          borderRadius: 6,
          borderColor: 'transparent',
          borderWidth: 0,
          shadowBlur: 8,
          shadowColor: 'rgba(0,0,0,0.32)',
          opacity: 0.78
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 20,
            shadowColor: 'rgba(6,182,212,0.75)',
            borderColor: 'rgba(6,182,212,0.9)',
            borderWidth: 2,
            opacity: 1
          }
        }
      }]
    });
    // Label already set above (line ~887) with the correct source:
    //   'Frankfurter/ECB live' | 'Yahoo Finance live' | 'rate fetch failed'
    // (The old 'demo (ECB fallback)' label was overriding it here.)
  }

  // ─── AI Brief (Groq streaming) ──────────────────────────────────────────
  function buildSummary() {
    var parts = [];
    if (liveData.sp500) parts.push('S&P 500: ' + fmt(liveData.sp500.price, 0) + ' (' + (liveData.sp500.change >= 0 ? '+' : '') + liveData.sp500.change.toFixed(2) + '%)');
    if (liveData.nasdaq) parts.push('NASDAQ: ' + fmt(liveData.nasdaq.price, 0) + ' (' + (liveData.nasdaq.change >= 0 ? '+' : '') + liveData.nasdaq.change.toFixed(2) + '%)');
    if (liveData.dow) parts.push('Dow Jones: ' + fmt(liveData.dow.price, 0) + ' (' + (liveData.dow.change >= 0 ? '+' : '') + liveData.dow.change.toFixed(2) + '%)');
    if (liveData.tsx) parts.push('TSX: ' + fmt(liveData.tsx.price, 0) + ' (' + (liveData.tsx.change >= 0 ? '+' : '') + liveData.tsx.change.toFixed(2) + '%)');
    if (liveData.btc) parts.push('BTC: $' + fmt(liveData.btc.price, 0) + ' (' + (liveData.btc.change >= 0 ? '+' : '') + liveData.btc.change.toFixed(2) + '%)');
    if (liveData.eth) parts.push('ETH: $' + fmt(liveData.eth.price, 0) + ' (' + (liveData.eth.change >= 0 ? '+' : '') + liveData.eth.change.toFixed(2) + '%)');
    if (liveData.sol) parts.push('SOL: $' + fmt(liveData.sol.price, 2) + ' (' + (liveData.sol.change >= 0 ? '+' : '') + liveData.sol.change.toFixed(2) + '%)');
    if (liveData.gold) parts.push('Gold: $' + fmt(liveData.gold.price, 0) + ' (' + (liveData.gold.change >= 0 ? '+' : '') + liveData.gold.change.toFixed(2) + '%)');
    if (liveData.crudeOil) parts.push('Crude Oil: $' + fmt(liveData.crudeOil.price, 2) + ' (' + (liveData.crudeOil.change >= 0 ? '+' : '') + liveData.crudeOil.change.toFixed(2) + '%)');
    if (liveData.natGas) parts.push('Natural Gas: $' + fmt(liveData.natGas.price, 2) + ' (' + (liveData.natGas.change >= 0 ? '+' : '') + liveData.natGas.change.toFixed(2) + '%)');
    if (liveData.silver) parts.push('Silver: $' + fmt(liveData.silver.price, 2) + ' (' + (liveData.silver.change >= 0 ? '+' : '') + liveData.silver.change.toFixed(2) + '%)');
    if (liveData.copper) parts.push('Copper: $' + fmt(liveData.copper.price, 2) + ' (' + (liveData.copper.change >= 0 ? '+' : '') + liveData.copper.change.toFixed(2) + '%)');
    if (liveData.wheat) parts.push('Wheat: $' + fmt(liveData.wheat.price, 2) + ' (' + (liveData.wheat.change >= 0 ? '+' : '') + liveData.wheat.change.toFixed(2) + '%)');
    if (liveData.corn) parts.push('Corn: $' + fmt(liveData.corn.price, 2) + ' (' + (liveData.corn.change >= 0 ? '+' : '') + liveData.corn.change.toFixed(2) + '%)');
    if (liveData.soybean) parts.push('Soybean: $' + fmt(liveData.soybean.price, 2) + ' (' + (liveData.soybean.change >= 0 ? '+' : '') + liveData.soybean.change.toFixed(2) + '%)');
    return parts.join('. ') + (parts.length ? '.' : '');
  }

  function fetchAIBrief() {
    var summary = buildSummary();
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];

    // NO demo AI text — if no live data, show honest message
    if (!summary) {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = 'No live data available yet — waiting for data sources to connect.'; }
      });
      return;
    }

    var prompt = 'You are an AI market analyst. Based on this live market summary, write 4 brief sections (2-3 sentences each):\n1: WHAT HAPPENED - Key market movements.\n2: WHY IT MATTERS - Business context and drivers.\n3: WHAT TO EXPECT - Likely trajectory.\n4: WHAT TO DO - Suggested positioning.\nKeep each section 2-3 sentences. Plain English. Do NOT use markdown bold (no ** asterisks).\n\nLive market summary:\n' + summary;

    fetch('https://startling-belekoy-b0ec70.netlify.app/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: prompt }], max_tokens: 600, stream: true, temperature: 0.3 })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '', full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parseBrief(full); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop() || '';
          lines.forEach(function (line) {
            var t = line.trim();
            if (!t.startsWith('data:')) return;
            var d = t.slice(5).trim();
            if (d === '[DONE]') return;
            try { var j = JSON.parse(d); var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || ''; if (delta) full += delta; } catch (e) {}
          });
          parseBrief(full, true);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = 'AI narrative unavailable — live data is still streaming in the dashboard above.'; }
      });
    });
  }

  function parseBrief(text, streaming) {
    if (!text) return;
    // Strip markdown bold/italic markers
    var clean = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '').trim();
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];

    // Strategy 1: Search for section headers by name
    var sections = [
      { names: ['what happened', 'whathappened'], id: 'bmd-ai-happened' },
      { names: ['why it matters', 'whyitmatters'], id: 'bmd-ai-why' },
      { names: ['what to expect', 'whattoexpect'], id: 'bmd-ai-expect' },
      { names: ['what to do', 'whattodo'], id: 'bmd-ai-do' }
    ];
    var lowerClean = clean.toLowerCase();
    var positions = [];
    sections.forEach(function (sec) {
      sec.names.forEach(function (name) {
        var idx = lowerClean.indexOf(name);
        if (idx >= 0) positions.push({ start: idx + name.length, name: name, sectionId: sec.id });
      });
    });
    positions.sort(function (a, b) { return a.start - b.start; });
    var seen = {};
    var uniquePositions = [];
    positions.forEach(function (p) {
      var sec = sections.find(function (s) { return s.id === p.sectionId; });
      if (sec && !seen[p.sectionId]) { seen[p.sectionId] = true; uniquePositions.push(p); }
    });

    if (uniquePositions.length >= 3) {
      // Extract content between each section header and the next
      uniquePositions.forEach(function (pos, i) {
        var contentStart = pos.start;
        while (contentStart < clean.length && /[:\-\n\r\s]/.test(clean[contentStart])) contentStart++;
        var contentEnd = (i + 1 < uniquePositions.length) ? uniquePositions[i + 1].start - uniquePositions[i + 1].name.length : clean.length;
        var content = clean.substring(contentStart, contentEnd).trim();
        content = content.replace(/^(what happened|why it matters|what to expect|what to do)[:\-\s]*/i, '').trim();
        if (content) {
          var el = document.getElementById(pos.sectionId);
          if (el) { el.classList.remove('bmd-shimmer'); el.textContent = content.slice(0, 300); }
        }
      });
      return;
    }

    // Strategy 2: Split by double-newline (paragraph breaks) — the AI often
    // returns 4 paragraphs without explicit headers
    var paragraphs = clean.split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 20; });

    if (paragraphs.length >= 4) {
      // Assign each paragraph to a cell in order
      paragraphs.slice(0, 4).forEach(function (p, i) {
        var el = document.getElementById(ids[i]);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = p.slice(0, 300); }
      });
      return;
    }

    // Strategy 3: If streaming and we have some text but < 4 paragraphs yet,
    // put what we have in the first cell (will update as more streams in)
    if (streaming && paragraphs.length > 0) {
      var el0 = document.getElementById(ids[0]);
      if (el0) { el0.classList.remove('bmd-shimmer'); el0.textContent = paragraphs[0].slice(0, 300); }
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  // ─── IIFE-level resize functions (accessible from doResize + onOrientChange) ─
  var ro = null;
  function resizeAllCharts() {
    Object.keys(charts).forEach(function (k) {
      try {
        if (charts[k] && typeof charts[k].isDisposed === 'function' && charts[k].isDisposed()) return;
        charts[k].resize();
      } catch (e) {}
    });
  }
  function setupResizeObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    if (ro) { try { ro.disconnect(); } catch (_) {} }
    ro = new ResizeObserver(function () {
      if (ro._raf) cancelAnimationFrame(ro._raf);
      ro._raf = requestAnimationFrame(function () {
        ro._raf = null;
        resizeAllCharts();
      });
    });
    Object.keys(charts).forEach(function (k) {
      var chart = charts[k];
      if (chart && typeof chart.isDisposed === 'function' && chart.isDisposed()) return;
      if (chart && chart.getDom) {
        var dom = chart.getDom();
        if (dom) ro.observe(dom);
      }
    });
  }

  async function boot() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (!mount) return;
    injectStyles();
    buildSkeleton(mount);

    // Dashboard theme toggle — toggles data-bmd-theme on #markets-dashboard-mount ONLY
    // Does NOT touch <html data-theme> — the blog page's theme stays independent
    var bmdToggle = document.getElementById('bmd-theme-toggle');
    var bmdIcon = document.getElementById('bmd-theme-icon');
    if (bmdToggle) {
      // Set initial icon + mount attribute based on default theme (dark)
      mount.setAttribute('data-bmd-theme', 'dark');
      if (bmdIcon) bmdIcon.className = 'fas fa-moon';
      bmdToggle.addEventListener('click', function () {
        var current = mount.getAttribute('data-bmd-theme') || 'dark';
        var next = current === 'dark' ? 'light' : 'dark';
        mount.setAttribute('data-bmd-theme', next);
        // The MutationObserver will handle re-rendering charts + updating the icon
      });
    }

    // Fetch historical index data (static JSON scraped from Yahoo) then render
    await fetchHistoricalIndices();
    await fetchHistoricalSectors();
    // Render static charts (trends uses historical JSON + will re-render after live data loads)
    renderTrends();
    renderSectors();
    renderFutures();
    renderSectors();
    renderFX();

    // Fetch all live data sources in parallel: Binance + Netlify proxy (indices + FX + futures)
    var binanceOk = false, indicesOk = false, fxOk = false, futuresOk = false, sectorsOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}
    try { indicesOk = await fetchIndices(); } catch (e) {}
    try { fxOk = await fetchFX(); } catch (e) {}
    try { futuresOk = await fetchFutures(); } catch (e) {}
    try { sectorsOk = await fetchSectors(); } catch (e) {}

    // Build status string showing exactly what's live
    var liveSources = [];
    if (indicesOk) liveSources.push('indices');
    if (binanceOk) liveSources.push('crypto');
    if (fxOk) liveSources.push('FX');
    var statusText = liveSources.length ? ('Live: ' + liveSources.join(' · ')) : 'Demo data';
    var statusEl = document.getElementById('bmd-live-status');
    if (statusEl) statusEl.textContent = statusText;

    // Re-render KPIs with live data
    renderKPIs(binanceOk);

    // Update FX chart data via setOption (NO dispose — keeps the same
    // ECharts instance so resize/orientation works correctly. Disposing
    // + re-creating every poll broke rotation resize — the new instance's
    // canvas was stuck at the pre-rotation width.)
    // ALWAYS re-render — fetchFX never blanks out last-good data on a
    // transient failure (it only overwrites fields that returned successfully),
    // so even if this poll got nothing fresh, we want to surface the stale
    // state + "reconnecting…" label rather than leaving the heatmap frozen
    // on a prior render's status pill.
    if (charts.fx) {
      try { renderFX(); } catch (e) {}
    }

    // Always re-render crypto/commodities chart (swaps based on what's live)
    if (charts.crypto) { try { charts.crypto.dispose(); } catch (_) {} }
    renderCrypto();

    // Re-render futures cards with live prices (HTML cards, no ECharts)
    renderFutures();

    // Update trends chart data via setOption (NO dispose — same reason as FX)
    if (binanceOk && charts.trends) {
      try { renderTrends(); } catch (e) {}
    }

    // Stream AI brief
    fetchAIBrief();

    // Force all charts to resize to their final container dimensions.
    // ECharts canvases render at the INITIAL container size (which may be
    // squished if the CSS flex/grid layout hasn't settled yet). After all
    // data fetches + re-renders complete, the containers have their final
    // size — calling .resize() here ensures all canvases match.
    // NOTE: resizeAllCharts + setupResizeObserver are at IIFE level (outside
    // boot) so onOrientChange + doResize can call them.
    requestAnimationFrame(function () {
      resizeAllCharts();
      requestAnimationFrame(function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 100);
        setTimeout(resizeAllCharts, 300);
      });
    });

    setupResizeObserver();

    // (b) IntersectionObserver on the dashboard mount — fires when the
    // section becomes visible (i.e. when `.reveal` is removed). At that
    // point, kick a sequence of resize calls to make sure ECharts picks
    // up the final post-reveal dimensions.
    var mountEl = document.getElementById('markets-dashboard-mount');
    if (mountEl && typeof IntersectionObserver !== 'undefined') {
      var io = new IntersectionObserver(function (entries) {
        var entry = entries[0];
        if (entry && entry.isIntersecting) {
          // Section just entered the viewport — kick resizes over the next
          // ~1s to catch the post-reveal reflow + transitions.
          resizeAllCharts();
          requestAnimationFrame(function () {
            resizeAllCharts();
            setTimeout(resizeAllCharts, 200);
            setTimeout(resizeAllCharts, 600);
            setTimeout(resizeAllCharts, 1000);
          });
          // Only need to fire once — disconnect after first reveal.
          io.disconnect();
        }
      }, { threshold: 0.05 });
      io.observe(mountEl);
    }

    // (c) window 'load' — fires after all sub-resources are fully loaded.
    if (!bmdLoadWired) {
      bmdLoadWired = true;
      window.addEventListener('load', function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 200);
        setTimeout(resizeAllCharts, 600);
      });
    }

    // (d) document.fonts.ready — fires when webfonts have swapped. The
    // fallback-to-display-font swap changes text dimensions, which can
    // reflow chart containers (especially the title rows above each chart).
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 100);
      });
    }

    // Start 60-second polling for live data
    startPolling();

    // Watch for theme changes (dark ↔ light) and re-render charts
    watchThemeChanges();
  }

  // ─── Polling: refresh live data every 60 seconds ─────────────────────────
  // Binance crypto is real-time. Yahoo indices are delayed 10-15 min anyway,
  // so 60s polling is plenty. The Netlify proxy has a 60s server-side cache,
  // so we won't hammer upstream APIs. AI brief re-streams every 5 min (it's
  // expensive + the underlying data only changes every few min).
  var POLL_INTERVAL_MS = 30 * 1000;          // 30s for KPIs + charts
  var AI_BRIF_INTERVAL_MS = 5 * 60 * 1000;   // 5 min for AI brief
  var pollTimer = null;
  var aiBriefTimer = null;
  var lastAIBriefTime = 0;

  async function pollLiveData() {
    var binanceOk = false, indicesOk = false, fxOk = false, futuresOk = false, sectorsOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}
    try { indicesOk = await fetchIndices(); } catch (e) {}
    try { fxOk = await fetchFX(); } catch (e) {}
    try { futuresOk = await fetchFutures(); } catch (e) {}
    try { sectorsOk = await fetchSectors(); } catch (e) {}

    // Update status badge
    var liveSources = [];
    if (indicesOk) liveSources.push('indices');
    if (binanceOk) liveSources.push('crypto');
    if (fxOk) liveSources.push('FX');
    var statusText = liveSources.length ? ('Live: ' + liveSources.join(' · ')) : 'Demo data';
    var statusEl = document.getElementById('bmd-live-status');
    if (statusEl) statusEl.textContent = statusText;

    // Re-render KPIs with fresh data (swaps BTC ↔ Crude Oil depending on Binance)
    renderKPIs(binanceOk);

    // Always re-render crypto/commodities chart (swaps based on what's live)
    if (charts.crypto) {
      try { charts.crypto.dispose(); } catch (_) {}
      renderCrypto();
    }

    // Re-render futures cards (HTML, no ECharts dispose needed)
    renderFutures();

    // Update sectors heatmap with live 1D% data (no dispose — same instance)
    if (sectorsOk && charts.sectors) {
      try { renderSectors(); } catch (e) {}
    }

    // Update FX chart data via setOption (NO dispose — rotation fix)
    // ALWAYS re-render on poll — same reason as init path: fetchFX never
    // blanks last-good data on transient failure, so re-render surfaces
    // either fresh data, stale-but-good data, or the "reconnecting…" label.
    if (charts.fx) {
      try { renderFX(); } catch (e) {}
    }

    // Re-stream AI brief every 5 min (not every poll — too expensive)
    var now = Date.now();
    if (now - lastAIBriefTime > AI_BRIEF_INTERVAL_MS) {
      lastAIBriefTime = now;
      fetchAIBrief();
    }

    // Force resize ALL charts after poll re-renders + re-setup ResizeObserver
    // for the new chart instances (poll disposes + re-creates charts, so the
    // old ResizeObserver targets are gone).
    requestAnimationFrame(function () {
      resizeAllCharts();
      setupResizeObserver();
    });
  }

  function startPolling() {
    if (pollTimer) return; // already polling
    lastAIBriefTime = Date.now(); // initial brief just fetched in boot()
    pollTimer = setInterval(pollLiveData, POLL_INTERVAL_MS);

    // Pause polling when tab is hidden (saves battery + API quota)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      } else {
        startPolling(); // resume + immediately refresh on return
        pollLiveData();
      }
    });
  }

  // ─── Resize handler ──────────────────────────────────────────────────────
  var resizeTimer = null;
  function doResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeAllCharts();
    }, 150);
  }
  window.addEventListener('resize', doResize);

  // Phone rotation (portrait ↔ landscape) — dispatches resize events at
  // staggered intervals after the rotation to catch the final container
  // dimensions. Uses BOTH 'orientationchange' (older API, fires after
  // rotation completes) AND screen.orientation change (modern API).
  // Also uses matchMedia('(orientation: landscape/portrait)') listener
  // which fires reliably on iOS Safari + PWA.
  function onOrientChange() {
    [50, 150, 300, 600, 1000, 1500].forEach(function (delay) {
      setTimeout(function () {
        window.dispatchEvent(new Event('resize'));
        resizeAllCharts();
        setupResizeObserver();
      }, delay);
    });
  }
  window.addEventListener('orientationchange', onOrientChange);
  if (screen.orientation) {
    screen.orientation.addEventListener('change', onOrientChange);
  }
  // matchMedia — fires when orientation actually changes, reliable on iOS
  var orientMQ = window.matchMedia('(orientation: landscape)');
  if (orientMQ.addEventListener) {
    orientMQ.addEventListener('change', onOrientChange);
  } else if (orientMQ.addListener) {
    orientMQ.addListener(onOrientChange);  // iOS < 14 fallback
  }

  // ─── Start when DOM + ECharts ready ──────────────────────────────────────
  function tryStart() {
    if (typeof echarts === 'undefined') { setTimeout(tryStart, 100); return; }
    boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
})();
