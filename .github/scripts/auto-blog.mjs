#!/usr/bin/env node
/**
 * auto-blog.mjs — Executive-grade AI Insights scout (analyst-grade sources)
 *
 * Runs twice daily via GitHub Actions cron. Produces 1-2 articles per run:
 *   1. RSS article: pulled from TIER-1 ANALYST & CONSULTING sources
 *      (Gartner, McKinsey, BCG, Bain, Deloitte, Accenture, HBR, MIT Sloan,
 *       Stanford GSB, Wharton, INSEAD Knowledge, Supply Chain Brain, CSCMP).
 *      Items MUST pass an ANALYST-DEPTH gate: must hit on analytical
 *      methodology keywords (research, study, framework, benchmark, index,
 *      survey, KPI, maturity model, etc.) AND a CEO-relevance lens
 *      (corporate governance, logistics, optimization, market research,
 *       profitability, AI implementation cost, M&A, treasury, risk).
 *      CRIME / local news / small-potatoes stories (robbery, theft, arrest,
 *       local incident, lawsuit gossip) are HARD-REJECTED regardless of score.
 *   2. Feature article: deep-dive on Insight Analytics' own capabilities.
 *
 * Groq is called via Netlify proxy (no API key needed).
 * max_tokens: 1200 (enough for 500+ words)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const SITE_URL = 'https://insight-analytics.ca';
const GROQ_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const REPO_ROOT = process.cwd();
const NOW = new Date();
const ISO_NOW = NOW.toISOString();
const DATE_STR = NOW.toISOString().split('T')[0];
const TIME_STAMP = NOW.getTime();

// ─── RSS Feed Sources (TIER-1 ANALYST / CONSULTING / BUSINESS-SCHOOL) ────────
// Curated for board-grade analytical material: corporate governance, logistics,
// optimization, market research, profitability, AI implementation cost, M&A, treasury.
// No consumer-tech blogs. No general news wires (those produce crime / small-potatoes
// stories that pollute the feed). Only analyst houses, top-tier consulting firms,
// and business-school journals that publish research, frameworks, benchmarks, and
// surveys — the material CEOs/CFOs/COOs actually read.
//
// Each feed is marked isAnalystFeed: true/false. Items from analyst feeds bypass
// the hasAnalystDepth() gate — the source itself guarantees analyst depth.
// (McKinsey's RSS descriptions are 1-line teasers that often don't contain
// 'research' or 'survey' language, so the depth gate would wrongly reject them.)
//
// NOTE: Some analyst houses (BCG direct, Bain, Deloitte, Accenture, PwC, EY,
// Gartner direct, INSEAD direct, Stanford GSB, Supply Chain Dive, Supply Chain Brain)
// aggressively block server-side RSS fetches (Cloudflare/Akamai 403 even with browser UA).
// Working Feedburner mirrors are used where available.
// Re-probe quarterly — URLs do change.
const RSS_FEEDS = [
  // — Big consulting firms (working RSS) —
  { url: 'https://www.mckinsey.com/insights/rss', name: 'McKinsey & Company — Insights', isAnalystFeed: true },
  { url: 'https://feeds.feedburner.com/mckinseyquarterly', name: 'McKinsey Quarterly (Feedburner)', isAnalystFeed: true },
  { url: 'https://feeds.feedburner.com/bcg', name: 'BCG (Feedburner)', isAnalystFeed: true },
  { url: 'https://www.strategy-business.com/rss', name: 'Strategy+Business (PwC network)', isAnalystFeed: true },
  { url: 'https://www.kpmg.com/us/en/home/insights.xml', name: 'KPMG — Insights', isAnalystFeed: true },
  // — Analyst houses (working feeds) —
  { url: 'https://www.forrester.com/blogs/rss', name: 'Forrester — Blogs', isAnalystFeed: true },
  // — Business-school journals (peer-reviewed-grade analytical content) —
  { url: 'https://feeds.feedburner.com/harvardbusinessreview', name: 'Harvard Business Review (Feedburner)', isAnalystFeed: true },
  { url: 'https://workingknowledge.hbs.edu/rss/', name: 'Harvard Business School — Working Knowledge', isAnalystFeed: true },
  { url: 'https://feeds.feedburner.com/mitsloanmanagementreview', name: 'MIT Sloan Management Review (Feedburner)', isAnalystFeed: true },
  { url: 'https://knowledge.wharton.upenn.edu/feed/', name: 'Wharton — Knowledge', isAnalystFeed: true },
  { url: 'https://insight.kellogg.northwestern.edu/feed', name: 'Kellogg Insight', isAnalystFeed: true },
  { url: 'https://www.iese.edu/feed', name: 'IESE Business School', isAnalystFeed: true },
  { url: 'https://www.imd.org/feed/', name: 'IMD Business School', isAnalystFeed: true },
  { url: 'https://insights.som.yale.edu/rss', name: 'Yale SOM — Insights', isAnalystFeed: true },
  // — Specialized analyst-grade operational outlets —
  { url: 'https://feeds.feedburner.com/logisticsviewpoints', name: 'Logistics Viewpoints (Feedburner)', isAnalystFeed: true },
  { url: 'https://www.scmr.com/feed/', name: 'Supply Chain Management Review', isAnalystFeed: true },
  // — Tier-1 business news (analyst-grade content, NOT news-wire crime stories) —
  { url: 'https://www.fortune.com/feed/', name: 'Fortune — Business', isAnalystFeed: false },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', name: 'NYT — Business', isAnalystFeed: false },
];

// ─── Analyst-depth gate (NEW) ────────────────────────────────────────────
// An item must contain at least ONE of these analytical-methodology signals
// to be eligible. This is what separates real analyst-grade material
// ("McKinsey survey of 1,200 CFOs shows margin compression...") from news
// wire noise ("Nebraska deputies recover stolen copper load...").
// Items without ANY of these signals are auto-rejected regardless of CEO score.
const ANALYST_DEPTH_KEYWORDS = [
  'research', 'study', 'survey', 'report', 'white paper', 'working paper',
  'framework', 'methodology', 'benchmark', 'benchmarks', 'benchmarking',
  'index', 'indicator', 'KPI', 'metric', 'metrics', 'measure', 'measurement',
  'analysis', 'analytical', 'model', 'modeling', 'correlation', 'regression',
  'maturity model', 'capability assessment', 'scorecard', 'dashboard',
  'data', 'dataset', 'sample', 'sample size', 'respondents', 'findings',
  'insight', 'insights', 'outlook', 'forecast', 'projection', 'scenario',
  'case study', 'best practice', 'lessons learned', 'playbook', 'blueprint',
  'transformation', 'optimization', 'optimization model', 'simulation',
  'risk assessment', 'gap analysis', 'cost-benefit', 'total cost of ownership',
  'TCO', 'NPV', 'IRR', 'payback', 'sensitivity analysis', 'Monte Carlo',
];

// ─── CEO-relevance scoring ──────────────────────────────────────────────
// Items are scored 0..N by counting hits across these CEO-grade topic clusters.
// An item must score >= 3 (was: 2) to be eligible for selection.
const CEO_RELEVANCE_KEYWORDS = [
  // Profitability / margin
  'profit', 'profitability', 'margin', 'ebitda', 'gross margin', 'operating margin',
  'earnings', 'EPS', 'net income', 'bottom line', 'top line', 'revenue growth',
  'unit economics', 'price elasticity', 'pricing power',
  // Cost & efficiency
  'cost', 'costs', 'cost reduction', 'opex', 'operating expense', 'capex',
  'capital expenditure', 'spend', 'spending', 'budget', 'budget cut',
  'cost analysis', 'cost optimization', 'efficiency', 'productivity',
  'process improvement', 'lean', 'six sigma', 'operational excellence',
  'restructuring', 'synergies', 'run-rate', 'cost-to-serve',
  // ROI / capital allocation
  'ROI', 'return on investment', 'payback', 'payback period', 'NPV', 'IRR',
  'capital allocation', 'capital return', 'buyback', 'share repurchase',
  'dividend', 'free cash flow', 'cash flow', 'investment case',
  'capital efficiency', 'capital productivity',
  // AI implementation costs / value
  'AI implementation', 'AI cost', 'AI ROI', 'AI spend', 'AI investment',
  'AI adoption', 'AI deployment', 'generative AI cost', 'gen AI cost',
  'LLM cost', 'inference cost', 'GPU cost', 'AI productivity gain',
  'AI business value', 'AI monetization', 'AI pricing', 'AI governance',
  'AI strategy', 'AI maturity', 'AI readiness',
  // Corporate governance & board
  'corporate governance', 'board', 'board of directors', 'CEO', 'CFO', 'COO',
  'CIO', 'CTO', 'audit committee', 'compensation committee', 'governance',
  'fiduciary', 'shareholder', 'stakeholder', 'ESG', 'sustainability',
  'compliance', 'regulatory', 'risk culture', 'tone at the top',
  // Markets / valuation / market research
  'market research', 'market analysis', 'market sizing', 'TAM', 'SAM', 'SOM',
  'market share', 'competitive landscape', 'segmentation', 'positioning',
  'valuation', 'multiple', 'P/E', 'price target',
  'equity', 'stock', 'index', 'S&P', 'NASDAQ',
  'treasury yield', 'bond yield', 'rate cut', 'rate hike', 'Fed',
  'inflation', 'CPI', 'PPI', 'recession', 'soft landing',
  'earnings call', 'guidance', 'outlook', 'forecast',
  // Logistics / supply chain / optimization
  'logistics', 'supply chain', 'procurement', 'freight', 'shipping',
  'carrier', 'OTIF', 'inventory', 'warehouse', 'fulfillment', 'last mile',
  'demand planning', 'S&OP', 'lead time', 'tariff', 'duty', 'nearshoring',
  'reshoring', 'port congestion', 'container', 'truckload', 'LTL',
  'network optimization', 'route optimization', 'warehouse optimization',
  'inventory optimization', 'service level', 'fill rate',
  // M&A / strategy
  'M&A', 'merger', 'acquisition', 'divestiture', 'spin-off', 'IPO',
  'private equity', 'LBO', 'deal', 'synergy', 'integration',
  'corporate strategy', 'strategic plan', 'portfolio review',
  // Treasury / risk / capital structure
  'treasury', 'liquidity', 'working capital', 'credit facility',
  'debt refinancing', 'refinanc', 'capital structure', 'credit rating',
  'risk management', 'enterprise risk', 'ERM', 'hedge', 'hedging',
  'FX exposure', 'commodity', 'counterparty', 'cyber risk',
  // Operations / executive
  'executive', 'leadership', 'strategy', 'strategic', 'transformation',
  'digital transformation', 'change management', 'org design',
  'operating model', 'business model', 'business transformation',
];

// ─── Noise blocklist — HARD REJECT ────────────────────────────────────────
// Items whose title+description contains any of these (case-insensitive,
// word-boundary regex) are REJECTED regardless of CEO score or analyst depth.
// CRIME / local news / small-potatoes stories are explicitly rejected because
// they slip past keyword filters ("robbery of copper load" has "load" and
// "shipping-adjacent" words) but aren't executive-grade material.
const CONSUMER_NOISE_PATTERNS = [
  // — Consumer-blog fluff —
  'AI music', 'AI-generated music', 'AI song', 'spotify', 'youtube music',
  'deezer', 'soundcloud', 'apple music', 'tidal', 'streaming playlist',
  'AI art', 'AI image', 'AI photo', 'midjourney', 'DALL-E', 'stable diffusion',
  'AI girlfriend', 'AI companion', 'chatbot romance',
  'gaming', 'video game', 'esports', 'playstation', 'xbox', 'nintendo',
  'fortnite', 'minecraft', 'roblox',
  'celebrity', 'tiktok', 'instagram', 'snapchat', 'influencer',
  'kardashian', 'entertainment', 'gossip',
  'wildlife', 'bird watching', 'pet', 'cat ', 'dog ',
  'space tourism', 'mars mission', 'rocket launch',
  'recipe', 'cooking', 'restaurant review',
  'travel guide', 'hotel review', 'flight review',
  'movie review', 'film festival', 'TV show', 'netflix', 'hbo',
  // Narrow sports-noise to professional spectator leagues only — 'sports' alone
  // would false-positive on McKinsey articles like 'what leaders can learn
  // from modern sports' which is legit strategy material.
  'NBA', 'NFL', 'NHL', 'MLB', 'soccer', 'football match',
  'cricket', 'tennis tournament', 'golf tournament',
  'super bowl', 'world cup', 'olympics',
  'health wellness', 'diet plan', 'weight loss', 'yoga', 'meditation',
  'horoscope', 'astrology', 'psychic',
  // — Crime / local-incident / small-potatoes (the user explicitly called out
  //   "robbery of wire" as the kind of story NOT to surface) —
  'robbery', 'robbed', 'armed robbery', 'heist', 'loot', 'looted',
  'theft', 'stolen', 'thief', 'thieves', 'burglary', 'break-in',
  'arrest', 'arrested', 'indicted', 'convicted', 'sentenced',
  'felony', 'misdemeanor', 'charged with', 'suspect', 'suspects',
  'police say', 'sheriff', 'deputies', 'detectives', 'investigators say',
  'copper theft', 'metal theft', 'cargo theft', 'cargo stolen',
  'hijack', 'hijacked', 'piracy', 'smuggl',
  'fatal', 'fatality', 'death of', 'killed in', 'slain', 'murder',
  'homicide', 'shooting', 'shot ', 'stabbed', 'assault',
  'crash', 'crashed', 'derailment', 'collision',
  'fire at', 'burns down', 'explosion at',
  'rescue', 'rescued', 'recovered stolen', 'recover stolen',
  'lawsuit', 'sues', 'sued', 'class-action', 'plaintiff', 'defendant',
  'settlement', 'out-of-court',
  'scandal', 'controversy', 'outrage', 'backlash', 'uproar',
  'protest', 'protesters', 'strike', 'walkout', 'picket',
  'CEO arrested', 'executive arrested', 'exec charged',
  'fraud', 'embezzlement', 'Ponzi', 'wire fraud', 'securities fraud',
  // — Small-potatoes local / regional news —
  'local business', 'small town', 'county news', 'regional news',
  'city council', 'town hall', 'municipal',
  // — Marketing / advertorial / PR puff pieces —
  'announces partnership with', 'joins forces with', 'unveils new logo',
  'launches brand', 'rebrand', 'new brand identity',
  'gift guide', 'best of', 'top 10', 'year in review',
];

// Items whose title clearly matches "executive-grade" even without keyword hits
// (e.g. explicit CEO/CFO interviews, earnings recaps) get a floor bonus.
const EXEC_HEADLINE_PATTERNS = [
  /\bCEO\b/i, /\bCFO\b/i, /\bCOO\b/i, /\bCIO\b/i, /\bCTO\b/i,
  /\bboard\b/i, /\bearnings\b/i, /\bprofit\b/i, /\brevenue\b/i,
  /\bmargin\b/i, /\bEBITDA\b/i, /\bguidance\b/i, /\bquarterly\b/i,
  /\bsurvey\b/i, /\bstudy\b/i, /\breport\b/i, /\bbenchmark\b/i,
  /\bgovernance\b/i, /\boptimization\b/i, /\bstrategy\b/i,
];

// ─── NEW: analyst-depth gate ─────────────────────────────────────────────
// Returns true if the item shows analytical-methodology signals (research,
// survey, framework, benchmark, etc.). Required IN ADDITION to CEO-relevance
// score so news-wire stories don't slip through.
// (ANALYST_DEPTH_KEYWORDS is declared above, near CEO_RELEVANCE_KEYWORDS.)

function scoreCEORelevance(item) {
  const text = ((item.title || '') + ' ' + (item.desc || '')).toLowerCase();
  if (!text.trim()) return 0;
  let score = 0;
  for (const kw of CEO_RELEVANCE_KEYWORDS) {
    if (text.indexOf(kw.toLowerCase()) >= 0) score++;
  }
  for (const re of EXEC_HEADLINE_PATTERNS) {
    if (re.test(item.title || '')) { score += 1; break; }
  }
  return score;
}

// Returns true if the item shows analytical-methodology signals.
// Two paths to qualifying:
//   (a) the item contains an explicit analyst-depth keyword
//       (research / survey / framework / benchmark / KPI / etc.), OR
//   (b) the item has a high CEO-relevance score (>=5) AND contains a
//       strategy/leadership/transformation keyword — these McKinsey-style
//       articles often don't use explicit 'study' or 'survey' language but
//       are still analyst-grade (e.g. "The CEO's singular impact on the success
//       — or failure — of AI in organizations").
const STRATEGY_DEPTH_KEYWORDS = [
  'strategy', 'strategic', 'leadership', 'transformation',
  'operating model', 'business model', 'playbook',
];
function hasAnalystDepth(item, ceoScore = 0) {
  const text = ((item.title || '') + ' ' + (item.desc || '')).toLowerCase();
  if (!text.trim()) return false;
  // Path (a): explicit analyst-depth keyword
  for (const kw of ANALYST_DEPTH_KEYWORDS) {
    if (text.indexOf(kw.toLowerCase()) >= 0) return true;
  }
  // Path (b): high CEO score + strategy/leadership keyword
  if (ceoScore >= 5) {
    for (const kw of STRATEGY_DEPTH_KEYWORDS) {
      if (text.indexOf(kw.toLowerCase()) >= 0) return true;
    }
  }
  return false;
}

function isConsumerNoise(item) {
  const text = ((item.title || '') + ' ' + (item.desc || '')).toLowerCase();
  if (!text.trim()) return false;
  for (const p of CONSUMER_NOISE_PATTERNS) {
    // Use a word-boundary regex so short tokens like 'NFL', 'NBA', 'HBO',
    // 'cat ', 'dog ' don't fire on substring matches inside real business
    // words like 'inflation', ' markets', 'catalog', etc.
    // \b on either side; trailing-space tokens are stripped before building
    // the regex so the boundary itself enforces the separator.
    const cleaned = p.replace(/\s+$/g, '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp('\\b' + cleaned + '\\b', 'i');
    if (re.test(text)) return true;
  }
  return false;
}

// ─── Executive category picker ──────────────────────────────────────────
// Maps the dominant CEO lens of an item to a short, board-room-flavored
// category label that appears on the Insights index card.
const EXEC_CATEGORIES = [
  { match: ['AI implementation','AI cost','AI ROI','AI spend','AI investment','AI adoption','AI deployment','generative AI cost','gen AI cost','LLM cost','inference cost','GPU cost','AI productivity gain','AI business value','AI monetization','AI pricing','AI governance','AI strategy','AI maturity','AI readiness','AI '], label: 'AI Implementation' },
  { match: ['corporate governance','board','board of directors','CEO','CFO','COO','CIO','CTO','audit committee','compensation committee','governance','fiduciary','shareholder','stakeholder','ESG','sustainability','compliance','regulatory','risk culture','tone at the top'], label: 'Corporate Governance' },
  { match: ['profit','profitability','margin','ebitda','gross margin','operating margin','earnings','EPS','net income','bottom line','top line','revenue growth','unit economics','price elasticity','pricing power'], label: 'Profitability' },
  { match: ['cost','costs','cost reduction','opex','operating expense','capex','capital expenditure','spend','spending','budget','budget cut','cost analysis','cost optimization','efficiency','productivity','process improvement','lean','six sigma','operational excellence','restructuring','synergies','run-rate','cost-to-serve'], label: 'Cost & Efficiency' },
  { match: ['ROI','return on investment','payback','NPV','IRR','capital allocation','capital return','buyback','share repurchase','dividend','free cash flow','cash flow','investment case','capital efficiency','capital productivity'], label: 'ROI & Capital' },
  { match: ['logistics','supply chain','procurement','freight','shipping','carrier','OTIF','inventory','warehouse','fulfillment','last mile','demand planning','S&OP','lead time','tariff','duty','nearshoring','reshoring','port congestion','container','truckload','LTL','network optimization','route optimization','warehouse optimization','inventory optimization','service level','fill rate'], label: 'Logistics & Supply Chain' },
  { match: ['market research','market analysis','market sizing','TAM','SAM','SOM','market share','competitive landscape','segmentation','positioning','valuation','multiple','P/E','price target','equity','stock','index','S&P','NASDAQ','treasury yield','bond yield','rate cut','rate hike','Fed','inflation','CPI','PPI','recession','soft landing','earnings call','guidance','outlook','forecast'], label: 'Markets & Market Research' },
  { match: ['M&A','merger','acquisition','divestiture','spin-off','IPO','private equity','LBO','deal','synergy','integration','corporate strategy','strategic plan','portfolio review'], label: 'M&A & Strategy' },
  { match: ['treasury','liquidity','working capital','credit facility','debt refinancing','refinanc','capital structure','credit rating','risk management','enterprise risk','ERM','hedge','hedging','FX exposure','commodity','counterparty','cyber risk'], label: 'Treasury & Risk' },
  { match: ['executive','leadership','strategy','strategic','transformation','digital transformation','change management','org design','operating model','business model','business transformation'], label: 'Executive Strategy' },
];

function pickExecutiveCategory(item) {
  const text = ((item.title || '') + ' ' + (item.desc || '')).toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const cat of EXEC_CATEGORIES) {
    let hits = 0;
    for (const kw of cat.match) {
      if (text.indexOf(kw.toLowerCase()) >= 0) hits++;
    }
    if (hits > bestHits) { bestHits = hits; best = cat.label; }
  }
  // Fallback: if no specific lens matched but the item passed the CEO gate,
  // default to 'Executive Briefing' so the card still reads exec-grade.
  return best || 'Executive Briefing';
}

// NOTE: The FEATURE_TOPICS array (made-up site self-promotion articles about
// glassmorphism / dashboard constructors / pastel palettes / etc.) has been
// REMOVED per user direction: "Do not build made-up content, scout the net
// only." Every article now originates from a real RSS item with a source URL.

// ─── Utility functions ───────────────────────────────────────────────────
// Decode common HTML entities that appear in RSS titles/descriptions so the
// article title and slug use clean characters (e.g. &#x2019; → ', &amp; → &).
// Without this, titles render as literal "&amp;#x2018;" because escHtml()
// double-escapes the ampersand in the entity.
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function slugify(text) {
  // Decode entities FIRST so they don't end up as "x2018" etc in the slug.
  return decodeEntities(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
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
        max_tokens: 1200,  // enough for 500+ words
        stream: false
      })
    });
    if (!res.ok) throw new Error(`Groq proxy returned ${res.status}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return msg.content?.trim() || '';
  } catch (e) {
    console.error('Groq error:', e.message);
    return '';
  }
}

async function fetchRSS(feedUrl) {
  try {
    // Send browser-like headers so feeds behind Cloudflare/Akamai bot detection
    // (MIT Sloan, Wharton, Logistics Viewpoints) don't 403 us.
    const res = await fetch(feedUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US, en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [];
    // Parse both RSS <item> and Atom <entry> elements. HBS Working Knowledge
    // and some other feeds use Atom format which the prior parser missed entirely.
    const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const title = item.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is)?.[1]?.trim() || '';
      // Atom uses <link href="..." /> instead of <link>text</link> — handle both.
      let link = item.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]?.trim() || '';
      if (!link) link = item.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/is)?.[1]?.trim() || '';
      // Atom uses <summary> or <content>; RSS uses <description>.
      const desc = (item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/is)?.[1]
        || item.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/is)?.[1]
        || item.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/is)?.[1]
        || '').replace(/<[^>]+>/g, '').trim();
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/is)?.[1]
        || item.match(/<published>(.*?)<\/published>/is)?.[1]
        || item.match(/<updated>(.*?)<\/updated>/is)?.[1]
        || '').trim();
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
<nav class="nav-links"><a href="${SITE_URL}/#services" class="nav-link">Services</a><a href="${SITE_URL}/#dashboard" class="nav-link">Dashboard</a><a href="${SITE_URL}/#cases" class="nav-link">Case Studies</a><a href="/insights/" class="nav-link">AI Insights</a><a href="/blog/" class="nav-link">Live Demos</a><a href="${SITE_URL}/#contact" class="nav-link">Contact</a></nav>
<div class="nav-actions"><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle theme" title="Toggle theme">
          <i class="fas fa-sun" id="theme-icon" aria-hidden="true"></i><span class="theme-label" id="theme-label">Light</span>
        </button><a href="${SITE_URL}/#contact" class="btn btn-primary nav-cta"><i class="fas fa-calendar-check"></i> Book a Demo</a></div>
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


<script src="../js/app.js?v=4.98.0" defer></script>
<script>document.write('<script defer src="/js/ai-search.js?v='+Date.now()+'"><\/script>');</script>
<script src="/js/sw-register.js?v=4.98.0" defer></script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Auto-Blog Generator ===');
  console.log(`Time: ${ISO_NOW}`);
  
  const generated = [];
  
  // ── 1. RSS Article (CEO-grade only) ──
  console.log('\n--- Fetching executive-grade RSS feeds ---');
  let allRSSItems = [];
  for (const feed of RSS_FEEDS) {
    const items = await fetchRSS(feed.url);
    // Tag each item with the originating feed's analyst-feed flag so the
    // filter knows to bypass the analyst-depth gate for analyst-house items.
    for (const it of items) {
      it.fromAnalystFeed = !!feed.isAnalystFeed;
      it.feedName = feed.name;
    }
    console.log(`  ${feed.name}: ${items.length} items${feed.isAnalystFeed ? ' (analyst feed)' : ''}`);
    allRSSItems.push(...items);
  }
  
  // Analyst-grade filter: score each item, reject noise, require BOTH
  //   (a) CEO-relevance score >= 3 (was: 2) AND
  //   (b) analyst-depth — items from isAnalystFeed feeds bypass this gate
  //       (the source itself guarantees depth). Items from non-analyst feeds
  //       (Fortune, NYT Business) must contain analytical-methodology signals
  //       so news-wire crime stories are filtered out.
  const existingPosts = readdirSync(join(REPO_ROOT, 'insights')).filter(f => f.endsWith('.html') && f !== 'index.html');
  const scoredItems = allRSSItems
    .map(item => {
      const score = scoreCEORelevance(item);
      const depth = item.fromAnalystFeed ? true : hasAnalystDepth(item, score);
      return {
        item,
        score,
        depth,
        noise: isConsumerNoise(item),
        slug: slugify(item.title),
      };
    })
    .filter(s =>
      !s.noise                                  // not consumer-blog / crime / small-potatoes noise
      && s.depth                                // shows analytical-methodology signals (or from analyst feed)
      && s.score >= 3                           // passes CEO-relevance gate (raised from 2)
      && !existingPosts.includes(s.slug + '.html')   // not already blogged
      && (s.item.title || '').length > 0
      && (s.item.link || '').length > 0         // MUST have a source URL (no made-up content)
    );
  
  console.log(`  Total items fetched: ${allRSSItems.length}`);
  console.log(`  Items passing analyst-grade gate (score>=3 + analyst-depth-or-feed + no noise + has-source-URL + not already used): ${scoredItems.length}`);
  
  // Log the rejected noise samples so the run is debuggable
  const rejectedNoise = allRSSItems.filter(i => isConsumerNoise(i)).slice(0, 5);
  if (rejectedNoise.length > 0) {
    console.log('  Rejected noise samples (first 5):');
    rejectedNoise.forEach(i => console.log(`    - [REJECTED noise] ${i.title.slice(0, 80)}`));
  }
  // Also log items that passed noise filter but failed analyst-depth gate
  // (only relevant for non-analyst feeds — analyst feeds bypass this check)
  const rejectedShallow = allRSSItems
    .filter(i => !isConsumerNoise(i) && !i.fromAnalystFeed && !hasAnalystDepth(i, scoreCEORelevance(i)) && scoreCEORelevance(i) >= 3)
    .slice(0, 5);
  if (rejectedShallow.length > 0) {
    console.log('  Rejected shallow-news samples (passed noise+CEO-gate but failed analyst-depth, first 5):');
    rejectedShallow.forEach(i => console.log(`    - [REJECTED shallow] ${i.title.slice(0, 80)}`));
  }
  
  if (scoredItems.length > 0) {
    // Weighted random pick: prefer higher-scored items, but keep variety.
    // Probability of picking item i is proportional to score^2 (heavily favors
    // strong CEO-grade items, but a 2-score item still gets a chance).
    const weights = scoredItems.map(s => Math.pow(s.score, 2) + 1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalW;
    let picked = scoredItems[0];
    for (let i = 0; i < scoredItems.length; i++) {
      r -= weights[i];
      if (r <= 0) { picked = scoredItems[i]; break; }
    }
    const item = picked.item;
    console.log(`\n  Selected (score=${picked.score}/N, feed=${item.feedName || 'unknown'}): ${item.title.slice(0, 90)}`);
    console.log(`  Source URL: ${item.link}`);
    
    const prompt = `You are a senior analyst at Insight Analytics, a Canadian analytics consultancy writing for CEOs, CFOs, COOs, and board members. Your sources are tier-1 analyst houses and consulting firms (Gartner, McKinsey, BCG, Bain, Deloitte, Accenture, PwC, EY, KPMG, Forrester) and business-school journals (HBR, MIT Sloan, Stanford GSB, Wharton, INSEAD). Your job is to translate their research into a board-grade executive briefing — no fluff, no consumer-blog tone, no marketing copy, no news-recap.

This article originated from: ${item.feedName || 'a tier-1 business publication'}
Source article title: ${item.title}
Source article URL: ${item.link}
Source article description: ${item.desc || '(no description provided)'}

Write a 500-word ANALYTICAL executive briefing as flowing prose. You MUST:

1. Open with a single-sentence headline takeaway (the one thing a CEO/CFO/COO needs to know — quantitative if possible).

2. In the next 3-4 paragraphs, anchor EVERY paragraph in at least one of these CEO lenses:
   • Corporate governance & board (governance, fiduciary, ESG, compliance, board oversight)
   • Profitability & margin (gross margin, operating margin, EBITDA, EPS impact, unit economics)
   • Cost structure & efficiency (opex, capex, process improvement, lean, six sigma, run-rate)
   • ROI & capital allocation (payback, NPV, IRR, free cash flow, capital efficiency)
   • AI implementation cost & value (AI spend, inference cost, productivity gain, AI maturity, AI governance)
   • Markets & market research (market sizing, TAM, segmentation, valuation, multiple expansion/compression)
   • Logistics, supply chain & optimization (OTIF, network optimization, inventory optimization, nearshoring)
   • Treasury & enterprise risk (liquidity, working capital, hedge, ERM, cyber risk, credit rating)
   • M&A / strategy (deals, synergies, divestitures, portfolio review, corporate strategy)

3. Reference the source by name where appropriate (e.g. "McKinsey's analysis shows...", "HBR research on...", "Wharton's findings on..."). Use the source's analytical lens — if it's a research piece, treat it as research; if it's a strategy piece, treat it as analyst strategy. Do NOT fabricate statistics, surveys, or frameworks that the source did not actually publish — if the source description is thin, anchor the analysis in the source's stated topic and the CEO lenses above.

4. Use **bold** for key numbers, named entities, and analytical concepts (e.g. **EBITDA margin**, **Gartner's 2026 CIO Survey**, **Monte Carlo simulation**).

5. Close with 1 paragraph of synthesizing analysis — step back and place the findings in their broader business context. Weigh the strategic implications for executives (trade-offs, second-order effects, what it means for capital allocation, governance, competitive position). This is an analyst's reflective conclusion, NOT a to-do list. HARD RULES for the closing paragraph:
   - Do NOT use the phrase "What executives should do" (or any variant like "What leaders should do", "What boards should do", "Action items", "Next steps").
   - Do NOT use imperative voice ("convene the audit committee", "reallocate capex", "commission a benchmark"). The analyst does not give orders.
   - Do NOT use bullet lists or numbered lists in the closing.
   - DO write in the analytical third-person register of an HBR or McKinsey closing paragraph — declarative sentences about strategic implications, trade-offs, and what the findings mean for the broader business. Examples of acceptable phrasing: "The findings suggest that...", "For boards weighing similar moves, the trade-off between... and... is likely to sharpen", "The implication for capital allocation is that...", "Whether this approach generalizes beyond... remains an open question".
   - DO end the paragraph (and the article) on a reflective, contextual note — not a command.

No H2 headers. No bullet lists. No preamble like "Here is the summary". No news-recap tone ("Company X announced..."). Just the analyst-grade briefing, naturally flowing.`;
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
      // Decode HTML entities in the title before passing to the template
      // so the article <title>/<h1>/OG tags show clean characters instead of
      // double-escaped "&amp;#x2018;".
      const cleanTitle = decodeEntities(item.title);
      // Pick the dominant CEO lens as the article category so the Insights
      // index cards make the topic obvious at a glance.
      const category = pickExecutiveCategory(item);
      const postHTML = generateBlogPostHTML({
        title: cleanTitle,
        body: wrappedBody,
        category,
        sourceUrl: item.link,
        sourceName: item.feedName || 'Original article',
        keywords: 'CEO insights, executive analysis, profitability, ROI, cost analysis, AI implementation, logistics, markets, ' + cleanTitle.split(/\s+/).slice(0, 5).join(', ').toLowerCase(),
        slug,
        dateStr: DATE_STR,
        isoDate: ISO_NOW
      });
      
      writeFileSync(join(REPO_ROOT, 'insights', slug + '.html'), postHTML);
      generated.push({ slug, title: cleanTitle, category, dateStr: DATE_STR, readTime: 3 });
      console.log(`  ✅ Generated: insights/${slug}.html (category=${category})`);
    }
  }
  
  // NOTE: Feature-article generation removed per user direction:
  // "Do not build made-up content, scout the net only."
  // Every article now originates from a real RSS item with a source URL.
  
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
      <h2>${escHtml(post.title.replace(/&#8217;/g, "'").replace(/&#8216;/g, "'").replace(/&amp;/g, '&').replace(/&#8211;/g, '-'))}</h2>
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
