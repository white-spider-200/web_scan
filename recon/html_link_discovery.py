#!/usr/bin/env python3
"""
html_link_discovery.py <target> [max_pages] [max_depth]

Dynamic frontier-based crawler (BFS-like, best-first within frontier).

The crawl continues until the frontier is empty OR budgets are hit:
- maxRequests: HTTP fetches
- maxTime: wall-clock time
- maxNodes: unique canonical URLs tracked

Each discovered URL is tracked with:
- depth: discovery depth from the nearest start URL
- parent: canonical URL that first discovered it

To avoid infinite growth, we apply strict URL canonicalization + dedupe, plus
pattern throttling (e.g. /item/123, /item/124 or ?id=1, ?id=2).

Writes JSON to results/html_links_<target>.json:
{
  target, apex,
  budgets: { ... },
  stats: { ... },
  discovered: {
    subdomains: [],
    directories_by_host: {host:[paths]},
    urls: [],
    pages: [],
    api: [],
    feeds: [],
    assets: [],
    routes: [],
    js_files: [],
    requests: [],
    query_urls: []
  },
  crawl_graph: {
    nodes: [{url, depth, parent, score, kind}],
    edges: [{source, target, type}]
  }
}
"""
import sys
import json
import re
import argparse
import time
import heapq
from collections import defaultdict
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, urljoin

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = PROJECT_ROOT / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    import requests
except Exception:  # requests may not be installed in some environments
    requests = None

try:
    from bs4 import BeautifulSoup  # type: ignore
except Exception:
    BeautifulSoup = None

DEFAULT_HEADERS = {"User-Agent": "Mozilla/5.0 (html-link-discovery)"}

try:
    from recon.url_canonicalize import canonical_url, query_param_count, url_pattern_key, is_ip_hostname
except Exception:
    canonical_url = None
    query_param_count = None
    url_pattern_key = None
    is_ip_hostname = None

try:
    from recon.url_classify import classify_url, normalize_url
except Exception:
    classify_url = None
    normalize_url = None

try:
    from recon.js_route_discovery import JsDiscoveryConfig, discover_js_routes
except Exception:
    JsDiscoveryConfig = None
    discover_js_routes = None



def clean_label(target: str) -> str:
    t = target.strip()
    t = re.sub(r"^https?://", "", t, flags=re.I)
    t = t.rstrip('/')
    t = re.sub(r"[^A-Za-z0-9._-]", "_", t)
    return t


def apex_of(host: str) -> str:
    host = host.lower()
    if is_ip_hostname is not None and is_ip_hostname(host):
        return host
    if ':' in host:  # IPv6 literal or host:port-like input
        return host
    # Treat the provided host as the scan scope root (run_all passes the registrable target).
    # This avoids accidentally using public suffixes like "edu.jo" or "co.uk" as scope roots.
    return host


def is_http_url(u: str) -> bool:
    return bool(re.match(r"^https?://", u, re.I))


def absolute_url(base: str, href: str) -> str:
    try:
        return urljoin(base, href)
    except Exception:
        return href


def extract_links(html: str, base_url: str):
    urls = set()
    if BeautifulSoup is not None:
        try:
            soup = BeautifulSoup(html, 'html.parser')
            attrs = ("href", "src", "action", "data", "poster")
            for tag in soup.find_all(True):
                for a in attrs:
                    v = tag.get(a)
                    if not v:
                        continue
                    u = absolute_url(base_url, str(v))
                    if is_http_url(u):
                        urls.add(u)
        except Exception:
            pass
    # fallback: basic regex for href/src
    if not urls:
        for m in re.finditer(r"(?:href|src)\s*=\s*['\"]([^'\"]+)['\"]", html, re.I):
            u = absolute_url(base_url, m.group(1))
            if is_http_url(u):
                urls.add(u)
    return urls


def extract_search_targets(html: str):
    targets = set()
    for m in re.finditer(r'"target"\s*:\s*"([^"]+)"', html, re.I):
        targets.add(m.group(1))
    return sorted(targets)


def normalize_existing(u: str) -> str:
    if canonical_url is not None:
        return canonical_url(u, u) or u
    if normalize_url is None:
        return u
    return normalize_url(u, u) or u


def build_query_urls(base_url: str, seeds):
    urls = []
    for q in seeds:
        qv = str(q).strip()
        if not qv:
            continue
        if "?" in base_url:
            urls.append(f"{base_url}&query={qv}")
        else:
            urls.append(f"{base_url}?query={qv}")
    return urls


def headless_discover(start_url: str, timeout_ms: int = 12000, max_requests: int = 200):
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return "", []
    requests = set()
    html = ""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("request", lambda req: requests.add(req.url) if len(requests) < max_requests else None)
        page.goto(start_url, wait_until="networkidle", timeout=timeout_ms)
        html = page.content()
        browser.close()
    return html, sorted(requests)


def _host_in_scope(host: str, apex: str) -> bool:
    h = (host or "").lower()
    if not h:
        return False
    if is_ip_hostname is not None and is_ip_hostname(apex):
        return h == apex
    if h == apex:
        return True
    return h.endswith("." + apex)


def _priority_score(url: str, *, host_seen: set, pattern_seen_count: int) -> float:
    """
    Higher score => expanded earlier.
    """
    try:
        p = urlparse(url)
    except Exception:
        return 0.0
    host = (p.hostname or "").lower()
    scheme = (p.scheme or "").lower()
    score = 0.0

    # New hosts/subdomains are high-value pivots.
    if host and host not in host_seen:
        score += 120.0
    if is_ip_hostname is not None and host and is_ip_hostname(host) and host not in host_seen:
        score += 80.0

    # Prefer HTTPS slightly when both exist.
    if scheme == "https":
        score += 8.0

    # Penalize query-heavy URLs (often infinite).
    if query_param_count is not None:
        qn = query_param_count(url)
        if qn:
            score -= 18.0 + min(60.0, qn * 10.0)
    if p.query:
        score -= min(30.0, max(0, len(p.query) - 24) / 16.0)

    # Penalize repeated patterns (/item/{int} etc).
    score -= min(80.0, pattern_seen_count * 8.0)
    return score


def crawl(
    start_urls,
    apex,
    *,
    max_requests: int = 120,
    max_nodes: int = 2500,
    max_time_s: float = 25.0,
    max_depth: Optional[int] = None,
    max_per_pattern: int = 30,
    timeout: int = 8,
    js_config=None,
    seed_queries=None,
    rate_limit_s: float = 0.3,
    headless: bool = False,
    remove_tracking: bool = True,
):
    if canonical_url is None:
        raise RuntimeError("canonical_url helper not available (import failed)")

    started = time.time()
    stop_reason = ""

    visited = set()  # canonical URLs fetched
    enqueued = set()
    discovered = {}  # canonical_url -> {depth,parent,score,kind}
    edges = set()  # (src,tgt)

    host_seen = set()
    pattern_counts = defaultdict(int)
    suppressed_by_pattern = defaultdict(int)

    pages = set()
    api = set()
    feeds = set()
    assets = set()
    routes = set()
    js_files = set()
    query_urls = set()
    network_requests = set()
    subdomains = set()
    directories_by_host = defaultdict(set)

    requests_made = 0
    max_depth_reached = 0

    frontier = []
    seq = 0

    def budget_hit() -> bool:
        nonlocal stop_reason
        if max_time_s is not None and max_time_s > 0 and (time.time() - started) >= float(max_time_s):
            stop_reason = "maxTime"
            return True
        if max_requests is not None and max_requests > 0 and requests_made >= int(max_requests):
            stop_reason = "maxRequests"
            return True
        if max_nodes is not None and max_nodes > 0 and len(discovered) >= int(max_nodes):
            stop_reason = "maxNodes"
            return True
        return False

    def add_discovered(child_url: str, *, parent_url: Optional[str], depth: int, kind: str, from_frontier: bool):
        nonlocal seq, max_depth_reached
        if not child_url:
            return
        if child_url in discovered:
            return
        if budget_hit():
            return

        host = ""
        try:
            host = (urlparse(child_url).hostname or "").lower()
        except Exception:
            host = ""

        pattern = url_pattern_key(child_url) if url_pattern_key is not None else child_url
        if max_per_pattern and pattern:
            if pattern_counts[pattern] >= max_per_pattern:
                suppressed_by_pattern[pattern] += 1
                return
            pattern_counts[pattern] += 1

        pattern_seen = max(0, int(pattern_counts.get(pattern, 0)) - 1)
        score = _priority_score(child_url, host_seen=host_seen, pattern_seen_count=pattern_seen)
        discovered[child_url] = {
            "url": child_url,
            "depth": depth,
            "parent": parent_url,
            "score": score,
            "kind": kind,
        }
        if depth > max_depth_reached:
            max_depth_reached = depth

        if host:
            host_seen.add(host)
            if _host_in_scope(host, apex) and host != apex:
                subdomains.add(host)

        if parent_url:
            edges.add((parent_url, child_url))

        # Only enqueue "page-like" URLs for fetching.
        if not from_frontier:
            return
        if max_depth is not None and depth > max_depth:
            return
        if kind not in ("page", "api"):
            return
        if child_url in visited or child_url in enqueued:
            return
        # query-heavy URLs are recorded but expanded later; keep them in frontier with low score.
        prio = (-score, depth, seq)
        seq += 1
        heapq.heappush(frontier, (prio, child_url))
        enqueued.add(child_url)

    # seed start URLs
    for raw in start_urls:
        cu = canonical_url(raw, raw, remove_tracking=remove_tracking)
        if not cu:
            continue
        try:
            host = (urlparse(cu).hostname or "").lower()
        except Exception:
            host = ""
        if host and not _host_in_scope(host, apex):
            continue
        add_discovered(cu, parent_url=None, depth=0, kind="page", from_frontier=True)

    while frontier:
        if budget_hit():
            break
        if requests is None:
            stop_reason = "missingRequestsLib"
            break

        _, url = heapq.heappop(frontier)
        enqueued.discard(url)
        if url in visited:
            continue

        visited.add(url)
        requests_made += 1

        try:
            r = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout, allow_redirects=True)
        except Exception:
            continue

        # Post-redirect canonicalization
        effective_url = canonical_url(r.url or url, url, remove_tracking=remove_tracking) if r else url
        if effective_url and effective_url != url and effective_url not in discovered:
            # same-depth alias, keep parent chain consistent
            cur = discovered.get(url) or {}
            add_discovered(effective_url, parent_url=cur.get("parent"), depth=cur.get("depth", 0), kind=cur.get("kind", "page"), from_frontier=False)

        ct = r.headers.get("Content-Type", "") if r and r.headers else ""
        if not r or r.status_code >= 400:
            continue
        if "text/html" not in ct.lower() and "<html" not in (r.text or "").lower():
            continue

        html = r.text or ""
        base_url = r.url or url

        # Track this page (canonical)
        pages.add(effective_url or url)

        links = extract_links(html, base_url)

        # Seeded query variants are *recorded* but not expanded.
        if seed_queries:
            for qurl in build_query_urls(base_url, seed_queries):
                cq = canonical_url(qurl, base_url, remove_tracking=remove_tracking)
                if not cq:
                    continue
                query_urls.add(cq)
                pages.add(cq)

        # inline JSON search targets (from known app patterns)
        for target in extract_search_targets(html):
            candidate = absolute_url(base_url, target)
            if is_http_url(candidate):
                links.add(candidate)

        # JS route discovery can yield valuable API and route endpoints.
        if js_config is not None and discover_js_routes is not None:
            try:
                js_result, scripts = discover_js_routes(html, base_url, js_config, DEFAULT_HEADERS)
                js_files.update(scripts or [])
                for u in js_result.get("routes", []) or []:
                    routes.add(u)
                for u in js_result.get("api", []) or []:
                    api.add(u)
                for u in js_result.get("feeds", []) or []:
                    feeds.add(u)
                for u in js_result.get("assets", []) or []:
                    assets.add(u)
            except Exception:
                pass

        if headless:
            h_html, h_requests = headless_discover(base_url)
            if h_html:
                try:
                    links.update(extract_links(h_html, base_url))
                except Exception:
                    pass
            for req in h_requests or []:
                network_requests.add(req)

        parent_canonical = canonical_url(base_url, base_url, remove_tracking=remove_tracking) or (effective_url or url)
        parent_depth = int(discovered.get(parent_canonical, discovered.get(url, {})).get("depth", 0))

        for link in links:
            cu = canonical_url(link, base_url, remove_tracking=remove_tracking)
            if not cu:
                continue
            try:
                p = urlparse(cu)
            except Exception:
                continue
            host = (p.hostname or "").lower()
            if not host or not _host_in_scope(host, apex):
                continue

            kind = classify_url(cu) if classify_url is not None else "page"

            if kind == "asset":
                assets.add(cu)
            elif kind == "feed":
                feeds.add(cu)
            elif kind == "api":
                api.add(cu)
            else:
                pages.add(cu)

            # directory hints per host
            if kind in ("page", "api") and p.path:
                segs = [s for s in p.path.split("/") if s]
                if segs:
                    directories_by_host[host].add("/" + segs[0])

            depth = parent_depth + 1
            add_discovered(cu, parent_url=parent_canonical, depth=depth, kind=kind, from_frontier=True)

        if rate_limit_s:
            try:
                time.sleep(max(0.0, float(rate_limit_s)))
            except Exception:
                pass

    if not stop_reason:
        stop_reason = "frontierEmpty" if not frontier else "stopped"

    # serialize sets
    dirs_serialized = {h: sorted(list(vs)) for h, vs in directories_by_host.items()}
    pages_clean = sorted({normalize_existing(u) for u in pages.union(routes) if normalize_existing(u)})
    api_clean = sorted({normalize_existing(u) for u in api if normalize_existing(u)})
    feeds_clean = sorted({normalize_existing(u) for u in feeds if normalize_existing(u)})
    assets_clean = sorted({normalize_existing(u) for u in assets if normalize_existing(u)})
    routes_clean = sorted({normalize_existing(u) for u in routes if normalize_existing(u)})

    nodes_out = list(discovered.values())
    nodes_out.sort(key=lambda n: (n.get("depth", 0), -(n.get("score", 0.0)), n.get("url", "")))
    edges_out = [{"source": s, "target": t, "type": "discovered"} for (s, t) in sorted(edges)]

    return {
        "budgets": {
            "maxRequests": max_requests,
            "maxTime": max_time_s,
            "maxNodes": max_nodes,
            "maxDepth": max_depth,
            "maxPerPattern": max_per_pattern,
        },
        "stats": {
            "requests_made": requests_made,
            "nodes_discovered": len(discovered),
            "nodes_fetched": len(visited),
            "frontier_remaining": len(frontier),
            "max_depth_reached": max_depth_reached,
            "stop_reason": stop_reason,
            "patterns_suppressed_total": int(sum(suppressed_by_pattern.values())),
        },
        "discovered": {
            "subdomains": sorted(list(subdomains)),
            "directories_by_host": dirs_serialized,
            "urls": pages_clean,
            "pages": pages_clean,
            "api": api_clean,
            "feeds": feeds_clean,
            "assets": assets_clean,
            "routes": routes_clean,
            "js_files": sorted(list(js_files)),
            "requests": sorted(list(network_requests)),
            "query_urls": sorted(list(query_urls)),
        },
        "crawl_graph": {"nodes": nodes_out, "edges": edges_out},
    }


def main():
    parser = argparse.ArgumentParser(description="Crawl HTML and extract links and JS routes")
    parser.add_argument("target")
    # Backwards compatible positionals:
    # - max_pages historically capped the number of fetched pages; treat as max_requests now
    # - depth remains optional; default is unlimited (budgeted)
    parser.add_argument("max_pages", nargs="?", type=int, default=None)
    parser.add_argument("depth", nargs="?", type=int, default=None)
    parser.add_argument("--max-requests", type=int, default=120, help="Max HTTP requests (fetches)")
    parser.add_argument("--max-nodes", type=int, default=2500, help="Max unique URLs tracked")
    parser.add_argument("--max-time-s", type=float, default=25.0, help="Max crawl time in seconds")
    parser.add_argument("--max-per-pattern", type=int, default=30, help="Max URLs per normalized pattern")
    parser.add_argument("--keep-tracking", action="store_true", help="Keep tracking query params (utm_*, gclid, ...)")
    parser.add_argument("--max-js", type=int, default=5, help="Max JS files to analyze")
    parser.add_argument("--max-js-size-kb", type=int, default=512, help="Max JS size in KB")
    parser.add_argument("--js-whitelist", default="", help="Regex whitelist for JS URLs")
    parser.add_argument("--js-blacklist", default="", help="Regex blacklist for JS URLs")
    parser.add_argument("--seed-queries", default="sql,cve-2024,rce,wordpress", help="Comma-separated seed queries")
    parser.add_argument("--rate-limit-ms", type=int, default=300, help="Delay between requests")
    parser.add_argument("--headless", action="store_true", help="Enable headless render discovery (Playwright)")
    args = parser.parse_args()

    target = args.target
    max_depth = args.depth if (args.depth is not None and args.depth >= 0) else None
    max_requests = args.max_requests
    if args.max_pages is not None and args.max_pages > 0:
        max_requests = args.max_pages
    seed_queries = [s.strip() for s in (args.seed_queries or "").split(",") if s.strip()]
    rate_limit_s = max(0.0, args.rate_limit_ms / 1000.0)

    # Build start URLs for http/https if scheme missing
    parsed = urlparse(target)
    if parsed.scheme:
        start = [target]
        host = parsed.hostname or target
    else:
        host = target
        start = [f"https://{host}", f"http://{host}"]

    apex = apex_of(host)

    result = {
        "target": host,
        "apex": apex,
        "start": start,
    }

    js_config = None
    if JsDiscoveryConfig is not None:
        js_config = JsDiscoveryConfig(
            max_js_files=args.max_js,
            max_js_kb=args.max_js_size_kb,
            whitelist=args.js_whitelist,
            blacklist=args.js_blacklist,
            rate_limit_s=rate_limit_s
        )
    data = crawl(
        start,
        apex,
        max_requests=max_requests,
        max_nodes=args.max_nodes,
        max_time_s=args.max_time_s,
        max_depth=max_depth,
        max_per_pattern=args.max_per_pattern,
        js_config=js_config,
        seed_queries=seed_queries,
        rate_limit_s=rate_limit_s,
        headless=args.headless,
        remove_tracking=(not args.keep_tracking),
    )
    result.update(data)

    label = clean_label(host)
    out_path = RESULTS_DIR / f"html_links_{label}.json"
    pretty = json.dumps(result, indent=2)
    print(pretty)
    out_path.write_text(pretty)
    print(f"wrote: {out_path}")


if __name__ == "__main__":
    main()
