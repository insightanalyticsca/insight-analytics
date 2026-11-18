#!/usr/bin/env python3
"""
inject_product_links.py — Add contextual internal links from insight articles
to relevant product/demo pages.

Strategy:
  - Scan the <section class="article-body"> of each /insights/*.html article.
  - For each product page (defined in PRODUCT_LINKS below, in priority order),
    find the FIRST occurrence of any of its trigger keywords in the article's
    plain text (not inside headings, not inside existing <a> tags, not inside
    <script>/<style>/<button>).
  - Wrap that occurrence in <a href="..." class="internal-product-link">…</a>.
  - Stop after MAX_LINKS_PER_ARTICLE total links have been added (default 3).
  - Each product gets at most 1 link per article (don't spam the same product).
  - Skip articles where no keywords match.
  - Report what was linked so we can audit.

Safety:
  - Never inject inside <h1>-<h6>, <a>, <button>, <script>, <style>, <code>,
    <pre>, <textarea>, <input>, <head>.
  - Preserve original case in anchor text (don't normalize).
  - Don't match substrings of larger words (use word boundaries).
  - Don't re-link text that's already inside an <a> tag.

USAGE
  python3 inject_product_links.py --dry-run           # scan all, report only
  python3 inject_product_links.py --dry-run --limit 5 # scan first 5 articles
  python3 inject_product_links.py --article insights/foo.html  # one article
  python3 inject_product_links.py                     # apply to all 125
  python3 inject_product_links.py --revert            # strip all previously
                                                      # injected links (by
                                                      # class="internal-product-link")
"""

from pathlib import Path
import os
import re
import argparse
import sys

# ───────── Product link mapping (in priority order) ─────────
# Each entry:
#   url:           absolute path to the product page (no .html — clean URL)
#   keywords:      list of phrases that, when found in article body text,
#                  trigger a link to this product. Case-insensitive match,
#                  original case preserved in anchor text.
#   max_per_article: hard cap on links to this specific product per article
#                    (always 1 — don't link the same product twice)
# Longer / more specific phrases first within each product's keyword list,
# so "executive dashboard" wins over "dashboard" when both appear.

PRODUCT_LINKS = [
    {
        'url': '/demos/universal-dashboard-builder',
        'keywords': [
            'executive dashboard',
            'KPI dashboard',
            'real-time KPIs',
            'real-time KPI',
            'executive KPIs',
            'dashboard builder',
            'universal dashboard',
            'operational dashboard',
            'performance dashboard',
            'real-time metrics',
            'executive metrics',
            'real-time visibility',
            'operational visibility',
            'executive visibility',
            'performance metrics',
            'supply chain visibility',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/ai-dashboard-builder',
        'keywords': [
            'AI-assisted dashboard',
            'AI dashboard',
            'AI-powered dashboard',
            'generative dashboard',
            'AI-generated dashboard',
            'natural language dashboard',
            'plain English dashboard',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/universal-time-series-prediction',
        'keywords': [
            'time series prediction',
            'time series forecasting',
            'time-series forecasting',
            'time-series prediction',
            'time series model',
            'time-series model',
            'predictive model',
            'forecasting model',
            'statistical forecast',
            'predictive analytics',
            'machine learning model',
            'time series',
            'time-series',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/weather-load-forecast',
        'keywords': [
            'load forecast',
            'weather-driven forecast',
            'electricity load forecast',
            'energy forecast',
            'demand forecast',
            'weather-driven load',
            'load forecasting',
            'demand forecasting',
            'load prediction',
            'energy consumption',
            'energy demand',
            'electricity demand',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/database-archaeology',
        'keywords': [
            'legacy database',
            'legacy system migration',
            'database archaeology',
            'schema mapping',
            'database dependencies',
            'legacy code base',
            'legacy database schema',
            'legacy system',
            'legacy systems',
            'database migration',
            'technical debt',
            'system modernization',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/fuzzy-address-matching',
        'keywords': [
            'fuzzy matching',
            'address matching',
            'address deduplication',
            'data silos',
            'data silo',
            'geocoding',
            'address standardization',
            'fuzzy address',
            'data deduplication',
            'data quality issue',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/demos/personalized-power-automate',
        'keywords': [
            'Power Automate',
            'workflow automation',
            'AI pipeline builder',
            'personalized automation',
            'workflow orchestration',
            'RPA',
            'robotic process automation',
            'warehouse automation',
            'process automation',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/dashboards-preview/custom-html/its-service-health',
        'keywords': [
            'IT service health',
            'service health monitoring',
            'IT monitoring',
            'ticket SLA',
            'SLA compliance',
            'IT operations dashboard',
            'service desk performance',
            'service desk',
            'IT operations',
            'IT service',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/dashboards-preview/custom-html/executive-customer-payments',
        'keywords': [
            'customer payments',
            'payment trends',
            'accounts receivable',
            'AR aging',
            'payment performance',
            'collections dashboard',
            'payment processing',
            'accounts receivable aging',
            'invoice processing',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/dashboards-preview/custom-html/executive-ebill-performance',
        'keywords': [
            'e-bill adoption',
            'e-bill performance',
            'electronic billing',
            'billing adoption',
            'ebill',
            'paperless billing',
            'e-bill',
        ],
        'max_per_article': 1,
    },
    {
        'url': '/solutions-showcase/',
        'keywords': [
            'solutions showcase',
            'project catalog',
            'case study catalog',
            'engagement portfolio',
            'case studies',
        ],
        'max_per_article': 1,
    },
]

MAX_LINKS_PER_ARTICLE = 3  # total product links per article across all products

# ───────── Protected regions ─────────
# These are regexes that match HTML regions where we must NEVER inject a link.
# Each pattern captures the full region (open tag through close tag) so we can
# mask them out before doing keyword substitution.
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

# ───────── Helpers ─────────
def mask_protected_regions(html: str):
    """
    Replace each protected region with a placeholder token like \x00PROT_0001\x00.
    Returns (masked_html, restore_map) where restore_map[token] = original_html.
    """
    restore_map = {}
    counter = [0]

    def _replace(m):
        token = f"\x00PROT_{counter[0]:04d}\x00"
        restore_map[token] = m.group(0)
        counter[0] += 1
        return token

    # Combine all protected patterns into one regex (case-insensitive, DOTALL)
    combined = re.compile(
        '|'.join(f'(?:{p})' for p in PROTECTED_REGION_PATTERNS),
        re.IGNORECASE | re.DOTALL
    )
    masked = combined.sub(_replace, html)
    return masked, restore_map


def restore_protected_regions(html: str, restore_map: dict) -> str:
    """Replace each placeholder token with its original HTML."""
    for token, original in restore_map.items():
        html = html.replace(token, original)
    return html


def inject_link(masked_body: str, keyword: str, url: str) -> tuple:
    """
    Find the FIRST case-insensitive occurrence of `keyword` in masked_body
    that is NOT inside a placeholder (placeholders are \x00PROT_xxxx\x00).
    Wrap it in <a href="url" class="internal-product-link">…</a>, preserving
    original case.

    Returns (new_body, anchor_text_matched) or (original_body, None) if no match.
    """
    # Build a regex that matches the keyword:
    # - Case-insensitive
    # - Not preceded/followed by a word character (so "KPI" doesn't match inside "KPIs" — wait, we DO want "KPIs" to match if the keyword is "KPI dashboard"; the word boundary handles this)
    # - Not inside a placeholder (which starts with \x00)
    # Use re.escape on the keyword for safety.
    pattern = re.compile(
        r'(?<![\w\x00])(' + re.escape(keyword) + r')(?![\w])',
        re.IGNORECASE
    )
    m = pattern.search(masked_body)
    if not m:
        return masked_body, None

    matched_text = m.group(1)  # original case preserved
    # Build the replacement <a> tag
    replacement = f'<a href="{url}" class="internal-product-link">{matched_text}</a>'
    new_body = masked_body[:m.start(1)] + replacement + masked_body[m.end(1):]
    return new_body, matched_text


def process_article(html: str) -> tuple:
    """
    Process one article's full HTML.
    Returns (new_html, list_of_link_descriptions).
    Each description: {product_url, keyword, anchor_text}.
    """
    # Extract article-body section if present
    body_match = re.search(
        r'(<section class="article-body"[^>]*>)(.*?)(</section>)',
        html, re.DOTALL | re.IGNORECASE
    )
    if not body_match:
        return html, []  # no article-body — skip silently

    body_open, body_content, body_close = body_match.group(1), body_match.group(2), body_match.group(3)

    # Pre-scan: find product URLs already linked in this article from a prior run.
    # This makes the script truly idempotent — re-running on an already-patched
    # article adds 0 new links because every product is already in products_linked.
    products_linked = set()
    for m in re.finditer(
        r'<a\s+href="([^"]+)"\s+class="internal-product-link"',
        body_content, re.IGNORECASE
    ):
        products_linked.add(m.group(1))
    # Also count existing links toward MAX_LINKS_PER_ARTICLE
    existing_link_count = len(products_linked)

    # Mask protected regions in the body
    masked, restore_map = mask_protected_regions(body_content)

    links_added = []

    for product in PRODUCT_LINKS:
        if existing_link_count + len(links_added) >= MAX_LINKS_PER_ARTICLE:
            break
        if product['url'] in products_linked:
            continue
        # Try each keyword in order (longest/most-specific first)
        for kw in product['keywords']:
            new_masked, matched = inject_link(masked, kw, product['url'])
            if matched:
                masked = new_masked
                products_linked.add(product['url'])
                links_added.append({
                    'product_url': product['url'],
                    'keyword': kw,
                    'anchor_text': matched,
                })
                break  # move to next product, don't add another link to same product

    if not links_added:
        return html, []

    # Restore protected regions
    new_body_content = restore_protected_regions(masked, restore_map)

    # Reassemble
    new_html = (
        html[:body_match.start()] +
        body_open + new_body_content + body_close +
        html[body_match.end():]
    )
    return new_html, links_added


def revert_article(html: str) -> tuple:
    """Strip all <a class="internal-product-link">…</a> wrappers, leaving the inner text."""
    pattern = re.compile(
        r'<a\s+href="[^"]*"\s+class="internal-product-link"[^>]*>(.*?)</a>',
        re.DOTALL | re.IGNORECASE
    )
    new_html, n = pattern.subn(r'\1', html)
    return new_html, n


# ───────── Main ─────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true',
                    help='scan and report, write nothing')
    ap.add_argument('--limit', type=int, default=None,
                    help='process only the first N articles (for testing)')
    ap.add_argument('--article', type=str, default=None,
                    help='process a single article file path')
    ap.add_argument('--revert', action='store_true',
                    help='strip all previously injected internal-product-link wrappers')
    ap.add_argument('--site-root', type=str,
                    default=None,
                    help='repo root (default: env SITE_ROOT or auto-detect via cwd). '
                         'Set this or SITE_ROOT when running inside GitHub Actions.')
    args = ap.parse_args()

    # Resolve site root: CLI flag > env var > auto-detect from this script's location
    if args.site_root:
        site_root = Path(args.site_root)
    elif os.environ.get('SITE_ROOT'):
        site_root = Path(os.environ['SITE_ROOT'])
    else:
        # Auto-detect: walk up from this script's directory looking for insights/ + .github/
        here = Path(__file__).resolve().parent
        for candidate in [here.parent, here.parent.parent, Path.cwd()]:
            if (candidate / 'insights').is_dir() and (candidate / '.github').is_dir():
                site_root = candidate
                break
        else:
            # Fallback: assume cwd is the site root
            site_root = Path.cwd()
    if not (site_root / 'insights').is_dir():
        sys.exit(f"FATAL: site_root {site_root} has no insights/ directory. "
                 f"Pass --site-root or set SITE_ROOT env var.")

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
    articles_skipped = 0
    product_link_counts = {}  # product_url → count

    for art_path in articles:
        try:
            rel = str(art_path.relative_to(site_root))
        except ValueError:
            rel = str(art_path)
        original = art_path.read_text()

        if args.revert:
            new_html, n = revert_article(original)
            if n > 0:
                if not args.dry_run:
                    art_path.write_text(new_html)
                print(f"  REVERTED {n} link(s)  {rel}")
            continue

        new_html, links = process_article(original)

        if links:
            articles_modified += 1
            total_links += len(links)
            for L in links:
                product_link_counts[L['product_url']] = product_link_counts.get(L['product_url'], 0) + 1
                print(f"  [{rel[:55]:55}]  '{L['anchor_text'][:30]}'  →  {L['product_url']}")
            if not args.dry_run:
                art_path.write_text(new_html)
        else:
            articles_skipped += 1
            print(f"  (no keywords matched)  {rel[:70]}")

    print()
    print(f"=== Summary ===")
    if args.revert:
        print(f"  Articles reverted: {articles_modified}")
    else:
        print(f"  Articles scanned:  {len(articles)}")
        print(f"  Articles modified: {articles_modified}")
        print(f"  Articles skipped (no keyword match): {articles_skipped}")
        print(f"  Total links added: {total_links}")
        print(f"  Avg links / modified article: {total_links / max(articles_modified, 1):.1f}")
        print()
        print(f"  Links by product:")
        for url, cnt in sorted(product_link_counts.items(), key=lambda kv: -kv[1]):
            print(f"    {cnt:4}  {url}")


if __name__ == '__main__':
    main()
