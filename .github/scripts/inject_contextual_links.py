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
            'Nasdaq', 'NASDAQ', 'S&P', 'Dow Jones', 'TSX',
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
            'workflow orchestration', 'RPA',
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
            'S&OP', 'lead time', 'OTIF',
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
            'net revenue retention', 'NRR', 'ARR growth',
            'customer lifetime value', 'LTV', 'cohort analysis',
            'retention curve', 'SaaS metrics', 'MRR',
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

MIN_MATCHES_TO_LINK = 2  # default if not specified per-target

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
def score_target(plain_text: str, target: dict) -> tuple:
    """Return (score, first_matched_keyword) for a target on this article."""
    text_lower = plain_text.lower()
    score = 0
    first_match = None
    for kw in target['keywords']:
        # Case-insensitive count of distinct occurrences
        pattern = re.compile(r'(?<![\w])' + re.escape(kw.lower()) + r'(?![\w])')
        matches = pattern.findall(text_lower)
        if matches:
            score += len(matches)
            if first_match is None:
                first_match = kw  # remember the first keyword (in priority order) that matched
    return score, first_match


def pick_best_target(plain_text: str, already_linked_urls: set) -> tuple:
    """Pick the highest-scoring target that hasn't already been linked.
    Returns (target_dict, score, matched_keyword) or (None, 0, None)."""
    best = None
    best_score = 0
    best_kw = None
    for target in TARGETS:
        if target['url'] in already_linked_urls:
            continue
        score, first_kw = score_target(plain_text, target)
        threshold = target.get('min_matches', MIN_MATCHES_TO_LINK)
        if score >= threshold and score > best_score:
            best = target
            best_score = score
            best_kw = first_kw
    return best, best_score, best_kw


def pick_parenthetical(target: dict, article_slug: str) -> str:
    """Deterministic rotation based on article slug hash so each article
    gets a stable but varied parenthetical."""
    h = int(hashlib.md5(article_slug.encode()).hexdigest(), 16)
    return target['parentheticals'][h % len(target['parentheticals'])]


def inject_link(masked_body: str, keyword: str, url: str, parenthetical: str) -> tuple:
    """Find first occurrence of keyword, wrap in <a>, then insert the
    parenthetical aside at the END of the current sentence (or at the
    next </p> if no sentence terminator is found within 300 chars).
    This avoids breaking noun phrases like "Nasdaq 100" or "S&P 500".

    Returns (new_body, anchor_text_matched) or (original, None)."""
    # Step 1: find the keyword and wrap it in <a>
    pattern = re.compile(
        r'(?<![\w\x00])(' + re.escape(keyword) + r')(?![\w])',
        re.IGNORECASE
    )
    m = pattern.search(masked_body)
    if not m:
        return masked_body, None

    matched_text = m.group(1)
    link_html = f'<a href="{url}" class="internal-product-link contextual-link">{matched_text}</a>'
    after_link = masked_body[m.end(1):]

    # Step 2: find where to insert the parenthetical.
    # Look for the next sentence terminator (. ! ? ;) followed by whitespace,
    # OR the next </p> tag, whichever comes first within 400 chars.
    # Skip terminators that are part of abbreviations (e.g. "U.S." — heuristic:
    # single capital letter followed by period).
    insert_pattern = re.compile(
        r'([.!?;])\s+'           # sentence terminator + whitespace
        r'|'
        r'(</p>)',                # end of paragraph
        re.DOTALL
    )
    insert_match = insert_pattern.search(after_link, 0)
    if insert_match and (insert_match.end() <= 400 or insert_match.group(2)):
        # Insert right after the terminator (or after </p>)
        insert_pos = insert_match.end()
        # If we matched </p>, put the aside BEFORE the closing tag (so it's inside the paragraph)
        if insert_match.group(2):
            # actually insert_match.end() is after </p>; we want before, so back up 4 chars
            insert_pos = insert_match.start()
        aside_html = f'<span class="link-aside"> {parenthetical}</span>'
        new_after = after_link[:insert_pos] + aside_html + after_link[insert_pos:]
    else:
        # No good insertion point found within range — fall back to immediate
        # insertion right after the link (rare case, but better than dropping
        # the parenthetical entirely).
        aside_html = f'<span class="link-aside"> {parenthetical}</span>'
        new_after = aside_html + after_link

    new_body = masked_body[:m.start(1)] + link_html + new_after
    return new_body, matched_text


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

    # Plain-text for scoring
    plain = re.sub(r'<[^>]+>', ' ', body_content)
    plain = re.sub(r'\s+', ' ', plain)

    target, score, matched_kw = pick_best_target(plain, already_linked_urls)
    if not target:
        return html, None

    # Mask + inject
    masked, restore_map = mask_protected_regions(body_content)
    parenthetical = pick_parenthetical(target, article_slug)
    new_masked, anchor_text = inject_link(masked, matched_kw, target['url'], parenthetical)
    if not anchor_text:
        return html, None

    new_body_content = restore_protected_regions(new_masked, restore_map)
    new_html = (
        html[:body_match.start()] +
        body_open + new_body_content + body_close +
        html[body_match.end():]
    )
    return new_html, {
        'target_url': target['url'],
        'target_name': target['name'],
        'keyword': matched_kw,
        'anchor_text': anchor_text,
        'parenthetical': parenthetical,
        'score': score,
    }


def revert_article(html: str) -> tuple:
    """Strip contextual-link <a> wrappers + their .link-aside spans."""
    # Remove the <span class="link-aside"> … </span> first
    span_pattern = re.compile(
        r'<span class="link-aside">[^<]*</span>',
        re.DOTALL | re.IGNORECASE
    )
    html, n_spans = span_pattern.subn('', html)
    # Then unwrap the <a class="...contextual-link...">…</a>
    a_pattern = re.compile(
        r'<a\s+href="[^"]*"\s+class="internal-product-link contextual-link"[^>]*>(.*?)</a>',
        re.DOTALL | re.IGNORECASE
    )
    html, n_as = a_pattern.subn(r'\1', html)
    return html, n_as + n_spans


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
            print(f"    {info['parenthetical']}")
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
