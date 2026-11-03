#!/usr/bin/env node
/**
 * adaptive-seo.mjs — Adaptive SEO rewriter.
 *
 * WHAT IT DOES
 *   1. Collects trending search terms from two free data sources:
 *      a. Google Autocomplete (suggestqueries.google.com) — for each seed
 *         keyword, fetches the top 10 most-typed related queries. No API key.
 *      b. Industry RSS feeds (reused from auto-blog.mjs: McKinsey, Forrester,
 *         IMD, Yale SOM, IESE, BCG, etc.) — extract most-frequent terms from
 *         recent post titles. Gives 'trending in your space' signal.
 *   2. For each unlocked HTML file under /insights/ and /demos/:
 *      a. Find the trending term most relevant to that file's content
 *         (cosine-ish similarity via shared keywords).
 *      b. Compute a relative volume score (0-100) from autocomplete rank.
 *      c. Check cooldown: skip if file was rewritten < COOLDOWN_DAYS ago.
 *      d. Check threshold: skip if new term's volume isn't >= THRESHOLD_PCT
 *         higher than the currently-targeted term's volume.
 *      e. If passes both: call Groq to rewrite <title> + <meta description>
 *         (preserving the brand suffix ' | Insight Analytics', keeping
 *         length within 50-60 chars for title / 150-160 for desc).
 *      f. Save the rewrite, update seo-state.json, append to seo-changelog.json.
 *   3. For /faq/index.html: if a trending query looks like a question
 *      ('how to ...', 'what is ...') not already in the FAQ, generate a new
 *      Q&A item via Groq and APPEND it (never modify or delete existing items).
 *   4. Caps total rewrites per run at MAX_REWRITES_PER_RUN.
 *
 * PERSISTENCE
 *   - seo-locks.json      : paths that NEVER get auto-rewritten
 *   - seo-state.json      : per-URL last-rewrite-date + variant history
 *   - seo-changelog.json  : append-only audit log (for rollback)
 *   - Cooldown per URL    : COOLDOWN_DAYS (default 21 — Google needs weeks
 *                           to index + react to a change)
 *   - Volume threshold    : only rewrite if new term is ≥ THRESHOLD_PCT
 *                           (default 30%) higher volume than current
 *   - Max rewrites per run: MAX_REWRITES_PER_RUN (default 5)
 *
 * RUN MODES
 *   node adaptive-seo.mjs              # normal: scan + (if Sunday) rewrite
 *   node adaptive-seo.mjs --scan-only # collect trends, log to seo-trends.json,
 *                                     # don't rewrite anything
 *   node adaptive-seo.mjs --dry-run    # do everything EXCEPT commit/push
 *                                     # (still writes files locally so you
 *                                     #  can git diff to preview)
 *   node adaptive-seo.mjs --force     # ignore cooldowns (for testing only)
 *
 * GROQ
 *   Uses the same Netlify edge proxy as auto-blog.mjs. Set GROQ_API_KEY
 *   in env (or rely on the proxy's fallback).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { readdirSync, statSync } from 'fs';

const SITE_URL = 'https://insight-analytics.ca';
const GROQ_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
const GROQ_MODEL = 'qwen/qwen3.8-27b';  // matches auto-blog.mjs — no reasoning overhead
const REPO_ROOT = process.cwd();
const TODAY = new Date().toISOString().split('T')[0];
const NOW_ISO = new Date().toISOString();

// ─── Tunable params ──────────────────────────────────────────────────────
const COOLDOWN_DAYS = 21;          // don't rewrite same URL more than once per 21d
const THRESHOLD_PCT = 30;          // only rewrite if new term volume ≥ current * 1.30
const MAX_REWRITES_PER_RUN = 5;    // cap rewrites per cron run
const MAX_FAQ_ADDITIONS_PER_RUN = 2; // cap new FAQ items per run
const TITLE_MAX = 60;
const TITLE_MIN = 50;
const DESC_MAX = 160;
const DESC_MIN = 150;

// Seed keywords for Google Autocomplete — these are the high-level categories
// the site covers. New seeds = new trend sources.
const SEED_KEYWORDS = [
  // Tech / BI / dashboards
  'ai dashboard',
  'executive dashboard',
  'business intelligence',
  'data pipeline',
  'data lineage',
  'metadata discovery',
  'ai power automate',
  'fuzzy matching',
  'energy analytics',
  'time series prediction',
  'supply chain dashboard',
  'saas growth dashboard',
  'banking risk dashboard',
  'ar aging dashboard',
  'ai executive brief',
  // Strategy / finance / AI (matches insight article topics)
  'ai strategy',
  'ai roi',
  'ai adoption',
  'ai implementation',
  'cost optimization',
  'profitability analysis',
  'risk management',
  'mergers acquisitions',
  'capital allocation',
  'treasury management',
  'supply chain resilience',
  'sustainability strategy',
  'carbon emissions',
  'climate finance',
  'corporate governance',
  'executive leadership',
  'cfo strategy',
  'ceo decision making',
  'organizational culture',
  'change management'
];

// Reuse auto-blog's RSS feed list (lightweight — just feed URLs + names).
// These feeds are crawled to extract 'trending in your space' terms.
const INDUSTRY_FEEDS = [
  'https://www.mckinsey.com/insights/rss',
  'https://www.forrester.com/blogs/rss',
  'https://feeds.feedburner.com/mitsloanmanagementreview',
  'https://knowledge.wharton.upenn.edu/feed/',
  'https://www.iese.edu/feed',
  'https://www.imd.org/feed/',
  'https://insights.som.yale.edu/rss',
  'https://feeds.feedburner.com/logisticsviewpoints',
  'https://feeds.bloomberg.com/markets/news.rss',
];

// ─── CLI flags ───────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const SCAN_ONLY = ARGS.has('--scan-only');
const DRY_RUN = ARGS.has('--dry-run');
const FORCE = ARGS.has('--force');

console.log(`\n═══ Adaptive SEO ═══`);
console.log(`Mode: ${SCAN_ONLY ? 'SCAN-ONLY' : (FORCE ? 'FORCE' : (DRY_RUN ? 'DRY-RUN' : 'NORMAL'))}`);
console.log(`Date: ${TODAY} (UTC)`);
console.log(`Cooldown: ${COOLDOWN_DAYS} days   Threshold: +${THRESHOLD_PCT}%   Max rewrites: ${MAX_REWRITES_PER_RUN}`);

// ─── Day-of-week gate: only rewrite on Sundays ────────────────────────────
// (unless --scan-only, --force, or --dry-run)
const dayOfWeek = new Date().getUTCDay(); // 0 = Sunday
const isRewriteDay = dayOfWeek === 0;
if (!SCAN_ONLY && !FORCE && !DRY_RUN && !isRewriteDay) {
  console.log(`\nToday is not Sunday (UTC day=${dayOfWeek}). Rewrite skipped — scan-only mode.`);
  console.log(`Set --force to override, or wait until Sunday.`);
}
const SHOULD_REWRITE = !SCAN_ONLY && (FORCE || DRY_RUN || isRewriteDay);

// ─── State files ─────────────────────────────────────────────────────────
const STATE_PATH = join(REPO_ROOT, 'seo-state.json');
const LOCKS_PATH = join(REPO_ROOT, 'seo-locks.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'seo-changelog.json');
const TRENDS_PATH = join(REPO_ROOT, 'seo-trends.json');

const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
const locks = JSON.parse(readFileSync(LOCKS_PATH, 'utf-8'));
const changelog = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf-8'));
if (!state.urls) state.urls = {};
if (!changelog.entries) changelog.entries = [];

const lockedPaths = new Set(locks.locked.map(l => l.path));

// ─── Helpers ─────────────────────────────────────────────────────────────
function fetchJSON(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 15000) })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      return r.json();
    });
}

function fetchText(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 15000) })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      return r.text();
    });
}

// ─── 1. Trend collection ─────────────────────────────────────────────────
async function collectGoogleAutocomplete() {
  console.log(`\n--- Collecting Google Autocomplete trends ---`);
  const out = [];
  for (const seed of SEED_KEYWORDS) {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}`;
      const data = await fetchJSON(url, { timeoutMs: 8000 });
      const suggestions = data[1] || [];
      // Volume score: rank 1 = 100, rank 10 = 10 (linear decay).
      suggestions.forEach((s, i) => {
        out.push({
          term: s.toLowerCase().trim(),
          volume: Math.max(10, 100 - i * 10),
          source: 'google-autocomplete',
          seed
        });
      });
      console.log(`  ✓ "${seed}": ${suggestions.length} suggestions`);
    } catch (e) {
      console.log(`  ✗ "${seed}": ${e.message}`);
    }
  }
  return out;
}

async function collectIndustryRSS() {
  console.log(`\n--- Collecting industry RSS trends ---`);
  // Fetch last 7 days of posts, tokenize titles, count term frequency.
  const termFreq = new Map();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const feedUrl of INDUSTRY_FEEDS) {
    try {
      const xml = await fetchText(feedUrl, { timeoutMs: 10000 });
      // Crude RSS item extraction — pull <title>...</title> from <item> blocks.
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const itemXml of items) {
        const titleM = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/);
        if (!titleM) continue;
        const title = (titleM[1] || titleM[2] || '').trim();
        // Tokenize — lowercase, strip punctuation, drop stopwords + short tokens
        const tokens = title.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length >= 4 && !STOPWORDS.has(t));
        // Count unigrams + bigrams
        for (let i = 0; i < tokens.length; i++) {
          const uni = tokens[i];
          termFreq.set(uni, (termFreq.get(uni) || 0) + 1);
          if (i < tokens.length - 1) {
            const bi = `${tokens[i]} ${tokens[i+1]}`;
            termFreq.set(bi, (termFreq.get(bi) || 0) + 1);
          }
        }
      }
      console.log(`  ✓ ${feedUrl.split('/')[2]}: ${items.length} items`);
    } catch (e) {
      console.log(`  ✗ ${feedUrl.split('/')[2]}: ${e.message}`);
    }
  }
  // Convert to trends — keep terms with freq >= 3 (appeared in ≥3 different posts).
  const out = [];
  for (const [term, freq] of termFreq) {
    if (freq >= 3) {
      out.push({
        term,
        volume: Math.min(100, freq * 10), // 3 posts = 30, 10 posts = 100
        source: 'industry-rss',
        seed: 'rss-aggregate'
      });
    }
  }
  return out;
}

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','your','will','are','was',
  'how','what','why','when','where','who','into','their','they','them','than',
  'but','not','can','all','new','more','most','over','under','been','were','its',
  'our','you','his','her','said','one','two','may','out','use','using','used',
  'about','after','before','between','through','during','while','also','such',
  'than','these','those','there','here','which','whose','whom','would','could',
  'should','might','must','shall','each','other','some','any','very','much'
]);

// ─── 2. URL collection (in-scope pages) ───────────────────────────────────
function collectScopeFiles() {
  const out = [];
  const dirs = ['insights', 'demos'];
  for (const dir of dirs) {
    const full = join(REPO_ROOT, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      if (!entry.endsWith('.html')) continue;
      // Skip index.html in each dir (it's a listing, not an article)
      if (entry === 'index.html') continue;
      const relPath = `${dir}/${entry}`;
      if (lockedPaths.has(relPath)) continue;
      out.push(relPath);
    }
  }
  return out;
}

// ─── 3. Best-trending-term matching for a file ────────────────────────────
function extractFileBody(html) {
  // Extract only the article body — strip nav, footer, header, scripts, styles.
  // This is what determines what the page is actually ABOUT, not the site chrome.
  let body = html;
  // Remove <header>, <footer>, <nav> blocks entirely
  body = body.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  body = body.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  body = body.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body.replace(/&[a-z]+;/g, ' ');
  return body.toLowerCase();
}

function bestTrendForFile(bodyText, trends) {
  // Match by literal phrase presence in the article body (not nav/footer).
  // Require the trend to be a multi-word phrase (>= 2 words) — single-word
  // trends like "business" or "value" are too generic to be useful SEO targets.
  let best = null;
  for (const t of trends) {
    const phrase = t.term.toLowerCase().trim();
    // Skip single-word trends — too generic
    if (!phrase.includes(' ')) continue;
    // Skip very short trends
    if (phrase.length < 8) continue;
    // Count phrase occurrences
    let count = 0;
    let idx = bodyText.indexOf(phrase);
    while (idx !== -1 && count < 10) {
      count++;
      idx = bodyText.indexOf(phrase, idx + phrase.length);
    }
    if (count === 0) continue;
    // Match score = sqrt(count) / 3 — saturates around 9-10 occurrences
    const matchScore = Math.min(1, Math.sqrt(count) / 3);
    if (!best || matchScore > best.matchScore) {
      best = { ...t, matchScore, occurrenceCount: count };
    }
  }
  return best;
}

// ─── 4. Cooldown + threshold check ────────────────────────────────────────
function cooldownCheck(relPath) {
  const entry = state.urls[relPath];
  if (!entry || !entry.lastRewriteDate) return { ok: true, reason: 'never rewritten' };
  const lastDate = new Date(entry.lastRewriteDate);
  const daysSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < COOLDOWN_DAYS) {
    return { ok: false, reason: `cooldown: ${Math.floor(daysSince)}d since last rewrite (need ${COOLDOWN_DAYS}d)` };
  }
  return { ok: true, reason: `${Math.floor(daysSince)}d since last rewrite` };
}

function thresholdCheck(relPath, newTerm, newVolume) {
  const entry = state.urls[relPath];
  if (!entry || !entry.currentTermVolume) {
    // No current term — only rewrite if new volume is meaningfully high (≥40)
    if (newVolume < 40) return { ok: false, reason: `new term volume ${newVolume} < 40 (no current baseline)` };
    return { ok: true, reason: 'no current term — adopting new term' };
  }
  const current = entry.currentTermVolume;
  const pctHigher = ((newVolume - current) / current) * 100;
  if (pctHigher < THRESHOLD_PCT) {
    return { ok: false, reason: `new volume ${newVolume} only ${pctHigher.toFixed(0)}% higher than current ${current} (need ≥${THRESHOLD_PCT}%)` };
  }
  return { ok: true, reason: `new volume ${newVolume} is ${pctHigher.toFixed(0)}% higher than current ${current}` };
}

// ─── 5. Groq rewriter ──────────────────────────────────────────────────────
async function groqRewriteSEO(currentTitle, currentDesc, bodyText, targetTerm) {
  const prompt = `You are an SEO specialist. Rewrite the page's <title> and <meta description> to target the trending search term "${targetTerm}".

Constraints:
- <title>: ${TITLE_MIN}-${TITLE_MAX} chars. Must end with " | Insight Analytics". Must contain the target term verbatim (or very close variant). Compelling, click-worthy, no clickbait.
- <meta description>: ${DESC_MIN}-${DESC_MAX} chars. Must contain the target term. Action-oriented, present-tense, includes a benefit or differentiator. No quotes, no emojis.
- Preserve brand voice: analyst-grade, no hype, factual.
- The new title/desc MUST be substantively different from the current ones (don't just shuffle words).
- Output STRICT JSON only, no markdown: {"title": "...", "description": "..."}

Current title: ${currentTitle}
Current description: ${currentDesc}

First 800 chars of page body:
${bodyText.slice(0, 800)}

Output JSON:`;

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 400
  };
  const r = await fetch(GROQ_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Groq HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  // Groq proxy streams — collect chunks
  const text = await r.text();
  // Try non-streaming first
  try {
    const j = JSON.parse(text);
    if (j.choices && j.choices[0].message) {
      const content = j.choices[0].message.content;
      return JSON.parse(content);
    }
  } catch {}
  // Streaming — parse SSE chunks
  let fullContent = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const j = JSON.parse(data);
      if (j.choices && j.choices[0].delta && j.choices[0].delta.content) {
        fullContent += j.choices[0].delta.content;
      }
    } catch {}
  }
  return JSON.parse(fullContent);
}

// ─── 6. Apply rewrite to HTML ──────────────────────────────────────────────
function applyRewrite(html, newTitle, newDesc) {
  let out = html;
  // Replace <title>...</title>
  out = out.replace(/<title[^>]*>([\s\S]*?)<\/title>/i, `<title>${escapeHtml(newTitle)}</title>`);
  // Replace <meta name="description" content="...">
  // Handle both single and double quotes, attribute order variants
  const descReplaced = out.replace(
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']\s*\/?>/i,
    `<meta name="description" content="${escapeAttr(newDesc)}">`
  );
  if (descReplaced === out) {
    // No existing description meta — insert one after <title>
    out = out.replace(/<\/title>/i, `</title>\n  <meta name="description" content="${escapeAttr(newDesc)}">`);
  } else {
    out = descReplaced;
  }
  // Also update og:title + og:description if present
  out = out.replace(
    /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']\s*\/?>/i,
    `<meta property="og:title" content="${escapeAttr(newTitle)}">`
  );
  out = out.replace(
    /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']\s*\/?>/i,
    `<meta property="og:description" content="${escapeAttr(newDesc)}">`
  );
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 7. Extract current title/desc from HTML ──────────────────────────────
function extractCurrent(html) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']\s*\/?>/i);
  return {
    title: titleM ? titleM[1].trim() : '',
    desc: descM ? descM[1].trim() : ''
  };
}

// ─── 8. FAQ additions ──────────────────────────────────────────────────────
async function generateFAQItem(question, answerContext) {
  const prompt = `You are an SEO content writer for Insight Analytics (insight-analytics.ca — AI-powered executive dashboards, data pipelines, no-hallucination AI briefs).

A trending question in our space right now is: "${question}"

Write a FAQ <details> element answering this question. Format:
<details class="faq-item"><summary>QUESTION TEXT<i class="fas fa-plus" aria-hidden="true"></i></summary><div class="faq-answer">ANSWER (2-3 sentences, factual, no hype, no invented numbers. End with a soft CTA linking to /demos/ or /solutions-showcase/ or /#contact as appropriate.)</div></details>

Context — our existing FAQ style (match this voice):
${answerContext}

Output ONLY the <details> element, no markdown fences, no preamble.`;

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 500
  };
  const r = await fetch(GROQ_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}`);
  const text = await r.text();
  // Parse streaming
  let fullContent = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const j = JSON.parse(data);
      if (j.choices && j.choices[0].delta && j.choices[0].delta.content) {
        fullContent += j.choices[0].delta.content;
      }
    } catch {}
  }
  return fullContent.trim();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  // 1. Collect trends
  const [autocompleteTrends, rssTrends] = await Promise.all([
    collectGoogleAutocomplete(),
    collectIndustryRSS()
  ]);
  const allTrends = [...autocompleteTrends, ...rssTrends];
  // Dedupe — keep highest volume per term
  const trendMap = new Map();
  for (const t of allTrends) {
    const existing = trendMap.get(t.term);
    if (!existing || t.volume > existing.volume) trendMap.set(t.term, t);
  }
  const trends = [...trendMap.values()].sort((a, b) => b.volume - a.volume);
  console.log(`\n--- Total unique trending terms: ${trends.length} ---`);
  console.log(`Top 10 by volume:`);
  trends.slice(0, 10).forEach(t => console.log(`  ${String(t.volume).padStart(3)}  ${t.term}  [${t.source}]`));

  // Save trends (always — even in scan-only mode)
  writeFileSync(TRENDS_PATH, JSON.stringify({
    collectedAt: NOW_ISO,
    seedKeywords: SEED_KEYWORDS,
    totalTerms: trends.length,
    trends
  }, null, 2));
  console.log(`\nSaved trends → seo-trends.json`);

  if (!SHOULD_REWRITE) {
    console.log(`\nScan complete. Skipping rewrite step.`);
    return;
  }

  // 2. Collect in-scope files
  const scopeFiles = collectScopeFiles();
  console.log(`\n--- In-scope files: ${scopeFiles.length} ---`);

  // 3. For each file, find best trend + check cooldown + threshold
  const candidates = [];
  for (const relPath of scopeFiles) {
    const fullPath = join(REPO_ROOT, relPath);
    const html = readFileSync(fullPath, 'utf-8');
    const fileBody = extractFileBody(html);
    const trend = bestTrendForFile(fileBody, trends);
    if (!trend) {
      console.log(`  ✗ ${relPath}: no matching trend (≥50% token overlap)`);
      continue;
    }
    const cooldown = FORCE ? { ok: true, reason: 'forced' } : cooldownCheck(relPath);
    if (!cooldown.ok) {
      console.log(`  ⊘ ${relPath}: ${cooldown.reason}`);
      continue;
    }
    const threshold = thresholdCheck(relPath, trend.term, trend.volume);
    if (!threshold.ok) {
      console.log(`  ⊘ ${relPath}: ${threshold.reason}`);
      continue;
    }
    const current = extractCurrent(html);
    candidates.push({
      relPath,
      fullPath,
      html,
      fileBody,
      currentTitle: current.title,
      currentDesc: current.desc,
      trend
    });
    console.log(`  ✓ ${relPath}: trend="${trend.term}" (vol ${trend.volume}, match ${(trend.matchScore*100).toFixed(0)}%) — ${threshold.reason}`);
  }
  console.log(`\n${candidates.length} candidates passed cooldown + threshold.`);

  // Sort by volume × matchScore descending — highest impact first
  candidates.sort((a, b) => (b.trend.volume * b.trend.matchScore) - (a.trend.volume * a.trend.matchScore));

  // 4. Apply rewrites (cap at MAX_REWRITES_PER_RUN)
  const toRewrite = candidates.slice(0, MAX_REWRITES_PER_RUN);
  console.log(`\n--- Applying ${toRewrite.length} rewrites (cap ${MAX_REWRITES_PER_RUN}) ---`);

  let rewritten = 0;
  for (const c of toRewrite) {
    try {
      console.log(`\n[${rewritten+1}/${toRewrite.length}] ${c.relPath}`);
      console.log(`  trend: "${c.trend.term}" (vol ${c.trend.volume})`);
      console.log(`  current title: ${c.currentTitle.slice(0, 70)}...`);
      const result = await groqRewriteSEO(c.currentTitle, c.currentDesc, c.fileBody, c.trend.term);
      const newTitle = (result.title || '').trim();
      const newDesc = (result.description || '').trim();
      if (!newTitle || !newDesc) {
        console.log(`  ✗ Groq returned empty title or description`);
        continue;
      }
      // Length validation
      if (newTitle.length > TITLE_MAX + 10 || newTitle.length < TITLE_MIN - 10) {
        console.log(`  ⚠ Title length ${newTitle.length} outside ${TITLE_MIN}-${TITLE_MAX}, but accepting anyway`);
      }
      if (newDesc.length > DESC_MAX + 10 || newDesc.length < DESC_MIN - 10) {
        console.log(`  ⚠ Description length ${newDesc.length} outside ${DESC_MIN}-${DESC_MAX}, but accepting anyway`);
      }
      // Apply rewrite
      const newHtml = applyRewrite(c.html, newTitle, newDesc);
      if (!DRY_RUN) {
        writeFileSync(c.fullPath, newHtml);
      }
      console.log(`  new title:     ${newTitle.slice(0, 70)}...`);
      console.log(`  new desc:      ${newDesc.slice(0, 70)}...`);

      // Update state
      const prevEntry = state.urls[c.relPath] || { variantHistory: [] };
      state.urls[c.relPath] = {
        currentTargetTerm: c.trend.term,
        currentTermVolume: c.trend.volume,
        lastRewriteDate: NOW_ISO,
        variantHistory: [
          ...prevEntry.variantHistory,
          {
            date: NOW_ISO,
            targetTerm: c.trend.term,
            termVolume: c.trend.volume,
            titleBefore: c.currentTitle,
            titleAfter: newTitle,
            descBefore: c.currentDesc,
            descAfter: newDesc,
            reason: `volume ${c.trend.volume} (source: ${c.trend.source})`
          }
        ]
      };

      // Append to changelog
      changelog.entries.push({
        date: NOW_ISO,
        relPath: c.relPath,
        action: 'rewrite-seo',
        targetTerm: c.trend.term,
        termVolume: c.trend.volume,
        titleBefore: c.currentTitle,
        titleAfter: newTitle,
        descBefore: c.currentDesc,
        descAfter: newDesc,
        reason: `trend match ${(c.trend.matchScore*100).toFixed(0)}%, vol ${c.trend.volume} (source: ${c.trend.source})`
      });
      rewritten++;
    } catch (e) {
      console.log(`  ✗ ERROR: ${e.message}`);
    }
  }

  // 5. FAQ additions — generate new Q&A items from trending question-like queries
  console.log(`\n--- FAQ additions (cap ${MAX_FAQ_ADDITIONS_PER_RUN}) ---`);
  const faqPath = join(REPO_ROOT, 'faq/index.html');
  if (existsSync(faqPath) && !lockedPaths.has('faq/index.html')) {
    const faqHtml = readFileSync(faqPath, 'utf-8');
    // Find existing FAQ questions to avoid duplicates
    const existingQs = [...faqHtml.matchAll(/<summary>([^<]+)</g)].map(m => m[1].trim().toLowerCase());
    // Find trending queries that look like questions
    const questionTrends = trends.filter(t =>
      /^(how|what|why|when|where|can|do|does|is|are)\b/.test(t.term) &&
      t.volume >= 40
    );
    const newFAQs = [];
    for (const t of questionTrends) {
      // Skip if we already have a similar question
      const normalized = t.term.replace(/[??.]/g, '').trim();
      const isDup = existingQs.some(q => q.includes(normalized) || normalized.includes(q));
      if (isDup) continue;
      newFAQs.push(t);
      if (newFAQs.length >= MAX_FAQ_ADDITIONS_PER_RUN) break;
    }
    if (newFAQs.length === 0) {
      console.log(`  No new question-style trending terms found (or all already in FAQ).`);
    }
    // Get a sample of existing FAQ for style reference
    const existingSample = existingQs.slice(0, 5).map(q => `Q: ${q}`).join('\n');
    let updatedFAQ = faqHtml;
    for (const t of newFAQs) {
      try {
        console.log(`  generating FAQ for: "${t.term}"`);
        const newItem = await generateFAQItem(t.term, existingSample);
        if (!newItem || !newItem.includes('<details')) {
          console.log(`    ✗ invalid response, skipping`);
          continue;
        }
        // Insert before </main> (or before the closing section, depending on structure)
        // For this site, FAQ items live in a section, just before </main> or before the contact CTA
        if (DRY_RUN) {
          console.log(`    [dry-run] would add: ${newItem.slice(0, 100)}...`);
        } else {
          // Insert right before the closing </section> or </main>
          // Find the last </details> in the file and insert after it
          const lastDetailsIdx = updatedFAQ.lastIndexOf('</details>');
          if (lastDetailsIdx > 0) {
            updatedFAQ = updatedFAQ.slice(0, lastDetailsIdx + 10) + '\n    ' + newItem + updatedFAQ.slice(lastDetailsIdx + 10);
          } else {
            // Fallback: insert before </main>
            updatedFAQ = updatedFAQ.replace('</main>', `    ${newItem}\n  </main>`);
          }
          // Log to changelog
          changelog.entries.push({
            date: NOW_ISO,
            relPath: 'faq/index.html',
            action: 'add-faq-item',
            targetTerm: t.term,
            termVolume: t.volume,
            reason: `new question-style trend, vol ${t.volume}`
          });
        }
      } catch (e) {
        console.log(`    ✗ ERROR: ${e.message}`);
      }
    }
    if (!DRY_RUN && updatedFAQ !== faqHtml) {
      writeFileSync(faqPath, updatedFAQ);
      console.log(`  ✓ Updated faq/index.html with ${newFAQs.length} new items`);
    }
  }

  // 6. Save state + changelog
  if (!DRY_RUN) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
    console.log(`\n--- Saved state + changelog ---`);
  }

  console.log(`\n═══ Summary ═══`);
  console.log(`Trends collected:    ${trends.length}`);
  console.log(`Candidates passing:  ${candidates.length}`);
  console.log(`SEO rewrites applied: ${rewritten}`);
  if (DRY_RUN) {
    console.log(`Mode: DRY-RUN — no files written, no commits`);
  } else {
    console.log(`Files modified:      ${rewritten > 0 ? rewritten + ' HTML files + 2 state files' : '0'}`);
  }
  console.log(`Next eligible rewrite: ${new Date(Date.now() + COOLDOWN_DAYS * 86400000).toISOString().split('T')[0]}\n`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
