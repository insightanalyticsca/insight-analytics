#!/usr/bin/env node
/**
 * auto-blog.mjs — Automated AI blog article generator
 *
 * Runs twice daily via GitHub Actions cron. Generates 2 articles per run:
 *   1. RSS feed article: fetches AI/business news, summarizes with Groq (500 words)
 *   2. Feature article: deep-dive on Insight Analytics' own features (500 words)
 *
 * Groq is called via Netlify proxy (no API key needed).
 * max_tokens: 4000 (enough for 500+ words)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const SITE_URL = 'https://insight-analytics.ca';
const GROQ_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const REPO_ROOT = process.cwd();
const NOW = new Date();
const ISO_NOW = NOW.toISOString();
const DATE_STR = NOW.toISOString().split('T')[0];
const TIME_STAMP = NOW.getTime();

// ─── RSS Feed Sources ────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat AI' },
  { url: 'https://www.artificialintelligence-news.com/feed/', name: 'AI News' },
];

// ─── Feature topics (our own site features, exec-oriented) ───────────────
const FEATURE_TOPICS = [
  {
    title: 'The Universal Dashboard Constructor: One Grid System for Every Executive View',
    prompt: `Write a 500-word executive-oriented article about a "universal dashboard constructor" — a single CSS Grid + container query system that renders any executive dashboard (supply chain, SaaS growth, risk & treasury, retail operations, IT service health, customer payments, eBill performance) with consistent theming, pastel palette rotation, gradient chart fills, glassmorphic tooltips, and free drag-to-move/resize with pointer events for PWA.

Business-focused, not overly technical. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Business Intelligence',
    keywords: 'dashboard constructor, CSS grid, executive dashboards, responsive dashboards, PWA dashboards, drag and resize, business intelligence',
    slug: 'universal-dashboard-constructor-system',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-meridian.html',
  },
  {
    title: 'Multi-Color Heatmaps with Translucent Cells: A Bloomberg-Terminal Visual Language',
    prompt: `Write a 500-word executive-oriented article about multi-color heatmap visualizations for executive dashboards. Cover: diverging color scales (red→amber→green for data crossing zero, warm pastel for positive data), translucent cell opacity (82%), rounded corners, shadow glow on emphasis, and always-visible value labels.

Explain how this visual language makes complex matrix data instantly scannable. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Data Visualization',
    keywords: 'heatmap visualization, multi-color heatmap, executive dashboards, data visualization, Bloomberg terminal, ECharts heatmap',
    slug: 'multicolor-heatmap-visual-language',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-meridian.html',
  },
  {
    title: 'AI Brief Cards: Streaming Groq Analysis for Every Executive Dashboard',
    prompt: `Write a 500-word executive-oriented article about AI Brief cards on executive dashboards. Cover: a 4-section AI brief (What Happened, Why, What to Expect, What to Do) that streams real-time analysis from Groq LLM based on the dashboard's actual data.

Explain how executives get an honest narrative summary — not just numbers. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Artificial Intelligence',
    keywords: 'AI brief, Groq, executive dashboards, AI analysis, automated insights, business intelligence, streaming AI, data storytelling',
    slug: 'ai-brief-cards-streaming-groq-analysis',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-velocity.html',
  },
  {
    title: 'Pastel Palette Rotation: Why Every Dashboard Visit Looks Slightly Different',
    prompt: `Write a 500-word executive-oriented article about pastel palette rotation in dashboard design. On each page load, a random hue offset (0-360°) is applied to all 12 base palette colors, with saturation kept at ~48% for a soft, pastel look.

Explain why this prevents dashboard fatigue and keeps the experience engaging. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Design',
    keywords: 'pastel palette, dashboard design, color rotation, HSL, user engagement, executive dashboards, UX design',
    slug: 'pastel-palette-rotation-dashboard-design',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-sentinel.html',
  },
  {
    title: 'Pointer Events for PWA: Drag, Move, Resize on Any Device',
    prompt: `Write a 500-word executive-oriented article about using Pointer Events (not mouse events) for drag-and-drop dashboard editing. PWAs on mobile/tablet generate touch events, not mouse events.

Explain how executives can customize their dashboard layout on an iPad or phone. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Technology',
    keywords: 'pointer events, PWA, drag and drop, touch support, mobile dashboards, responsive design, executive dashboards',
    slug: 'pointer-events-pwa-drag-move-resize',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-operations-universal.html',
  },
  {
    title: 'Glassmorphic Tooltips: Dark Glass UI for Chart Data Exploration',
    prompt: `Write a 500-word executive-oriented article about glassmorphic tooltip design for executive dashboards. Tooltips with backdrop-filter blur(8px), dark glass background, cyan border, rounded corners, and drop shadow.

Explain how this matches Bloomberg-terminal aesthetics and provides high contrast for data values. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Design',
    keywords: 'glassmorphism, tooltip design, dashboard UI, dark glass, backdrop filter, executive dashboards, data visualization UX',
    slug: 'glassmorphic-tooltips-chart-exploration',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-customer-payments.html',
  },
  {
    title: 'From Seven Renderers to One: Consolidating Executive Dashboards',
    prompt: `Write a 500-word executive-oriented article about consolidating multiple dashboard renderers into a single universal constructor class. Previously each dashboard had its own host page loading different JS. After migration, all 7 share one universal-dashboard.js with CSS Grid + container queries.

Explain the business benefits: consistent visual language, one codebase to maintain, instant propagation of improvements. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Business Intelligence',
    keywords: 'dashboard migration, universal dashboard, CSS grid, code consolidation, executive dashboards, business intelligence, dashboard architecture',
    slug: 'consolidating-executive-dashboards-one-class',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-ebill-performance.html',
  },
  {
    title: 'Gradient Chart Fills and Shadow Glow: Visual Polish That Sells',
    prompt: `Write a 500-word executive-oriented article about visual polish in executive dashboards: bar charts with vertical gradient fills (85% alpha at top → 25% at bottom), line charts with area gradient under the line, pie segments with per-segment colored shadow glow, and emphasis hover effects with shadowBlur 24.

Explain how visual polish builds executive confidence in the data. Write as flowing prose — no H2 section headers, no ## headings. Just natural paragraphs with **bold** key terms. 500 words.`,
    category: 'Data Visualization',
    keywords: 'gradient fills, chart design, executive dashboards, visual polish, ECharts, data visualization, shadow effects, dashboard aesthetics',
    slug: 'gradient-chart-fills-shadow-glow-visual-polish',
    demoUrl: 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-meridian.html',
  },
];

// ─── Utility functions ───────────────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
}
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

async function groqChat(prompt) {
  try {
    const res = await fetch(GROQ_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 4000,  // enough for 500+ words
        stream: false
      })
    });
    if (!res.ok) throw new Error(`Groq proxy returned ${res.status}`);
    const data = await res.json();
    // gpt-oss-120b is a reasoning model — output may be in 'reasoning' or 'content'
    const msg = data.choices?.[0]?.message || {};
    return (msg.content?.trim() || msg.reasoning?.trim() || '').split('\n').filter(l => !l.startsWith('The user') && !l.startsWith('We need') && !l.startsWith('Count') && !l.startsWith('Let')).join('\n').trim() || '';
  } catch (e) {
    console.error('Groq error:', e.message);
    return '';
  }
}

async function fetchRSS(feedUrl) {
  try {
    const res = await fetch(feedUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is)?.[1]?.trim() || '';
      const link = item.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/is)?.[1]?.trim() || '';
      const desc = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/is)?.[1]?.replace(/<[^>]+>/g,'').trim() || '';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/is)?.[1]?.trim() || '';
      items.push({ title, link, desc, pubDate });
    }
    return items;
  } catch (e) {
    console.error(`RSS fetch error for ${feedUrl}:`, e.message);
    return [];
  }
}

// ─── Blog post HTML template ─────────────────────────────────────────────
function generateBlogPostHTML({ title, body, category, sourceUrl, sourceName, keywords, slug, dateStr, isoDate }) {
  const readTime = Math.max(3, Math.ceil(body.split(/\s+/).length / 200));
  const sourceAttribution = sourceUrl ? `\n    <div class=\"article-source\">\n      <div class=\"article-source-label\"><i class=\"fas fa-link\"></i> ${sourceName ? 'Source' : 'Source Article'}</div>\n      <a href=\"${escAttr(sourceUrl)}\" target=\"_blank\" rel=\"noopener\">${escHtml(sourceName || sourceUrl)} <i class=\"fas fa-external-link-alt\" style=\"font-size:0.8em\"></i></a>\n    </div>` : '';
  
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#1E3A8A" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0F172A" media="(prefers-color-scheme: dark)" />
<title>${escHtml(title)} | Insight Analytics</title>
<meta name="description" content="${escAttr(body.replace(/<[^>]+>/g, "").slice(0, 155))}" />
<meta name="keywords" content="${escAttr(keywords)}" />
<meta name="author" content="Insight Analytics" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${SITE_URL}/insights/${slug}" />
<link rel="icon" type="image/png" sizes="32x32" href="../icons/favicon-32.png" />
<link rel="apple-touch-icon" sizes="180x180" href="../icons/apple-touch-icon.png" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escAttr(title)}" />
<meta property="og:description" content="${escAttr(body.replace(/<[^>]+>/g, "").slice(0, 155))}" />
<meta property="og:url" content="${SITE_URL}/insights/${slug}" />
<meta property="og:site_name" content="Insight Analytics" />
<meta property="article:published_time" content="${isoDate}" />
<meta property="article:author" content="Insight Analytics" />
<meta property="article:section" content="${escAttr(category)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escAttr(title)}" />
<meta name="twitter:description" content="${escAttr(body.replace(/<[^>]+>/g, "").slice(0, 155))}" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(title)},"description":${JSON.stringify(body.slice(0,155))},"author":{"@type":"Organization","name":"Insight Analytics","url":"${SITE_URL}/"},"publisher":{"@type":"Organization","name":"Insight Analytics","logo":{"@type":"ImageObject","url":"${SITE_URL}/icons/icon-512.png"}},"datePublished":"${dateStr}","dateModified":"${dateStr}","mainEntityOfPage":{"@type":"WebPage","@id":"${SITE_URL}/insights/${slug}"},"articleSection":${JSON.stringify(category)},"keywords":${JSON.stringify(keywords.split(',').map(k=>k.trim()))}}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="../css/styles.css" />
<style>html{scroll-snap-type:none!important}.article-hero{padding:calc(var(--nav-h) + 60px) 0 40px;text-align:center;background:linear-gradient(180deg,rgba(99,102,241,0.04) 0%,transparent 100%);border-bottom:1px solid var(--border)}.article-eyebrow{font-family:var(--font-head);font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:16px}.article-hero h1{font-size:clamp(1.8rem,5vw,2.6rem);font-weight:800;letter-spacing:-.02em;line-height:1.15;margin-bottom:20px}.article-meta{font-size:.85rem;color:var(--text-muted);display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap}.article-meta .sep{opacity:.4}.article-body{max-width:720px;margin:0 auto;padding:48px 24px 64px}.article-body p{font-size:1.06rem;line-height:1.75;margin-bottom:24px;color:var(--text)}.article-body strong{font-weight:700}.article-back{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-head);font-size:.88rem;font-weight:600;color:var(--text-muted);text-decoration:none;margin-bottom:32px}.article-back:hover{color:var(--accent)}.article-source{margin:32px 0;padding:20px;border-radius:12px;background:linear-gradient(135deg,rgba(99,102,241,0.06),rgba(6,182,212,0.04));border:1px solid var(--border)}.article-source-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:8px}.article-source a{color:var(--accent);text-decoration:none;font-weight:600;word-break:break-all}</style>
</head>
<body>
<header class="navbar" id="navbar">
<div class="nav-inner">
<a href="${SITE_URL}/" class="brand"><span class="brand-mark"><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="iaGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e0f7fa"/><stop offset="30%" stop-color="#80deea"/><stop offset="60%" stop-color="#00bcd4"/><stop offset="100%" stop-color="#0288d1"/></linearGradient></defs><rect x="2" y="8" width="16" height="84" fill="url(#iaGrad)"/><polygon points="21,92 34,92 60,8 47,8" fill="url(#iaGrad)"/><polygon points="85,92 98,92 73,8 60,8" fill="url(#iaGrad)"/></svg></span><span class="brand-name">Insight <b>Analytics</b></span></a>
<nav class="nav-links"><a href="${SITE_URL}/#services" class="nav-link">Services</a><a href="${SITE_URL}/#dashboard" class="nav-link">Dashboard</a><a href="${SITE_URL}/#cases" class="nav-link">Case Studies</a><a href="/insights/" class="nav-link">Insights</a><a href="/blog/" class="nav-link">Live Demos</a><a href="${SITE_URL}/#contact" class="nav-link">Contact</a></nav>
<div class="nav-actions"><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle theme"><i class="fas fa-sun" id="theme-icon"></i></button><a href="${SITE_URL}/#contact" class="btn btn-primary nav-cta"><i class="fas fa-calendar-check"></i> Book a Demo</a></div>
</div>
</header>
<main>
<section class="article-hero">
<div class="container">
<div class="article-eyebrow">${escHtml(category)}</div>
<h1>${escHtml(title)}</h1>
<div class="article-meta"><span>Insight Analytics</span><span class="sep">·</span><span>${new Date(dateStr).toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric"})}</span><span class="sep">·</span><span>${readTime} min read</span></div>
</div>
</section>
<section class="article-body" style="max-width:720px;margin:0 auto;padding:48px 24px 64px;">
<a href="/insights/" class="article-back"><i class="fas fa-arrow-left"></i> All Insights</a>
${body}
${sourceAttribution}
</section>
</main>
<footer style="padding:32px 24px;text-align:center;border-top:1px solid var(--border);">
<a href="/insights/" style="font-size:0.88rem;color:var(--text-muted);text-decoration:none;">← Back to all insights</a>
</footer>
<script>!function(){var t=document.getElementById("theme-toggle"),i=document.getElementById("theme-icon");function e(){var t=document.documentElement.getAttribute("data-theme");t="light"===t?"dark":"light",document.documentElement.setAttribute("data-theme",t);var e=document.getElementById("theme-icon");e&&("dark"===t?e.className="fas fa-moon":e.className="fas fa-sun")}t&&t.addEventListener("click",e);try{var h=localStorage.getItem("docchat-theme");h&&document.documentElement.setAttribute("data-theme",h)}catch(t){}}();</script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Auto-Blog Generator ===');
  console.log(`Time: ${ISO_NOW}`);
  
  const generated = [];
  
  // ── 1. RSS Article ──
  console.log('\n--- Fetching RSS feeds ---');
  let allRSSItems = [];
  for (const feed of RSS_FEEDS) {
    const items = await fetchRSS(feed.url);
    console.log(`  ${feed.name}: ${items.length} items`);
    allRSSItems.push(...items);
  }
  
  // Pick 1 random RSS item (not already blogged)
  const existingPosts = readdirSync(join(REPO_ROOT, 'insights')).filter(f => f.endsWith('.html') && f !== 'index.html');
  const availableItems = allRSSItems.filter(item => {
    const slug = slugify(item.title);
    return !existingPosts.includes(slug + '.html');
  });
  
  if (availableItems.length > 0) {
    const item = availableItems[Math.floor(Math.random() * availableItems.length)];
    console.log(`\n  Selected: ${item.title.slice(0, 60)}...`);
    
    const prompt = `You are an AI analyst writing for Insight Analytics, a Canadian analytics consultancy. Summarize this news article for an executive audience in exactly 500 words.

Article title: ${item.title}
Article description: ${item.desc}

Write a 500-word executive analysis as flowing prose. No section headers. No H2 headings. Just write naturally — start with what happened, transition to why it matters, end with what executives should do. All in one continuous narrative with paragraph breaks only. Use **bold** for key terms. No preamble. Start directly with the first paragraph.`;

    const body = await groqChat(prompt);
    if (body && body.length > 200) {
      // Convert markdown to HTML
      const htmlBody = body
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\n/g, '</p>\n<p>')
        .replace(/^<h2>/, '<p></p><h2>') // ensure first h2 has spacing
        .trim();
      
      const wrappedBody = '<p>' + htmlBody.replace(/^<p><\/p>/, '') + '</p>';
      
      const slug = slugify(item.title);
      const postHTML = generateBlogPostHTML({
        title: item.title,
        body: wrappedBody,
        category: 'Applied AI',
        sourceUrl: item.link,
        sourceName: 'Original article',
        keywords: 'artificial intelligence, AI business, applied AI, executive intelligence, ' + item.title.split(/\s+/).slice(0, 5).join(', ').toLowerCase(),
        slug,
        dateStr: DATE_STR,
        isoDate: ISO_NOW
      });
      
      writeFileSync(join(REPO_ROOT, 'insights', slug + '.html'), postHTML);
      generated.push({ slug, title: item.title, category: 'Applied AI', dateStr: DATE_STR, readTime: 3 });
      console.log(`  ✅ Generated: insights/${slug}.html`);
    }
  }
  
  // ── 2. Feature Article ──
  console.log('\n--- Generating feature article ---');
  // Pick a feature topic we haven't written about yet
  const availableFeatures = FEATURE_TOPICS.filter(t => !existingPosts.includes(t.slug + '.html') && !generated.find(g => g.slug === t.slug));
  
  if (availableFeatures.length > 0) {
    const topic = availableFeatures[Math.floor(Math.random() * availableFeatures.length)];
    console.log(`  Topic: ${topic.title}`);
    
    const body = await groqChat(topic.prompt);
    if (body && body.length > 200) {
      const htmlBody = body
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\n/g, '</p>\n<p>')
        .trim();
      const wrappedBody = '<p>' + htmlBody + '</p>';
      
      const postHTML = generateBlogPostHTML({
        title: topic.title,
        body: wrappedBody,
        category: topic.category,
        keywords: topic.keywords,
        slug: topic.slug,
        dateStr: DATE_STR,
        isoDate: ISO_NOW
      });
      
      writeFileSync(join(REPO_ROOT, 'insights', topic.slug + '.html'), postHTML);
      generated.push({ slug: topic.slug, title: topic.title, category: topic.category, dateStr: DATE_STR, readTime: 3 });
      console.log(`  ✅ Generated: insights/${topic.slug}.html`);
    }
  }
  
  // ── 3. Update insights/index.html ──
  if (generated.length > 0) {
    console.log('\n--- Updating insights/index.html ---');
    const indexPath = join(REPO_ROOT, 'insights', 'index.html');
    let indexHTML = readFileSync(indexPath, 'utf-8');
    
    // Find the first blog-card and insert new posts before it
    // Insert cards INSIDE the insights-grid div, after the last existing card
    // or after the opening div if no cards exist yet
    const gridMarker = '<div class="insights-grid" id="insights-list">';
    const gridIdx = indexHTML.indexOf(gridMarker);
    if (gridIdx > 0) {
      // Build the new card HTML FIRST
      const newCards = generated.map(post => {
        const dateFormatted = new Date(post.dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `    <a href="/insights/${post.slug}" class="insight-card">
      <div class="card-eyebrow">${post.category}</div>
      <h2>${escHtml(post.title)}</h2>
      <p>AI-generated executive analysis. ${post.readTime} min read.</p>
      <div class="card-meta">
        <span>Insight Analytics</span>
        <span class="sep">·</span>
        <span>${dateFormatted}</span>
        <span class="sep">·</span>
        <span>${post.readTime} min read</span>
      </div>
    </a>
`;
      }).join('');
      
      const insertPos = gridIdx + gridMarker.length;
      indexHTML = indexHTML.slice(0, insertPos) + newCards + indexHTML.slice(insertPos);
      writeFileSync(indexPath, indexHTML);
      console.log('  ✅ Updated insights/index.html');
    }
    
    // ── 4. Update sitemap.xml ──
    console.log('\n--- Updating sitemap.xml ---');
    const sitemapPath = join(REPO_ROOT, 'sitemap.xml');
    let sitemap = readFileSync(sitemapPath, 'utf-8');
    const newUrls = generated.map(post => `  <url>
    <loc>${SITE_URL}/insights/${post.slug}</loc>
    <lastmod>${post.dateStr}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
`).join('');
    
    sitemap = sitemap.replace('</urlset>', newUrls + '</urlset>');
    writeFileSync(sitemapPath, sitemap);
    console.log('  ✅ Updated sitemap.xml');
  }
  
  console.log(`\n=== Done: ${generated.length} articles generated ===`);
  generated.forEach(g => console.log(`  - ${g.title}`));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
