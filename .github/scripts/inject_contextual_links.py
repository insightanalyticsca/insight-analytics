#!/usr/bin/env python3
"""
inject_contextual_links.py — Smart contextual linker for insight articles.

For each article, scans title + body, scores every "live app / dashboard"
target by topical keyword density, picks the BEST match, and injects ONE
creative link + parenthetical aside at the first natural anchor.

Targets covered:
  - Live apps in /demos/  (markets dashboard, AI dashboard builder, time series,
    weather load forecast, database archaeology, fuzzy address matching,
    personalized power automate)
  - Dashboards in /dashboards-preview/custom-html/  (IT service health,
    customer payments, e-bill performance)
  - Executive dashboards on insightanalyticsca.github.io/dashboards/  (Meridian
    supply chain, Velocity SaaS growth, Sentinel banking risk)

Creative parentheticals rotate per-article (deterministic hash) so the same
aside doesn't appear on every link — keeps the writing feeling human.

Idempotent: pre-scans for class="contextual-link" and skips already-linked
articles. Safe to re-run on every cron tick.

USAGE
  python3 inject_contextual_links.py            # apply to all 125 articles
  python3 inject_contextual_links.py --dry-run  # scan + report, write nothing
  python3 inject_contextual_links.py --article insights/foo.html
  python3 inject_contextual_links.py --revert   # strip all contextual-link
                                                # wrappers + parentheticals
"""

from pathlib import Path
import os
import re
import argparse
import sys
import hashlib

# ───────── Target inventory ─────────
# Each target: URL, name (for parenthetical), keywords (priority order,
# most specific first), and a list of varied parenthetical asides.
# The script picks the target with the highest keyword-match count in
# the article (must be ≥ MIN_MATCHES_TO_LINK).

TARGETS = [
    # ─── Live apps in /demos/ ──────────────────────────────────────────
    {
        'url': '/demos/universal-dashboard-builder',
        'name': 'Live Markets Dashboard',
        'min_matches': 2,
        'keywords': [
            # Multi-word (specific) first
            'stock market', 'S&P 500', 'Treasury yields', 'Treasury futures',
            'bond yields', 'bond market', 'Fed rate', 'federal reserve',
            'earnings report', 'PCE index', 'CPI report', 'inflation data',
            'jobs report', 'jobs data', 'oil prices', 'crude oil',
            'Wall Street', 'equity markets', 'stock rebound', 'stocks fell',
            'stocks rose', 'stocks dropped', 'stocks finish', 'stocks fall',
            'Nasdaq', 'S&P', 'Dow Jones',
            # Single-word (broad) — only used if article is clearly financial
            'stocks', 'bonds', 'yields', 'equities',
        ],
        'parentheticals': [
            '(see live markets dashboard →)',
            '(see this move in real-time →)',
            '(interactive markets viz →)',
            '(watch the market reaction live →)',
            '(see live market reaction →)',
            '(real-time markets dashboard →)',
            '(live chart →)',
            '(see the dashboard track this live →)',
        ],
    },
    {
        'url': '/demos/ai-dashboard-builder',
        'name': 'AI Dashboard Builder',
        'min_matches': 2,
        'keywords': [
            'AI-assisted dashboard', 'AI dashboard', 'AI-powered dashboard',
            'generative dashboard', 'AI-generated dashboard',
            'natural language dashboard', 'plain English dashboard',
            'dashboard generation', 'AI use case',
        ],
        'parentheticals': [
            '(try the AI dashboard builder →)',
            '(see it build a dashboard live →)',
            '(interactive AI demo →)',
            '(generate a dashboard from a prompt →)',
        ],
    },
    {
        'url': '/demos/universal-time-series-prediction',
        'name': 'Time Series Prediction',
        'min_matches': 2,
        'keywords': [
            'time series prediction', 'time series forecasting',
            'time-series forecasting', 'time-series prediction',
            'time series model', 'time-series model',
            'predictive model', 'forecasting model',
            'statistical forecast', 'predictive analytics',
            'machine learning model', 'time series', 'time-series',
        ],
        'parentheticals': [
            '(see live time-series demo →)',
            '(try the prediction engine →)',
            '(interactive forecast model →)',
            '(see the model run on real data →)',
        ],
    },
    {
        'url': '/demos/weather-load-forecast',
        'name': 'Weather Load Forecast',
        'min_matches': 2,
        'keywords': [
            'load forecast', 'weather-driven forecast',
            'electricity load forecast', 'energy forecast',
            'demand forecast', 'weather-driven load',
            'load forecasting', 'demand forecasting',
            'load prediction', 'energy consumption',
            'energy demand', 'electricity demand',
            'grid operator', 'utility company',
        ],
        'parentheticals': [
            '(see live load-forecast demo →)',
            '(interactive weather-driven model →)',
            '(see the forecast run →)',
            '(try the energy prediction →)',
        ],
    },
    {
        'url': '/demos/database-archaeology',
        'name': 'Database Archaeology',
        'min_matches': 2,
        'keywords': [
            'legacy database', 'legacy system migration',
            'database archaeology', 'schema mapping',
            'database dependencies', 'legacy code base',
            'legacy database schema', 'legacy system',
            'legacy systems', 'database migration',
            'technical debt', 'system modernization',
        ],
        'parentheticals': [
            '(see live database archaeology demo →)',
            '(try the legacy-system mapper →)',
            '(interactive dependency map →)',
            '(see it walk a real schema →)',
        ],
    },
    {
        'url': '/demos/fuzzy-address-matching',
        'name': 'Fuzzy Address Matching',
        'min_matches': 2,
        'keywords': [
            'fuzzy matching', 'address matching',
            'address deduplication', 'data silos',
            'data silo', 'geocoding', 'address standardization',
            'fuzzy address', 'data deduplication', 'data quality issue',
        ],
        'parentheticals': [
            '(see live fuzzy-match demo →)',
            '(try the address resolver →)',
            '(interactive deduplication →)',
            '(see it merge siloed records →)',
        ],
    },
    {
        'url': '/demos/personalized-power-automate',
        'name': 'Personalized Power Automate',
        'min_matches': 2,
        'keywords': [
            'Power Automate', 'workflow automation',
            'AI pipeline builder', 'personalized automation',
            'workflow orchestration',
            'robotic process automation',
            'warehouse automation', 'process automation',
        ],
        'parentheticals': [
            '(see live pipeline-builder demo →)',
            '(try the AI workflow builder →)',
            '(interactive automation →)',
            '(see it generate a pipeline →)',
        ],
    },
    # ─── Dashboards in /dashboards-preview/custom-html/ ────────────────
    {
        'url': '/dashboards-preview/custom-html/its-service-health.html',
        'name': 'IT Service Health Dashboard',
        'min_matches': 2,
        'keywords': [
            'IT service health', 'service health monitoring',
            'IT monitoring', 'ticket SLA', 'SLA compliance',
            'IT operations dashboard', 'service desk performance',
            'service desk', 'IT operations', 'IT service',
            'incident management', 'help desk',
        ],
        'parentheticals': [
            '(see live IT service dashboard →)',
            '(interactive ticket SLA viz →)',
            '(see the service desk live →)',
            '(real-time IT ops dashboard →)',
        ],
    },
    {
        'url': '/dashboards-preview/custom-html/executive-customer-payments.html',
        'name': 'Customer Payments Dashboard',
        'min_matches': 2,
        'keywords': [
            'customer payments', 'payment trends',
            'accounts receivable', 'AR aging',
            'payment performance', 'collections dashboard',
            'payment processing', 'accounts receivable aging',
            'invoice processing', 'cash flow management',
        ],
        'parentheticals': [
            '(see live payments dashboard →)',
            '(interactive AR aging chart →)',
            '(see payment trends live →)',
            '(real-time collections viz →)',
        ],
    },
    {
        'url': '/dashboards-preview/custom-html/executive-ebill-performance.html',
        'name': 'E-Bill Performance Dashboard',
        'min_matches': 2,
        'keywords': [
            'e-bill adoption', 'e-bill performance',
            'electronic billing', 'billing adoption',
            'ebill', 'paperless billing', 'e-bill',
        ],
        'parentheticals': [
            '(see live e-bill dashboard →)',
            '(interactive adoption chart →)',
            '(see billing metrics live →)',
        ],
    },
    # ─── Executive dashboards (insightanalyticsca.github.io/dashboards/) ──
    {
        'url': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-meridian.html',
        'name': 'Meridian Supply Chain Operations Center',
        'min_matches': 2,
        'keywords': [
            # Natural descriptive phrases first (better anchor text than acronyms)
            'supply chain visibility', 'supply chain operations',
            'freight visibility', 'carrier performance',
            'disruption monitoring', 'warehouse execution',
            'inventory optimization', 'service level',
            'fill rate', 'last mile', 'demand planning',
            'lead time', 'on-time delivery', 'order fulfillment',
        ],
        'parentheticals': [
            '(see live supply chain dashboard →)',
            '(interactive supply chain viz →)',
            '(see the network live →)',
            '(real-time operations center →)',
            '(see live logistics dashboard →)',
            '(interactive operations viz →)',
            '(see the operations center →)',
            '(live supply chain ops →)',
        ],
    },
    {
        'url': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-velocity.html',
        'name': 'Velocity SaaS Growth & Retention Intelligence',
        'min_matches': 2,
        'keywords': [
            'SaaS growth', 'subscription retention', 'churn rate',
            'net revenue retention', 'annual recurring revenue',
            'customer lifetime value', 'cohort analysis',
            'retention curve', 'SaaS metrics',
            'monthly recurring revenue',
        ],
        'parentheticals': [
            '(see live SaaS dashboard →)',
            '(interactive retention chart →)',
            '(see churn/revenue live →)',
            '(real-time growth metrics →)',
        ],
    },
    {
        'url': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-sentinel.html',
        'name': 'Sentinel Real-Time Risk & Treasury Intelligence',
        'min_matches': 2,
        'keywords': [
            'treasury risk', 'fiduciary oversight', 'capital adequacy',
            'liquidity risk', 'credit risk exposure',
            'banking risk', 'treasury operations',
            'cash position', 'fx exposure', 'interest rate risk',
            'operational risk', 'risk dashboard',
            'retail banking', 'loan portfolio', 'net interest margin',
            'banking profitability', 'deposits', 'bank capital',
            'stress testing',
        ],
        'parentheticals': [
            '(see live risk dashboard →)',
            '(see exposure live →)',
            '(real-time risk intelligence →)',
            '(interactive risk viz →)',
            '(see live banking risk dashboard →)',
            '(live treasury viz →)',
        ],
    },
    {
        'url': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-operations-universal.html',
        'name': 'Retail Operations Dashboard',
        'min_matches': 2,
        'keywords': [
            'retail operations', 'multi-unit retail',
            'store performance', 'revenue mix',
            'capacity heatmap', 'retail KPIs',
            'same-store sales', 'comp sales',
            'store productivity', 'retail metrics',
        ],
        'parentheticals': [
            '(see live retail dashboard →)',
            '(interactive store-level viz →)',
            '(see revenue/capacity live →)',
            '(real-time retail ops →)',
        ],
    },
]

MIN_MATCHES_TO_LINK = 1  # default if not specified per-target — any single keyword match triggers a link
# No MIN_WEIGHTED_SCORE gate — the min_matches check is the real quality filter.
# The weighted score (title×10 + firstpara×5 + body×1) is used for CHOOSING
# between targets when multiple match, not for filtering.

# ───────── Weighted scoring ─────────
# An article's title and first paragraph signal its PRIMARY topic much more
# strongly than the body. A stocks article might mention "inventory optimization"
# in passing in the body, but its title "Stocks Down Ahead of Nvidia Earnings"
# makes it unambiguously a markets article. Weight accordingly:
TITLE_WEIGHT = 10
FIRST_PARA_WEIGHT = 5
BODY_WEIGHT = 1

# ───────── Protected regions (same as inject_product_links.py) ─────────
PROTECTED_REGION_PATTERNS = [
    r'<script[^>]*>.*?</script>',
    r'<style[^>]*>.*?</style>',
    r'<head[^>]*>.*?</head>',
    r'<h[1-6][^>]*>.*?</h[1-6]>',
    r'<a\s[^>]*>.*?</a>',
    r'<a[^>]*>.*?</a>',
    r'<button[^>]*>.*?</button>',
    r'<code[^>]*>.*?</code>',
    r'<pre[^>]*>.*?</pre>',
    r'<textarea[^>]*>.*?</textarea>',
    r'<!--.*?-->',
]


def mask_protected_regions(html: str):
    restore_map = {}
    counter = [0]

    def _replace(m):
        token = f"\x00PROT_{counter[0]:04d}\x00"
        restore_map[token] = m.group(0)
        counter[0] += 1
        return token

    combined = re.compile(
        '|'.join(f'(?:{p})' for p in PROTECTED_REGION_PATTERNS),
        re.IGNORECASE | re.DOTALL
    )
    return combined.sub(_replace, html), restore_map


def restore_protected_regions(html: str, restore_map: dict) -> str:
    for token, original in restore_map.items():
        html = html.replace(token, original)
    return html


# ───────── Scoring + injection ─────────
def extract_title_and_first_para(html: str) -> tuple:
    """Extract the article title (from <h1> or <title>) and the first paragraph
    of the article-body section. Returns (title_text, first_para_text)."""
    # Title: prefer <h1> inside article-hero, fall back to <title>
    title = ''
    m = re.search(r'<section class="article-hero"[^>]*>(.*?)</section>', html, re.DOTALL | re.IGNORECASE)
    if m:
        h1 = re.search(r'<h1[^>]*>(.*?)</h1>', m.group(1), re.DOTALL | re.IGNORECASE)
        if h1:
            title = re.sub(r'<[^>]+>', '', h1.group(1)).strip()
    if not title:
        m = re.search(r'<title>([^<]+)</title>', html)
        if m:
            title = m.group(1).split('|')[0].strip()

    # First paragraph of article-body
    first_para = ''
    body_match = re.search(r'<section class="article-body"[^>]*>(.*?)</section>',
                           html, re.DOTALL | re.IGNORECASE)
    if body_match:
        body = body_match.group(1)
        # Skip the "← Back to all insights" link, find first <p> with substantive content
        for p_match in re.finditer(r'<p[^>]*>(.*?)</p>', body, re.DOTALL | re.IGNORECASE):
            para_text = re.sub(r'<[^>]+>', '', p_match.group(1)).strip()
            if len(para_text) > 40:  # skip trivial paragraphs
                first_para = para_text
                break

    return title, first_para


def count_keyword_matches(text: str, keyword: str) -> int:
    """Count distinct occurrences of keyword in text (case-insensitive, word-bounded)."""
    if not text:
        return 0
    pattern = re.compile(r'(?<![\w])' + re.escape(keyword.lower()) + r'(?![\w])')
    return len(pattern.findall(text.lower()))


def score_target(title: str, first_para: str, body_text: str, target: dict) -> tuple:
    """Weighted scoring: title×10 + first_para×5 + body×1.
    Returns (weighted_score, list_of_matching_keywords_in_priority_order)."""
    matching_keywords = []
    title_count_total = 0
    firstpara_count_total = 0
    body_count_total = 0
    for kw in target['keywords']:
        t_count = count_keyword_matches(title, kw)
        f_count = count_keyword_matches(first_para, kw)
        b_count = count_keyword_matches(body_text, kw)
        if t_count + f_count + b_count > 0:
            matching_keywords.append(kw)
        title_count_total += t_count
        firstpara_count_total += f_count
        body_count_total += b_count
    weighted = (title_count_total * TITLE_WEIGHT
                + firstpara_count_total * FIRST_PARA_WEIGHT
                + body_count_total * BODY_WEIGHT)
    return weighted, matching_keywords


def pick_best_target(title: str, first_para: str, body_text: str,
                     already_linked_urls: set, article_slug: str) -> tuple:
    """Pick the highest-WEIGHTED-scoring target. Returns
    (target_dict, weighted_score, list_of_matching_keywords_in_priority_order)
    or (None, 0, [])."""
    best = None
    best_score = 0
    best_matching_keywords = []
    for target in TARGETS:
        if target['url'] in already_linked_urls:
            continue
        score, matching_kws = score_target(title, first_para, body_text, target)
        threshold_matches = target.get('min_matches', MIN_MATCHES_TO_LINK)
        if len(matching_kws) >= threshold_matches and score > best_score:
            best = target
            best_score = score
            best_matching_keywords = matching_kws
    if not best:
        return None, 0, []
    return best, best_score, best_matching_keywords


def pick_parenthetical(target: dict, article_slug: str) -> str:
    """Deterministic rotation based on article slug hash so each article
    gets a stable but varied parenthetical."""
    h = int(hashlib.md5(article_slug.encode()).hexdigest(), 16)
    return target['parentheticals'][h % len(target['parentheticals'])]


def inject_link(masked_body: str, keyword: str, url: str, target_name: str) -> tuple:
    """Inject a SINGLE parenthetical link at the end of the current sentence.
    
    Format: (keyword — see target_name →)
    The ENTIRE parenthetical is the link text. No separate aside span.
    
    Placement: finds the first occurrence of the keyword, then scans forward
    to the end of that sentence (. ! ? ; or </p>), and inserts the link
    right after the terminator.
    
    Returns (new_body, keyword_matched) or (original, None) if keyword not found."""
    # Step 1: verify the keyword exists somewhere in the body (don't link if not present)
    find_pattern = re.compile(
        r'(?<![\w\x00])' + re.escape(keyword) + r'(?![\w])',
        re.IGNORECASE
    )
    if not find_pattern.search(masked_body):
        return masked_body, None

    # Step 2: find the end of the FIRST sentence in the body.
    # We insert the link at the end of the first sentence (after the first . ! ? ;)
    # OR at the end of the first <p> if no sentence terminator is found.
    # This places the link early in the article (high visibility) and at a
    # natural reading break.
    insert_pattern = re.compile(
        r'([.!?;])\s+',           # sentence terminator + whitespace
        re.DOTALL
    )
    insert_match = insert_pattern.search(masked_body)
    
    # Build the single parenthetical link
    link_text = f'({keyword} — see {target_name} →)'
    link_html = f' <a href="{url}" class="internal-product-link contextual-link">{link_text}</a>'
    
    if insert_match:
        # Insert right after the sentence terminator
        insert_pos = insert_match.end()
        new_body = masked_body[:insert_pos] + link_html + masked_body[insert_pos:]
    else:
        # No sentence terminator found — insert at end of first <p>
        p_end = masked_body.find('</p>')
        if p_end != -1:
            new_body = masked_body[:p_end] + link_html + masked_body[p_end:]
        else:
            # Last resort: append at end of body
            new_body = masked_body + link_html
    
    return new_body, keyword


def process_article(html: str, article_slug: str) -> tuple:
    """Returns (new_html, link_description_or_None)."""
    body_match = re.search(
        r'(<section class="article-body"[^>]*>)(.*?)(</section>)',
        html, re.DOTALL | re.IGNORECASE
    )
    if not body_match:
        return html, None

    body_open, body_content, body_close = (
        body_match.group(1), body_match.group(2), body_match.group(3)
    )

    # Pre-scan: skip article if it already has a contextual-link
    if 'class="internal-product-link contextual-link"' in body_content:
        return html, None

    # Collect already-linked URLs (so we don't double-link a product already
    # covered by inject_product_links.py)
    already_linked_urls = set()
    for m in re.finditer(
        r'<a\s+href="([^"]+)"\s+class="internal-product-link[^"]*"',
        body_content, re.IGNORECASE
    ):
        already_linked_urls.add(m.group(1))

    # Plain-text body for body-text scoring
    plain_body = re.sub(r'<[^>]+>', ' ', body_content)
    plain_body = re.sub(r'\s+', ' ', plain_body)

    # Extract title + first paragraph for weighted scoring
    title, first_para = extract_title_and_first_para(html)

    # Pick best target — returns the target + ALL matching keywords
    target, score, matching_keywords = pick_best_target(
        title, first_para, plain_body, already_linked_urls, article_slug)
    if not target or not matching_keywords:
        return html, None

    # Mask the body for injection
    masked, restore_map = mask_protected_regions(body_content)

    # Pick which keyword to use in the link text (deterministic via slug hash)
    h = int(hashlib.md5(article_slug.encode()).hexdigest(), 16)
    rotated = matching_keywords[h % len(matching_keywords):] + matching_keywords[:h % len(matching_keywords)]

    # Try each matching keyword until one is found in the body
    anchor_text = None
    chosen_kw = None
    for kw in rotated:
        new_masked, matched = inject_link(masked, kw, target['url'], target['name'])
        if matched:
            masked = new_masked
            anchor_text = f'({kw} — see {target["name"]} →)'
            chosen_kw = kw
            break

    if not anchor_text:
        # No matching keyword in the body — use the target name alone
        kw = matching_keywords[0] if matching_keywords else target['name']
        link_text = f'(see {target["name"]} →)'
        link_html = f' <a href="{target["url"]}" class="internal-product-link contextual-link">{link_text}</a>'
        # Insert at end of first <p>
        p_end = masked.find('</p>')
        if p_end != -1:
            masked = masked[:p_end] + link_html + masked[p_end:]
        else:
            masked = masked + link_html
        anchor_text = link_text
        chosen_kw = '(target-only)'

    new_body_content = restore_protected_regions(masked, restore_map)
    new_html = (
        html[:body_match.start()] +
        body_open + new_body_content + body_close +
        html[body_match.end():]
    )
    return new_html, {
        'target_url': target['url'],
        'target_name': target['name'],
        'keyword': chosen_kw,
        'anchor_text': anchor_text,
        'score': score,
    }


def revert_article(html: str) -> tuple:
    """Strip ALL contextual-link elements — handles both old and new formats.
    
    Old format: <a ...>keyword</a><span class="link-aside">...</span>
      → unwrap the anchor (keep the keyword text), remove the span entirely
    
    New format: <a ...>(keyword — see dashboard →)</a>
      → remove the entire link (it's a standalone parenthetical)
    
    Returns (new_html, count_removed)."""
    n_total = 0
    
    # Step 1: Remove NEW-format links entirely (standalone parentheticals)
    # These start with '(' in the link text
    new_pattern = re.compile(
        r'\s*<a\s+href="[^"]*"\s+class="internal-product-link contextual-link"[^>]*>\([^<]*</a>',
        re.DOTALL | re.IGNORECASE
    )
    html, n_new = new_pattern.subn('', html)
    n_total += n_new
    
    # Step 2: Remove OLD-format .link-aside spans entirely
    span_pattern = re.compile(
        r'<span class="link-aside">[^<]*</span>',
        re.DOTALL | re.IGNORECASE
    )
    html, n_spans = span_pattern.subn('', html)
    n_total += n_spans
    
    # Step 3: Unwrap OLD-format anchors (keep the inner keyword text)
    # These are <a class="internal-product-link contextual-link">keyword</a>
    # where the text does NOT start with '('
    old_pattern = re.compile(
        r'<a\s+href="[^"]*"\s+class="internal-product-link contextual-link"[^>]*>([^<]+)</a>',
        re.DOTALL | re.IGNORECASE
    )
    html, n_old = old_pattern.subn(r'\1', html)
    n_total += n_old
    
    return html, n_total


# ───────── Main ─────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--article', type=str, default=None)
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--site-root', type=str, default=None)
    args = ap.parse_args()

    # Resolve site root (same logic as inject_product_links.py)
    if args.site_root:
        site_root = Path(args.site_root)
    elif os.environ.get('SITE_ROOT'):
        site_root = Path(os.environ['SITE_ROOT'])
    else:
        here = Path(__file__).resolve().parent
        for candidate in [here.parent, here.parent.parent, Path.cwd()]:
            if (candidate / 'insights').is_dir() and (candidate / '.github').is_dir():
                site_root = candidate
                break
        else:
            site_root = Path.cwd()
    if not (site_root / 'insights').is_dir():
        sys.exit(f"FATAL: site_root {site_root} has no insights/ directory.")

    if args.article:
        articles = [Path(args.article)]
    else:
        articles = sorted((site_root / 'insights').glob('*.html'))
    if args.limit:
        articles = articles[:args.limit]

    print(f"{'DRY-RUN ' if args.dry_run else ''}Processing {len(articles)} articles...")
    print()

    total_links = 0
    articles_modified = 0
    target_counts = {}

    for art_path in articles:
        try:
            rel = str(art_path.relative_to(site_root))
        except ValueError:
            rel = str(art_path)
        slug = art_path.stem
        original = art_path.read_text()

        if args.revert:
            new_html, n = revert_article(original)
            if n > 0:
                if not args.dry_run:
                    art_path.write_text(new_html)
                print(f"  REVERTED {n} piece(s)  {rel[:70]}")
            continue

        new_html, info = process_article(original, slug)
        if info:
            articles_modified += 1
            total_links += 1
            target_counts[info['target_name']] = target_counts.get(info['target_name'], 0) + 1
            print(f"  [{rel[:50]:50}]  '{info['anchor_text'][:24]}' → {info['target_name'][:30]}")
            print(f"    anchor: {info['anchor_text'][:60]}")
            if not args.dry_run:
                art_path.write_text(new_html)

    print()
    print(f"=== Summary ===")
    if args.revert:
        print(f"  Articles reverted: {articles_modified}")
    else:
        print(f"  Articles scanned:  {len(articles)}")
        print(f"  Articles modified: {articles_modified}")
        print(f"  Total links added: {total_links}")
        print()
        print(f"  Links by target:")
        for name, cnt in sorted(target_counts.items(), key=lambda kv: -kv[1]):
            print(f"    {cnt:4}  {name}")


if __name__ == '__main__':
    main()
