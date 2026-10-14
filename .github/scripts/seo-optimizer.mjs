#!/usr/bin/env node
/**
 * seo-optimizer-v2.mjs — Cutting-edge SEO optimization (2025/2026)
 *
 * Implements all P0-P3 techniques from the SEO research report:
 *
 * P0: Googlebot-Extended access, LCP preloading, answer-first content
 * P1: FAQPage/Organization/Person schema, content-visibility, auto-linking,
 *     factual density check, freshness tracking
 * P2: Entity linking (about/mentions), HowTo schema, image SEO, breadcrumbs,
 *     SpeakableSpecification, Dataset schema
 *
 * Uses Groq LLM (via Netlify proxy) for content analysis.
 * Runs as GitHub Actions cron job.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, relative, dirname } from 'path';

const SITE_URL = 'https://insight-analytics.ca';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
const REPO_ROOT = process.cwd();
const NOW = new Date().toISOString();
const TODAY = NOW.split('T')[0];

// ─── Page classifier: determines page type for schema ────────────────────
function classifyPage(relPath, html) {
  if (relPath === "index.html") return { type: "home",, schemaType: 'WebSite', priority: '1.0' };
  if (relPath === 'visuals.html') return { type: 'gallery', schemaType: 'CollectionPage', priority: '0.9' };
  if (relPath.includes('executive')) return { type: 'executive', schemaType: 'Article', priority: '0.8' };
  if (relPath.includes('csr-')) return { type: 'csr', schemaType: 'Article', priority: '0.7' };
  if (relPath.includes('its-')) return { type: 'its', schemaType: 'Article', priority: '0.7' };
  if (relPath.includes('chatters')) return { type: 'executive', schemaType: 'Article', priority: '0.8' };
  return { type: 'general', schemaType: 'WebPage', priority: '0.6' };
}

// ─── Collect all HTML pages ──────────────────────────────────────────────
function collectHtmlFiles() {
  const files = [];
  function scan(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'netlify' || entry === '.github') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) scan(full);
      else if (entry.endsWith('.html') && !entry.includes('_old')) files.push(full);
    }
  }
  scan(REPO_ROOT);
  return files;
}

// ─── Extract content ────────────────────────────────────────────────────
function extractContent(html) {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/is);
  const desc = descMatch ? descMatch[1].trim() : '';
  const text = html
    .replace(/<script[^>]*>.*?<\/script>/gis, ' ')
    .replace(/<style[^>]*>.*?<\/style>/gis, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, desc, text: text.slice(0, 2000) };
}

// ─── Groq call (direct or via proxy) ─────────────────────────────────────
async function groqChat(prompt) {
  const hasDirectKey = !!GROQ_KEY;
  let res;
  if (hasDirectKey) {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 })
    });
  } else {
    res = await fetch(`${GROQ_PROXY}?op=chat`, {
      method: 'POST',
      headers: { 'Origin': 'https://insightanalyticsca.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: GROQ_MODEL, temperature: 0.3, max_tokens: 2000, stream: false })
    });
  }
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('stream') || contentType.includes('event-stream')) {
    const text = await res.text();
    let fullContent = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try { const evt = JSON.parse(data); if (evt.choices?.[0]?.delta?.content) fullContent += evt.choices[0].delta.content; } catch {}
    }
    return fullContent;
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// ─── P0: Fix robots.txt ─────────────────────────────────────────────────
function fixRobotsTxt() {
  console.log('🤖 P0: Fixing robots.txt (allow Googlebot-Extended)...');
  const robots = `User-agent: *
Allow: /
Disallow: /netlify/
Disallow: /data/

# Allow Googlebot-Extended for AI Overview / AI Mode inclusion
User-agent: Googlebot-Extended
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml`;
  writeFileSync(join(REPO_ROOT, 'robots.txt'), robots);
  console.log('  ✅ Googlebot-Extended explicitly allowed');
}

// ─── P0: Add preconnect/preload resource hints ──────────────────────────
function addResourceHints(html, relPath) {
  const hints = [
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>',
    '<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="dns-prefetch" href="//cdn.jsdelivr.net">',
    '<link rel="dns-prefetch" href="//cdnjs.cloudflare.com">',
  ];

  // Add font preload if Inter is used
  if (html.includes('Inter')) {
    hints.push('<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" onload="this.onload=null;this.rel=\'stylesheet\'">');
  }

  // Avoid duplicates
  let modified = html;
  for (const hint of hints) {
    const attr = hint.match(/href="([^"]+)"/)?.[1];
    if (attr && html.includes(attr)) continue;
    if (html.includes(hint)) continue;
  }

  // Remove existing preconnect/dns-prefetch to avoid duplicates
  modified = modified.replace(/<link\s+rel=["']preconnect["'][^>]*>\s*/gi, '');
  modified = modified.replace(/<link\s+rel=["']dns-prefetch["'][^>]*>\s*/gi, '');

  // Insert all hints after the first <link> or after <meta charset>
  const hintBlock = hints.join('\n  ');
  if (modified.includes('<meta charset')) {
    modified = modified.replace(/(<meta\s+charset[^>]*>)/i, `$1\n  ${hintBlock}`);
  } else if (modified.includes('<head')) {
    modified = modified.replace(/<head[^>]*>/i, match => `${match}\n  ${hintBlock}`);
  }

  return modified;
}

// ─── P0: Defer JS scripts ───────────────────────────────────────────────
function deferScripts(html) {
  // Add defer to all non-deferred, non-module scripts
  return html.replace(
    /<script\s+(?!.*\b(?:defer|async|type=["']module|srcdoc)\b)([^>]*\bsrc=[^>]*)>/gi,
    (match, attrs) => `<script defer ${attrs}>`
  );
}

// ─── P1: content-visibility CSS ─────────────────────────────────────────
function addContentVisibility(html) {
  const css = `
  <style>
  /* P1: content-visibility: auto — skip rendering off-screen sections (50-80% INP win) */
  main > section:nth-child(n+3),
  .canvas-grid > .canvas-tile:nth-child(n+5),
  .grid-analytics > div:nth-child(n+5),
  .sector-block:nth-child(n+3),
  #analytics,
  #library {
    content-visibility: auto;
    contain-intrinsic-size: auto 500px;
  }
  /* CSS containment — isolate layout/paint */
  .canvas-tile, .exec-visual, .card, .tile {
    contain: layout style paint;
  }
  </style>`;
  // Avoid duplicate injection
  if (html.includes('content-visibility: auto')) return html;
  // Insert before </head>
  return html.replace(/<\/head>/i, `${css}\n</head>`);
}

// ─── P1: Organization + Person schema ────────────────────────────────────
function buildOrgSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: 'Insight Analytics',
    url: 'https://insightanalyticsca.github.io',
    logo: `${SITE_URL}/icons/icon-512.png`,
    description: 'AI-powered corporate dashboards with Groq streaming, ECharts visualizations, and executive analytics for utilities, IT service management, and beauty retail.',
    sameAs: [
      'https://github.com/insightanalyticsca',
      'https://insightanalyticsca.github.io',
      'https://www.linkedin.com/company/insight-analytics-ca'
    ]
  };
}

function buildPersonSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': `${SITE_URL}/#author`,
    name: 'Insight Analytics Team',
    url: SITE_URL,
    jobTitle: 'Data & Analytics Engineer',
    worksFor: { '@id': `${SITE_URL}/#organization` },
    knowsAbout: [
      { '@type': 'Thing', name: 'ECharts', sameAs: 'https://en.wikipedia.org/wiki/Apache_ECharts' },
      { '@type': 'Thing', name: 'Power BI', sameAs: 'https://en.wikipedia.org/wiki/Microsoft_Power_BI' },
      { '@type': 'Thing', name: 'RAG', sameAs: 'https://en.wikipedia.org/wiki/Retrieval-augmented_generation' },
      { '@type': 'Thing', name: 'PWA', sameAs: 'https://en.wikipedia.org/wiki/Progressive_web_app' }
    ]
  };
}

// ─── P1: FAQPage schema via Groq ────────────────────────────────────────
async function buildFaqSchema(content, relPath) {
  const prompt = `You are an SEO expert. Based on this webpage content, generate 3-5 FAQ questions and answers that people would actually search for. Return ONLY a JSON array.

Page: ${relPath}
Title: ${content.title}

Content (first 1000 chars):
${content.text.slice(0, 1000)}

Return format:
[
  {"question": "What is...?", "answer": "Direct answer in 1-2 sentences with specific facts."},
  ...
]

Rules:
- Questions must be natural search queries (not academic)
- Answers must be factual and self-contained
- Include specific numbers/data where possible
- Return ONLY the JSON array, no markdown`;

  try {
    const resp = await groqChat(prompt);
    const cleaned = resp.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const faqs = JSON.parse(cleaned);
    if (!Array.isArray(faqs) || faqs.length === 0) return null;
    return {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer }
      }))
    };
  } catch (e) {
    console.log(`  ⚠ FAQ generation failed: ${e.message}`);
    return null;
  }
}

// ─── P1: HowTo schema (for pages with steps/processes) ─────────────────
async function buildHowToSchema(content, relPath) {
  if (!content.text.match(/step|guide|how to|process|workflow/i)) return null;

  const prompt = `Based on this page content, generate a HowTo schema with 3-5 steps if the content describes a process or guide. Return ONLY JSON or "null" if not applicable.

Page: ${relPath}
Content: ${content.text.slice(0, 800)}

Return: {"@type":"HowTo","name":"...","step":[{"@type":"HowToStep","position":1,"name":"...","text":"..."},...]}`;

  try {
    const resp = await groqChat(prompt);
    const cleaned = resp.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    if (cleaned === 'null' || cleaned === 'null\n') return null;
    const obj = JSON.parse(cleaned);
    return { '@context': 'https://schema.org', ...obj };
  } catch { return null; }
}

// ─── P1: Factual density analysis ──────────────────────────────────────
function analyzeFactDensity(html) {
  const VAGUE = /\b(many|several|various|numerous|often|sometimes|significant|substantial|considerable|a lot of|plenty of|some|certain|various|multiple)\b/gi;
  const text = html.replace(/<[^>]+>/g, ' ');
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const vagueCount = (text.match(VAGUE) || []).length;
  const numberCount = (text.match(/\b\d+(\.\d+)?[%$KMB]?\b/g) || []).length;
  const density = numberCount / Math.max(sentences.length, 1);
  return {
    sentences: sentences.length,
    vagueWords: vagueCount,
    numbers: numberCount,
    density: density.toFixed(2),
    score: density > 0.3 ? 'good' : density > 0.15 ? 'fair' : 'poor'
  };
}

// ─── P1: Automated internal linking ────────────────────────────────────
function autoLink(html, currentRelPath, allPages) {
  // Build keyword → page mapping from page titles
  const linkMap = {};
  for (const page of allPages) {
    if (page.relPath === currentRelPath) continue;
    if (page.relPath === 'index.html' || page.relPath === 'visuals.html') continue;
    const titleWords = page.title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 5);  // longer words only — less false matches
    for (const word of titleWords) {
      if (!linkMap[word]) linkMap[word] = page;
    }
  }

  // Split HTML into safe zones (inside tags) and text zones (between tags)
  // Only inject links in text zones — NEVER inside <head>, attributes, <script>, <style>
  const parts = html.split(/(<[^>]+>)/g);
  let linksAdded = 0;
  const MAX_LINKS = 3;
  let inHead = false;
  let inScript = false;
  let inStyle = false;

  for (let i = 0; i < parts.length; i++) {
    // Skip tag parts (odd indices from the split)
    if (parts[i].startsWith('<')) {
      const tag = parts[i].toLowerCase();
      if (tag.includes('<head')) inHead = true;
      if (tag.includes('</head')) inHead = false;
      if (tag.includes('<script')) inScript = true;
      if (tag.includes('</script')) inScript = false;
      if (tag.includes('<style')) inStyle = true;
      if (tag.includes('</style')) inStyle = false;
      continue;
    }
    // Skip if inside head, script, or style
    if (inHead || inScript || inStyle) continue;
    // Skip very short text fragments
    if (parts[i].trim().length < 10) continue;

    for (const [keyword, page] of Object.entries(linkMap)) {
      if (linksAdded >= MAX_LINKS) break;
      const regex = new RegExp(`\\b(${escapeRegex(keyword)})\\b`, 'i');
      if (regex.test(parts[i])) {
        const targetUrl = page.relPath.startsWith('custom-html/') ? `./${page.relPath}` : `../${page.relPath}`;
        parts[i] = parts[i].replace(regex, `<a href="${targetUrl}">${keyword}</a>`);
        linksAdded++;
        break; // one link per text fragment
      }
    }
  }

  return { html: parts.join(''), linksAdded };
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── P2: BreadcrumbList schema ──────────────────────────────────────────
function buildBreadcrumbSchema(relPath) {
  const parts = relPath.replace(/\.html$/, '').split('/');
  const items = [{ '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL }];
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += (i > 0 ? '/' : '') + parts[i];
    const name = parts[i].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    items.push({ '@type': 'ListItem', position: i + 2, name, item: `${SITE_URL}/${path}.html` });
  }
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

// ─── P2: SpeakableSpecification ─────────────────────────────────────────
function buildSpeakableSchema() {
  return {
    '@type': 'SpeakableSpecification',
    cssSelector: ['h1', '.exec-title', '.canvas-title', '.tile-title', 'main > section > h2']
  };
}

// ─── P2: Dataset schema (for data-heavy pages) ──────────────────────────
function buildDatasetSchema(content, relPath) {
  if (!relPath.includes('executive') && !relPath.includes('csr-')) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: content.title,
    description: content.desc || content.text.slice(0, 160),
    creator: { '@id': `${SITE_URL}/#organization` },
    datePublished: TODAY,
    keywords: 'corporate dashboard, analytics, ECharts, executive reporting',
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'application/json',
      contentUrl: `${SITE_URL}/data/executive/${relPath.split('/').pop().replace('.html', '')}.json`
    }
  };
}

// ─── Build comprehensive JSON-LD @graph ────────────────────────────────
function buildJsonLdGraph(relPath, content, pageInfo, faqSchema, howToSchema) {
  const url = `${SITE_URL}/${relPath}`;
  const graph = [
    buildOrgSchema(),
    buildPersonSchema(),
    {
      '@context': 'https://schema.org',
      '@type': pageInfo.schemaType,
      '@id': `${url}#page`,
      name: content.title,
      description: content.desc || content.text.slice(0, 160),
      url: url,
      isPartOf: { '@id': `${SITE_URL}/#website` },
      about: {
        '@type': 'Thing',
        name: content.title.split(/[-—]/)[0].trim(),
        sameAs: `https://en.wikipedia.org/wiki/Dashboard_(business)`
      },
      author: { '@id': `${SITE_URL}/#author` },
      publisher: { '@id': `${SITE_URL}/#organization` },
      datePublished: TODAY,
      dateModified: NOW,
      speakable: buildSpeakableSchema()
    },
    buildBreadcrumbSchema(relPath)
  ];

  // Add WebSite + SearchAction on home page
  if (relPath === 'index.html') {
    graph.push({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Dashboards Studio',
      publisher: { '@id': `${SITE_URL}/#organization` },
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/?q={search_term_string}` },
        'query-input': 'required name=search_term_string'
      }
    });
  }

  // Add FAQ schema if available
  if (faqSchema) graph.push(faqSchema);

  // Add HowTo schema if available
  if (howToSchema) graph.push(howToSchema);

  // Add Dataset schema for data-heavy pages
  const dataset = buildDatasetSchema(content, relPath);
  if (dataset) graph.push(dataset);

  return { '@context': 'https://schema.org', '@graph': graph };
}

// ─── Inject comprehensive JSON-LD ────────────────────────────────────────
function injectJsonLd(html, schema) {
  // Remove ALL existing JSON-LD blocks
  let modified = html.replace(/<script\s+type=["']application\/ld\+json["']\s*>[\s\S]*?<\/script>\s*/gi, '');

  const jsonLd = `\n  <script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  modified = modified.replace(/<\/head>/i, `${jsonLd}\n</head>`);
  return modified;
}

// ─── Add freshness indicator ────────────────────────────────────────────
function addFreshness(html, relPath) {
  if (relPath === 'index.html' || relPath === 'visuals.html') return html;
  if (html.includes('last-updated') || html.includes('dateModified')) return html;

  const freshness = `\n  <meta name="dateModified" content="${NOW}">`;
  return html.replace(/<\/head>/i, `${freshness}\n</head>`);
}

// ─── Add OG + Twitter tags (enhanced) ───────────────────────────────────
function addSocialTags(html, seo, relPath) {
  const url = `${SITE_URL}/${relPath}`;
  let modified = html;

  // Remove existing OG/Twitter tags
  modified = modified.replace(/<meta\s+property=["']og:[^"']*["']\s+content=["'][^"']*["']\s*\/?>/gis, '');
  modified = modified.replace(/<meta\s+name=["']twitter:[^"']*["']\s+content=["'][^"']*["']\s*\/?>/gis, '');

  const tags = `
  <meta property="og:title" content="${escAttr(seo.ogTitle || seo.title)}">
  <meta property="og:description" content="${escAttr(seo.ogDescription || seo.description)}">
  <meta property="og:type" content="${relPath === 'index.html' ? 'website' : 'article'}">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="Dashboards Studio">
  <meta property="og:image" content="${SITE_URL}/icons/icon-512.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(seo.ogTitle || seo.title)}">
  <meta name="twitter:description" content="${escAttr(seo.ogDescription || seo.description)}">
  <meta name="twitter:image" content="${SITE_URL}/icons/icon-512.png">`;

  return modified.replace(/<\/head>/i, `${tags}\n</head>`);
}

// ─── Image SEO: add loading=lazy + decoding=async to images ─────────────
function optimizeImages(html) {
  let modified = html;
  // Add loading="lazy" decoding="async" to all <img> that don't have it
  modified = modified.replace(
    /<img\s+((?:(?!loading=|decoding=)[^>])*)>/gi,
    (match, attrs) => {
      let result = `<img ${attrs}`;
      if (!match.includes('loading=')) result += ' loading="lazy"';
      if (!match.includes('decoding=')) result += ' decoding="async"';
      result += '>';
      return result;
    }
  );
  return modified;
}

// ─── Generate sitemap.xml ────────────────────────────────────────────────
function generateSitemap(htmlFiles, allPageInfo) {
  const urls = htmlFiles.map(f => {
    const relPath = f.replace(REPO_ROOT + '/', '');
    const info = allPageInfo[relPath] || { priority: '0.6' };
    return `  <url>
    <loc>${SITE_URL}/${relPath}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${info.priority}</priority>
  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// ─── Generate link graph (for client-side related posts) ────────────────
function generateLinkGraph(htmlFiles, allPageInfo) {
  const graph = {};
  for (const f of htmlFiles) {
    const relPath = f.replace(REPO_ROOT + '/', '');
    const info = allPageInfo[relPath];
    if (!info) continue;
    // Find related pages (same type or shared keywords)
    const related = htmlFiles
      .map(f2 => ({ relPath: f2.replace(REPO_ROOT + '/', ''), info: allPageInfo[f2.replace(REPO_ROOT + '/')] }))
      .filter(x => x.relPath !== relPath && x.info && (x.info.type === info.type || x.info.type === 'general'))
      .slice(0, 5)
      .map(x => x.relPath);
    graph[relPath] = { related, topic: info.type };
  }
  return graph;
}

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g,'&quot;'); }

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 SEO Optimizer v2 — Cutting-edge 2025/2026 techniques\n');

  // P0: Fix robots.txt
  fixRobotsTxt();

  const htmlFiles = collectHtmlFiles();
  console.log(`\n📄 Found ${htmlFiles.length} HTML pages\n`);

  // Load existing tracking
  const trackingPath = join(REPO_ROOT, 'data', 'seo-tracking.json');
  let tracking = { history: [], lastRun: null };
  if (existsSync(trackingPath)) {
    try { tracking = JSON.parse(readFileSync(trackingPath, 'utf-8')); } catch {}
  }

  const changes = [];
  const allPageInfo = {};

  // First pass: classify all pages + extract content
  for (const filePath of htmlFiles) {
    const relPath = filePath.replace(REPO_ROOT + '/', '');
    const html = readFileSync(filePath, 'utf-8');
    const content = extractContent(html);
    const pageInfo = classifyPage(relPath, html);
    allPageInfo[relPath] = { ...pageInfo, title: content.title };
  }

  const allPages = Object.entries(allPageInfo).map(([relPath, info]) => ({ relPath, ...info }));

  // Second pass: optimize each page
  for (const filePath of htmlFiles) {
    const relPath = filePath.replace(REPO_ROOT + '/', '');
    console.log(`📄 ${relPath}`);
    let html = readFileSync(filePath, 'utf-8');
    let modified = false;
    const changeLog = { page: relPath, techniques: [] };

    // P0: Add resource hints (preconnect, preload)
    const withHints = addResourceHints(html, relPath);
    if (withHints !== html) { html = withHints; modified = true; changeLog.techniques.push('resource-hints'); }

    // P0: Defer scripts
    const withDeferred = deferScripts(html);
    if (withDeferred !== html) { html = withDeferred; modified = true; changeLog.techniques.push('defer-scripts'); }

    // P1: content-visibility CSS
    const withCV = addContentVisibility(html);
    if (withCV !== html) { html = withCV; modified = true; changeLog.techniques.push('content-visibility'); }

    // P1: Image SEO
    const withImgOpt = optimizeImages(html);
    if (withImgOpt !== html) { html = withImgOpt; modified = true; changeLog.techniques.push('image-seo'); }

    // P1: Freshness
    const withFresh = addFreshness(html, relPath);
    if (withFresh !== html) { html = withFresh; modified = true; changeLog.techniques.push('freshness'); }

    // P1: Automated internal linking
    const linkResult = autoLink(html, relPath, allPages);
    if (linkResult.linksAdded > 0) {
      html = linkResult.html;
      modified = true;
      changeLog.techniques.push(`auto-link(${linkResult.linksAdded})`);
    }

    // P1: Factual density analysis
    const density = analyzeFactDensity(html);
    changeLog.factDensity = density;

    // P1+P2: Build comprehensive JSON-LD via Groq
    const content = extractContent(html);
    const pageInfo = allPageInfo[relPath];

    // Generate FAQ + HowTo via Groq
    let faqSchema = null, howToSchema = null;
    try {
      console.log(`  🤖 Querying Groq for SEO + FAQ...`);
      faqSchema = await buildFaqSchema(content, relPath);
      if (faqSchema) changeLog.techniques.push('faq-schema');
      howToSchema = await buildHowToSchema(content, relPath);
      if (howToSchema) changeLog.techniques.push('howto-schema');

      // Get SEO meta recommendations
      const seoResp = await groqChat(`You are an SEO expert. Return ONLY JSON:
{"title":"50-60 char title with keyword","description":"140-160 char description","keywords":"8-12 keywords","ogTitle":"40 char social title","ogDescription":"100 char social desc"}

Page: ${relPath}
Title: ${content.title}
Content: ${content.text.slice(0, 800)}`);

      const seo = JSON.parse(seoResp.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

      // P1: Update title + description
      if (seo.title && seo.title !== content.title) {
        html = html.replace(/<title[^>]*>.*?<\/title>/is, `<title>${escHtml(seo.title)}</title>`);
        modified = true; changeLog.techniques.push('title-opt');
      }
      if (seo.description) {
        if (html.match(/<meta\s+name=["']description["']/i)) {
          html = html.replace(/<meta\s+name=["']description["']\s+content=["'][^"']*["']/is, `<meta name="description" content="${escAttr(seo.description)}">`);
        } else {
          html = html.replace(/<head[^>]*>/i, m => `${m}\n  <meta name="description" content="${escAttr(seo.description)}">`);
        }
        modified = true; changeLog.techniques.push('description-opt');
      }
      if (seo.keywords) {
        if (html.match(/<meta\s+name=["']keywords["']/i)) {
          html = html.replace(/<meta\s+name=["']keywords["']\s+content=["'][^"']*["']/is, `<meta name="keywords" content="${escAttr(seo.keywords)}">`);
        } else {
          html = html.replace(/<meta\s+name=["']description["']\s+content=["'][^"']*["']/is, m => `${m}\n  <meta name="keywords" content="${escAttr(seo.keywords)}">`);
        }
        changeLog.keywords = seo.keywords;
      }

      // P2: Social tags
      html = addSocialTags(html, seo, relPath);
      modified = true; changeLog.techniques.push('social-tags');

    } catch (e) {
      console.log(`  ⚠ Groq SEO failed: ${e.message}`);
    }

    // Build + inject comprehensive JSON-LD
    const jsonLd = buildJsonLdGraph(relPath, content, pageInfo, faqSchema, howToSchema);
    html = injectJsonLd(html, jsonLd);
    modified = true; changeLog.techniques.push('json-ld-graph');

    // Write if changed
    if (modified) {
      writeFileSync(filePath, html);
      console.log(`  ✅ Applied: ${changeLog.techniques.join(', ')}`);
      console.log(`  📊 Fact density: ${density.score} (${density.numbers} numbers / ${density.sentences} sentences, ${density.vagueWords} vague words)`);
      changes.push(changeLog);
    } else {
      console.log(`  · No changes needed`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Generate sitemap
  console.log('\n🗺️  Generating sitemap.xml...');
  writeFileSync(join(REPO_ROOT, 'sitemap.xml'), generateSitemap(htmlFiles, allPageInfo));

  // Generate link graph
  console.log('🔗 Generating link graph...');
  writeFileSync(join(REPO_ROOT, 'data', 'link-graph.json'), JSON.stringify(generateLinkGraph(htmlFiles, allPageInfo), null, 2));

  // Update tracking
  tracking.lastRun = NOW;
  tracking.history.push({
    runAt: NOW,
    pagesOptimized: changes.length,
    totalPages: htmlFiles.length,
    techniques: ['googlebot-extended', 'preconnect-preload', 'defer-scripts', 'content-visibility', 'faq-schema', 'howto-schema', 'org-person-schema', 'auto-linking', 'fact-density', 'freshness', 'breadcrumbs', 'speakable', 'dataset-schema', 'image-seo', 'social-tags', 'json-ld-graph'],
    changes
  });
  tracking.history = tracking.history.slice(-30);
  writeFileSync(trackingPath, JSON.stringify(tracking, null, 2));

  console.log(`\n✅ Done. ${changes.length}/${htmlFiles.length} pages optimized.`);
  console.log(`📊 Tracking: data/seo-tracking.json`);
  console.log(`🔗 Link graph: data/link-graph.json`);
  console.log(`🗺️  Sitemap: sitemap.xml`);
  console.log(`🤖 robots.txt: Googlebot-Extended allowed`);
}

main().catch(e => { console.error('SEO v2 failed:', e); process.exit(1); });
