import os
import sys
import json
import re
import subprocess
import time
import argparse
import sqlite3
from datetime import datetime
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

# Orchestrator: run ffuf_subs, then per-subdomain dirsearch/whatweb/webanalyze,
# then nmap on root and whatweb/webanalyze on root as well.

PROJECT_ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = PROJECT_ROOT / "recon"
RESULTS_DIR = PROJECT_ROOT / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = PROJECT_ROOT / "server" / "data.db"
CURRENT_SCAN_ID = None

def write_file(fname, content):
    p = RESULTS_DIR / fname
    p.write_text(content or "")
    return str(p)

def _utc_now_iso():
    return datetime.utcnow().isoformat(timespec='seconds') + 'Z'

def _ensure_website_row(db, website_url: str):
    cur = db.cursor()
    cur.execute('SELECT id FROM websites WHERE url = ? LIMIT 1', (website_url,))
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute('INSERT INTO websites (url, name) VALUES (?, ?)', (website_url, website_url))
    return cur.lastrowid

def record_scan_timestamp(website_url: str, started: bool = False, finished: bool = False, scan_id: str = None):
    if not website_url:
        return None
    ts = _utc_now_iso()
    try:
        if not DB_PATH.exists():
            print(f"[run_all] WARNING: DB not found at {DB_PATH}; skipping scan timestamp")
            return None
        db = sqlite3.connect(str(DB_PATH))
        cur = db.cursor()
        cur.execute("PRAGMA table_info('websites')")
        cols = [c[1] for c in cur.fetchall()] if cur else []
        if 'scan_started_at' not in cols or 'scan_finished_at' not in cols:
            print("[run_all] WARNING: websites scan timestamp columns missing; skipping timestamp update")
            db.close()
            return None
        # ensure scans table exists
        db.execute("""CREATE TABLE IF NOT EXISTS scans (
            scan_id TEXT PRIMARY KEY,
            website_id INTEGER,
            target TEXT,
            started_at TEXT,
            finished_at TEXT,
            status TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        _ensure_website_row(db, website_url)
        website_id = _ensure_website_row(db, website_url)
        if started:
            db.execute('UPDATE websites SET scan_started_at = ? WHERE url = ?', (ts, website_url))
            if scan_id:
                db.execute(
                    'INSERT OR REPLACE INTO scans (scan_id, website_id, target, started_at, status) VALUES (?, ?, ?, ?, ?)',
                    (scan_id, website_id, website_url, ts, 'running')
                )
            print(f"[run_all] Scan started at {ts}")
        if finished:
            db.execute('UPDATE websites SET scan_finished_at = ? WHERE url = ?', (ts, website_url))
            if scan_id:
                db.execute(
                    'UPDATE scans SET finished_at = ?, status = ? WHERE scan_id = ?',
                    (ts, 'completed', scan_id)
                )
            print(f"[run_all] Scan finished at {ts}")
        db.commit()
        db.close()
        return ts
    except Exception as e:
        print(f"[run_all] WARNING: failed to record scan timestamp: {e}")
        return None

def reset_website_graph(website_url: str):
    """Clear existing nodes/relationships for a website so each scan starts fresh."""
    if not website_url:
        return
    try:
        if not DB_PATH.exists():
            return
        db = sqlite3.connect(str(DB_PATH))
        try:
            website_id = _ensure_website_row(db, website_url)
            # Best-effort cleanup; schema may vary between versions.
            db.execute(
                'DELETE FROM node_relationships WHERE source_node_id IN (SELECT id FROM nodes WHERE website_id = ?) OR target_node_id IN (SELECT id FROM nodes WHERE website_id = ?)',
                (website_id, website_id),
            )
            db.execute('DELETE FROM node_headers WHERE node_id IN (SELECT id FROM nodes WHERE website_id = ?)', (website_id,))
            db.execute('DELETE FROM node_technologies WHERE node_id IN (SELECT id FROM nodes WHERE website_id = ?)', (website_id,))
            db.execute('DELETE FROM node_vulnerabilities WHERE node_id IN (SELECT id FROM nodes WHERE website_id = ?)', (website_id,))
            db.execute('DELETE FROM nodes WHERE website_id = ?', (website_id,))
            db.commit()
            print(f"[run_all] Cleared previous graph for website_id={website_id} ({website_url})")
        finally:
            db.close()
    except Exception as e:
        print(f"[run_all] WARNING: failed to reset website graph: {e}")

def try_import_and_run(script_path: Path, target, *args, **kwargs):
    """Try to import the module as recon.<name> and call run(target, *args, **kwargs).
    Returns (ok: bool, output: str).
    """
    try:
        # Ensure project root is on sys.path so imports like recon.xxx work
        if str(PROJECT_ROOT) not in sys.path:
            sys.path.insert(0, str(PROJECT_ROOT))

        mod_name = f"recon.{script_path.stem}"
        mod = __import__(mod_name, fromlist=["run"])  # may fail if recon isn't a package
        run_func = getattr(mod, "run", None)
        if not callable(run_func):
            return False, ""
        res = run_func(target, *args, **kwargs)
        if isinstance(res, (bytes, bytearray)):
            res = res.decode(errors="replace")
        elif res is None:
            res = ""
        else:
            res = str(res)
        return True, res
    except Exception:
        return False, ""

def run_subprocess_script(script_path: Path, target, extra_args=None, env_extra=None, timeout=None):
    cmd = [sys.executable, str(script_path), target]
    if extra_args:
        cmd += list(extra_args)
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    # Ensure project root is importable for recon.* imports when running scripts by path.
    try:
        existing = env.get("PYTHONPATH") or ""
        root = str(PROJECT_ROOT)
        if existing:
            parts = existing.split(os.pathsep)
            if root not in parts:
                env["PYTHONPATH"] = root + os.pathsep + existing
        else:
            env["PYTHONPATH"] = root
    except Exception:
        pass
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
        out = p.stdout
        if p.stderr:
            out += "\nSTDERR:\n" + p.stderr
        return True, out
    except subprocess.TimeoutExpired as te:
        return False, f"TIMEOUT: {te}"
    except Exception as e:
        return False, f"SUBPROCESS ERROR: {e}"

def run_python_script(script_path: Path, args=None, env_extra=None, timeout=None):
    cmd = [sys.executable, str(script_path)]
    if args:
        cmd += list(args)
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    # Ensure project root is importable for recon.* imports when running scripts by path.
    try:
        existing = env.get("PYTHONPATH") or ""
        root = str(PROJECT_ROOT)
        if existing:
            parts = existing.split(os.pathsep)
            if root not in parts:
                env["PYTHONPATH"] = root + os.pathsep + existing
        else:
            env["PYTHONPATH"] = root
    except Exception:
        pass
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
        out = p.stdout
        if p.stderr:
            out += "\nSTDERR:\n" + p.stderr
        return True, out
    except subprocess.TimeoutExpired as te:
        return False, f"TIMEOUT: {te}"
    except Exception as e:
        return False, f"SUBPROCESS ERROR: {e}"

def run_node_script(script_path: Path, args=None, timeout=None):
    cmd = ["node", str(script_path)]
    if args:
        cmd += list(args)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = p.stdout
        if p.stderr:
            out += "\nSTDERR:\n" + p.stderr
        return True, out
    except subprocess.TimeoutExpired as te:
        return False, f"TIMEOUT: {te}"
    except Exception as e:
        return False, f"SUBPROCESS ERROR: {e}"

def extract_subdomains_from_ffuf_json(ffuf_file_text: str, domain: str):
    subs = set()
    try:
        data = json.loads(ffuf_file_text)
        results = data.get("results") if isinstance(data, dict) else None
        if results and isinstance(results, list):
            for item in results:
                if not isinstance(item, dict):
                    continue
                # prefer host field
                host = item.get("host")
                if host:
                    subs.add(str(host).lower().strip("."))
                    continue
                # try url or input
                for key in ("url", "uri", "input"):
                    val = item.get(key)
                    if not val:
                        continue
                    m = re.search(r"https?://([^/]+)", str(val))
                    if m:
                        subs.add(m.group(1).lower().strip("."))
                    else:
                        subs.add(str(val).lower().strip("."))
    except Exception:
        pass

    if not subs:
        pattern = re.compile(r"https?://([a-zA-Z0-9\-_\.]*" + re.escape(domain) + r")", re.IGNORECASE)
        for m in pattern.finditer(ffuf_file_text):
            subs.add(m.group(1).lower().strip("."))

    cleaned = sorted({s for s in subs if s and domain.lower() in s.lower()})
    return cleaned

def locate_ffuf_output(domain: str):
    expected = RESULTS_DIR / f"ffuf_subs_{domain.replace('.', '_')}.json"
    if expected.exists():
        return expected
    matches = list(RESULTS_DIR.glob(f"ffuf_subs_{domain.replace('.', '_')}*.json"))
    return matches[0] if matches else None

def locate_html_links_output():
    matches = list(RESULTS_DIR.glob("html_links_*.json"))
    if not matches:
        return None
    try:
        matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    except Exception:
        pass
    return matches[0]

def run_tool(tool_name: str, target: str, timeout=None, extra_args=None, filename_label: str = None):
    # Support multiple possible locations for tools:
    # 1) recon/<tool>.py
    # 2) recon/<tool>/<tool>.py (some tools installed in subdir)
    # 3) aliases (e.g. nmap -> nmap_http.py)
    possible_paths = []
    possible_paths.append(SCRIPTS_DIR / f"{tool_name}.py")
    possible_paths.append(SCRIPTS_DIR / tool_name / f"{tool_name}.py")
    # alias mapping
    aliases = {"nmap": "nmap_http.py"}
    if tool_name in aliases:
        possible_paths.append(SCRIPTS_DIR / aliases[tool_name])

    # pick first existing script
    script_path = None
    for p in possible_paths:
        if p.exists():
            script_path = p
            break
    if script_path is None:
        out_fname = f"{tool_name}_{target.replace('/', '_').replace(':','')}.txt"
        write_file(out_fname, f"ERROR: tool {tool_name} not found in recon/\nSearched: {possible_paths}")
        return False, out_fname
    def _sanitize_label(s: str) -> str:
        # keep hostname-like labels compact: replace scheme and non-safe chars
        import re
        # if target looks like a URL, extract hostname
        m = re.search(r"https?://([^/]+)", s)
        if m:
            lbl = m.group(1)
        else:
            lbl = s
        # fallback to provided filename_label if present
        if filename_label:
            lbl = filename_label
        # replace any chars other than alnum, dot, dash, underscore with underscore
        lbl = re.sub(r"[^A-Za-z0-9._-]", "_", lbl)
        return lbl

    # always sanitize target for filenames and URL construction
    clean_target = sanitize_target(target)
    label = _sanitize_label(clean_target)
    out_fname = f"{tool_name}_{label}.json"

    # Prepare execution arguments. For dirsearch we need to pass '-u http://<target>' and
    # prefer running it as a subprocess (dirsearch CLI expects '-u').
    exec_args = list(extra_args) if extra_args else []
    if tool_name == "dirsearch" and not exec_args:
        exec_args = ["-u", f"http://{clean_target}"]

    # If tool is dirsearch, skip attempting to import and run (it expects CLI args)
    if tool_name == "dirsearch":
        ok, out = run_subprocess_script(script_path, clean_target, extra_args=exec_args, env_extra={"RESULTS_DIR": str(RESULTS_DIR)}, timeout=timeout)
        # dirsearch is instructed to write its own JSON output via -o; if it didn't, wrap stdout
        output_path = RESULTS_DIR / out_fname
        if not ok and (RESULTS_DIR / f"dirsearch_{label}.json").exists():
            # prefer dirsearch's own file
            return True, f"dirsearch_{label}.json"
        if out is None:
            out = ""
        write_file(out_fname, out)
        return ok, out_fname

    # Try import & run for other tools
    # For import-run tools, pass sanitized target
    ok, out = try_import_and_run(script_path, clean_target, *(exec_args or []), timeout=timeout)
    if ok:
        write_file(out_fname, out)
        return True, out_fname

    # Fallback to subprocess for non-dirsearch tools
    ok, out = run_subprocess_script(script_path, clean_target, extra_args=exec_args, env_extra={"RESULTS_DIR": str(RESULTS_DIR)}, timeout=timeout)
    # If the tool doesn't natively write JSON, wrap its stdout/stderr into a small JSON object
    if out is None:
        out = ""
    # If tool appears to have already written a JSON file (e.g., whatweb/webanalyze may produce .json), prefer that
    possible_json = RESULTS_DIR / out_fname
    if possible_json.exists() and possible_json.stat().st_size > 0:
        return True, out_fname
    # otherwise, write a JSON wrapper
    wrapper = json.dumps({"tool": tool_name, "target": clean_target, "output": out})
    write_file(out_fname, wrapper)
    return ok, out_fname


def detect_schemes_fast(target: str, timeout=None):
    """Fast TCP connect probe for ports 80 and 443. Returns ['http','https'] as detected."""
    import socket

    schemes = []
    host = target
    # if target is a URL, extract hostname
    m = re.search(r"https?://([^/]+)", target)
    if m:
        host = m.group(1)

    def probe(port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except Exception:
            return False

    if probe(80):
        schemes.append('http')
    if probe(443):
        schemes.append('https')
    return schemes

def sanitize_target(target: str) -> str:
    """Normalize a target into a safe host[:port] string for filenames and tool args."""
    if not target:
        return target
    t = target.strip()
    try:
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", t):
            t = "http://" + t
        parsed = urlparse(t)
        host = (parsed.hostname or "").lower()
        if not host:
            raise ValueError("no host")
        port = f":{parsed.port}" if parsed.port else ""
        safe = f"{host}{port}"
    except Exception:
        safe = re.sub(r"[^A-Za-z0-9._:-]", "_", t.lower())
    return safe

def normalize_base_url(raw: str):
    try:
        parsed = urlparse(raw.strip())
        if not parsed.scheme or not parsed.hostname:
            return None
        host = parsed.hostname.lower()
        scheme = parsed.scheme.lower()
        port = parsed.port
        if port is None:
            port = 443 if scheme == "https" else 80
        return f"{scheme}://{host}:{port}"
    except Exception:
        return None

def build_nuclei_targets(domain: str, subdomains, discovered_urls=None):
    targets = set()
    hosts = set([sanitize_target(domain)])
    hosts.update([sanitize_target(s) for s in (subdomains or []) if s])

    for host in hosts:
        if not host:
            continue
        targets.add(f"http://{host}:80")
        targets.add(f"https://{host}:443")

    for raw in (discovered_urls or []):
        base = normalize_base_url(raw)
        if base:
            targets.add(base)

    return sorted(targets)

SUBDOMAIN_TIMEOUT_MS = 50_000
MAX_DIR_RESULTS = 300

def count_dirsearch_results(path: Path) -> int:
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return len(data.get("results"))
        if isinstance(data, list):
            return len(data)
    except Exception:
        return 0
    return 0

def main():
    parser = argparse.ArgumentParser(description="Orchestrate web recon: ffuf_subs -> dirsearch -> simple_fingerprint -> nmap")
    parser.add_argument("domain", help="Target root domain (example.com)")
    parser.add_argument("--ffuf-max", type=int, default=50, help="Max runtime (s) to give ffuf_subs when importing/running")
    parser.add_argument("--workers", type=int, default=6, help="Number of concurrent workers for per-subdomain tasks")
    parser.add_argument("--disable-nmap-vuln", action="store_true", help="Disable nmap vuln/vulners NSE scan")
    parser.add_argument("--nmap-vuln-mincvss", type=float, default=7.0, help="Minimum CVSS for vulners script")
    parser.add_argument("--disable-nuclei", action="store_true", help="Disable nuclei web vuln scan")
    parser.add_argument("--nuclei-severities", default="medium,high,critical", help="Comma-separated nuclei severities to include")
    parser.add_argument("--nuclei-templates", default="", help="Optional nuclei templates path (e.g., cves/)")
    parser.add_argument("--nuclei-update-templates", action="store_true", help="Update nuclei templates before scanning")
    args = parser.parse_args()

    domain = args.domain.rstrip("/")
    ffuf_max = min(int(args.ffuf_max), int(SUBDOMAIN_TIMEOUT_MS / 1000))
    workers = max(1, int(args.workers))
    do_nmap_vuln = not args.disable_nmap_vuln
    do_nuclei = not args.disable_nuclei
    nmap_vuln_mincvss = args.nmap_vuln_mincvss
    nuclei_severities = args.nuclei_severities
    nuclei_templates = args.nuclei_templates.strip() or None
    nuclei_update = args.nuclei_update_templates

    global CURRENT_SCAN_ID
    CURRENT_SCAN_ID = f"{domain}-{uuid.uuid4()}"
    record_scan_timestamp(domain, started=True, scan_id=CURRENT_SCAN_ID)
    try:
        # Always start with a clean results directory to avoid stale outputs between runs
        try:
            import shutil
            if RESULTS_DIR.exists():
                print(f"[run_all] Cleaning previous results under {RESULTS_DIR} ...")
                shutil.rmtree(RESULTS_DIR, ignore_errors=True)
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"[run_all] WARNING: failed to fully clean results dir: {e}")

        # Clear DB graph for this website so UI matches the current scan.
        reset_website_graph(domain)

        print("[stage] start start", flush=True)
        # Run ffuf_subs (prefer import)
        ffuf_script = SCRIPTS_DIR / "ffuf_subs.py"
        print("[stage] start done", flush=True)
        print("[stage] subdomains start", flush=True)
        if ffuf_script.exists():
            ok, out = try_import_and_run(ffuf_script, domain, max_time=ffuf_max)
            if ok:
                # write output if ffuf returned raw JSON
                ffuf_out = locate_ffuf_output(domain)
                if not ffuf_out:
                    write_file(f"ffuf_subs_{domain.replace('.', '_')}.json", out)
            else:
                # run as subprocess
                run_subprocess_script(ffuf_script, domain, extra_args=[str(ffuf_max)], env_extra={"RESULTS_DIR": str(RESULTS_DIR)}, timeout=ffuf_max)
        else:
            print("[run_all] ffuf_subs.py not found in recon/ - aborting")
            sys.exit(2)
        print("[stage] subdomains done", flush=True)

        ffuf_outpath = locate_ffuf_output(domain)
        if not ffuf_outpath:
            print("[run_all] ffuf output not found; ensure ffuf ran and wrote results to results/ffuf_subs_<domain>.json")
            sys.exit(2)

        ffuf_text = ffuf_outpath.read_text()
        subdomains = extract_subdomains_from_ffuf_json(ffuf_text, domain)
        if not subdomains:
            print("[run_all] No subdomains discovered.")
        else:
            print(f"[run_all] Found {len(subdomains)} subdomains. Running per-subdomain scans...")

        discovered_urls = []
        # Optional: augment subdomains by crawling root homepage for linked subdomains
        print("[stage] html_links start", flush=True)
        try:
            ok, html_json_fname = run_tool("html_link_discovery", domain)
            print(f"[run_all] html_link_discovery(root) -> {html_json_fname} (ok={ok})")
            try:
                # html_link_discovery writes its canonical output as results/html_links_<label>.json.
                # run_tool may return a wrapper filename; always prefer the real html_links file.
                actual_html_path = locate_html_links_output()
                if not actual_html_path or not actual_html_path.exists():
                    raise ValueError('could not locate html_links_*.json output from html_link_discovery')
                data = json.loads(actual_html_path.read_text())
                if not (isinstance(data, dict) and data.get('discovered')):
                    raise ValueError('html_links output missing discovered payload')

                linked_subs = [s for s in data.get("discovered", {}).get("subdomains", []) if s.endswith(domain)]
                # Show discovered URLs from the website to help verify crawling
                discovered_urls = data.get("discovered", {}).get("urls", []) or []
                if discovered_urls:
                    print(f"[run_all] Discovered {len(discovered_urls)} URLs from HTML crawling:")
                    # Print a limited preview to keep logs readable
                    preview_count = min(30, len(discovered_urls))
                    for u in discovered_urls[:preview_count]:
                        print(f"    - {u}")
                    if len(discovered_urls) > preview_count:
                        print(f"    ... and {len(discovered_urls) - preview_count} more")
                if linked_subs:
                    before = set(subdomains)
                    subdomains = sorted(list(before.union(linked_subs)))
                    print(f"[run_all] Added {len(set(linked_subs)-before)} subdomains from HTML links")
                # Import discovered endpoints/directories into the database for visualization
                try:
                    importer = PROJECT_ROOT / 'recon' / 'import_html_links.py'
                    if importer.exists():
                        # Use website URL equal to the domain string (frontend expects this mapping)
                        imp_arg = str(actual_html_path)
                        ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[imp_arg])
                        print(f"[run_all] import_html_links -> {out_imp[:180]}...")
                        # Also produce a hierarchical visualization JSON for the frontend
                        try:
                            viz_script = PROJECT_ROOT / 'scripts' / 'build_hierarchical_json.py'
                            if viz_script.exists():
                                viz_out = RESULTS_DIR / 'clean' / f"{domain}_viz.json"
                                ok_viz, out_viz = run_subprocess_script(viz_script, imp_arg, extra_args=[str(viz_out)])
                                msg = out_viz if isinstance(out_viz, str) else str(out_viz)
                                print(f"[run_all] build_hierarchical_json -> {msg[:180]}...")
                            else:
                                print("[run_all] build_hierarchical_json.py not found; skipping viz JSON generation")
                        except Exception as viz_err:
                            print(f"[run_all] build_hierarchical_json error: {viz_err}")
                    else:
                        print("[run_all] import_html_links.py not found; skip DB import of discovered URLs")
                except Exception as imp_err:
                    print(f"[run_all] import_html_links error: {imp_err}")
            except Exception as e:
                print(f"[run_all] failed to read html_link_discovery output: {e}")
        except Exception as e:
            print(f"[run_all] html_link_discovery error: {e}")
        print("[stage] html_links done", flush=True)

        js_script = SCRIPTS_DIR / "js_route_discovery.py"
        print("[stage] js_routes start", flush=True)
        if js_script.exists():
            ok_js, out_js = run_tool("js_route_discovery", domain)
            print(f"[run_all] js_route_discovery -> {out_js[:180]}...")
        else:
            print("[run_all] js_route_discovery.py not found; skipping")
        print("[stage] js_routes done", flush=True)

        # Process per-subdomain work in parallel to speed up large lists.
        def process_subdomain(sd: str):
            """Run dirsearch and simple_fingerprint for a single subdomain."""
            try:
                print(f"[run_all] Processing {sd}")
                clean_sd = sanitize_target(sd)

                # dirsearch: prefer it to write its own JSON file
                output_path = RESULTS_DIR / f"dirsearch_{clean_sd}.json"
                extra_args = ["-u", f"http://{clean_sd}", "-o", str(output_path), "--format=json"]
                ok, fname = run_tool("dirsearch", sd, extra_args=extra_args)
                if output_path.exists() and output_path.stat().st_size > 0:
                    try:
                        _ = json.loads(output_path.read_text())
                        ok = True
                        fname = output_path.name
                    except Exception:
                        pass
                timed_out = False
                if not ok and fname and "TIMEOUT" in str(fname):
                    timed_out = True
                if not ok and output_path.exists():
                    timed_out = True
                capped = False
                if output_path.exists():
                    found_count = count_dirsearch_results(output_path)
                    if found_count >= MAX_DIR_RESULTS:
                        capped = True
                print(f"  dirsearch -> {fname} (ok={ok})")

                # Import dirsearch results into the DB for visualization if available
                try:
                    if ok and fname:
                        dir_json = RESULTS_DIR / fname
                        if dir_json.exists() and dir_json.stat().st_size > 0:
                            importer = PROJECT_ROOT / 'recon' / 'import_dirsearch.py'
                            if importer.exists():
                                ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[clean_sd, str(dir_json)])
                                # Trim output to reasonable length in logs
                                msg = out_imp if isinstance(out_imp, str) else str(out_imp)
                                print(f"  import_dirsearch -> {msg[:180]}...")
                            else:
                                print("  import_dirsearch.py not found; skipping DB import for dirsearch")
                except Exception as imp_e:
                    print(f"  import_dirsearch error: {imp_e}")

                # Fast scheme detection (short timeout) - fallback to both
                schemes = detect_schemes_fast(sd)
                if not schemes:
                    schemes = ['http', 'https']
                print(f"  Detected schemes for {sd}: {schemes}")

                # run simple_fingerprint for this subdomain (it handles http/https itself)
                ok2, fname2 = run_tool("simple_fingerprint", clean_sd)
                print(f"  simple_fingerprint -> {fname2} (ok={ok2})")
                # Import fingerprint metadata (headers/tech/ip) into DB
                try:
                    importer = PROJECT_ROOT / 'recon' / 'import_simple_fingerprint.py'
                    fp_path = RESULTS_DIR / str(fname2)
                    if importer.exists() and fp_path.exists():
                        ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[str(fp_path)])
                        msg = out_imp if isinstance(out_imp, str) else str(out_imp)
                        print(f"  import_simple_fingerprint -> {msg[:180]}...")
                except Exception as imp_e:
                    print(f"  import_simple_fingerprint error: {imp_e}")

                return {"subdomain": sd, "dirsearch": (ok, fname), "fingerprint": (ok2, fname2), "dir_timed_out": timed_out, "dir_capped": capped}
            except Exception as e:
                return {"subdomain": sd, "error": str(e)}

        # Run per-subdomain tasks with a ThreadPoolExecutor
        print("[stage] dirs start", flush=True)
        start = time.time()
        results = []
        dir_timeouts = 0
        dir_capped = 0
        if subdomains:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                futures = {ex.submit(process_subdomain, sd): sd for sd in subdomains}
                for fut in as_completed(futures):
                    try:
                        r = fut.result()
                    except Exception as e:
                        r = {"subdomain": futures.get(fut), "error": str(e)}
                    results.append(r)
                    if r.get("dir_timed_out"):
                        dir_timeouts += 1
                    if r.get("dir_capped"):
                        dir_capped += 1
            elapsed = time.time() - start
            print(f"[run_all] Per-subdomain work completed in {elapsed:.1f}s using {workers} workers")
        if dir_timeouts:
            print("[run_all] Directories timed out (partial results saved)")
        if dir_capped:
            print(f"[run_all] Directories capped at {MAX_DIR_RESULTS} results (partial results saved)")
        print("[stage] dirs done", flush=True)

        print("[stage] fingerprint start", flush=True)
        # Run nmap on root domain (single, heavier scan)
        ok, fname = run_tool("nmap", domain)
        print(f"[run_all] nmap -> {fname} (ok={ok})")

        # Run nmap vulnerability scripts after discovery
        if do_nmap_vuln:
            nmap_vuln_script = SCRIPTS_DIR / "run_nmap_vuln.py"
            if nmap_vuln_script.exists():
                ok_v, out_v = run_subprocess_script(nmap_vuln_script, domain, extra_args=[str(nmap_vuln_mincvss), "900"])
                print(f"[run_all] nmap_vuln -> {out_v[:180]}...")
                try:
                    importer = PROJECT_ROOT / 'recon' / 'import_nmap_vuln.py'
                    clean_path = RESULTS_DIR / 'clean' / f"{sanitize_target(domain)}_nmap_vuln.json"
                    if importer.exists() and clean_path.exists():
                        ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[str(clean_path)])
                        print(f"[run_all] import_nmap_vuln -> {str(out_imp)[:180]}...")
                except Exception as imp_err:
                    print(f"[run_all] import_nmap_vuln error: {imp_err}")
            else:
                print("[run_all] run_nmap_vuln.py not found; skipping nmap vulnerability scan")

        # Run simple_fingerprint on root domain as well
        ok, fname = run_tool("simple_fingerprint", domain)
        print(f"[run_all] simple_fingerprint (root) -> {fname} (ok={ok})")
        # Import root fingerprint metadata into DB
        try:
            importer = PROJECT_ROOT / 'recon' / 'import_simple_fingerprint.py'
            fp_path = RESULTS_DIR / str(fname)
            if importer.exists() and fp_path.exists():
                ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[str(fp_path)])
                print(f"[run_all] import_simple_fingerprint(root) -> {str(out_imp)[:180]}...")
        except Exception as imp_e:
            print(f"[run_all] import_simple_fingerprint(root) error: {imp_e}")

        # Run nuclei against discovered HTTP/HTTPS base URLs
        if do_nuclei:
            try:
                nuclei_script = SCRIPTS_DIR / "run_nuclei.py"
                if nuclei_script.exists():
                    targets = build_nuclei_targets(domain, subdomains, discovered_urls)
                    if targets:
                        targets_file = RESULTS_DIR / f"nuclei_targets_{sanitize_target(domain)}.txt"
                        targets_file.write_text("\n".join(targets) + "\n")
                        extra = [str(targets_file), nuclei_severities]
                        extra.append(nuclei_templates or "")
                        extra.append("1" if nuclei_update else "0")
                        ok_n, out_n = run_subprocess_script(nuclei_script, domain, extra_args=extra)
                        print(f"[run_all] nuclei -> {str(out_n)[:180]}...")
                        importer = PROJECT_ROOT / 'recon' / 'import_nuclei.py'
                        clean_path = RESULTS_DIR / 'clean' / f"{sanitize_target(domain)}_nuclei.json"
                        if importer.exists() and clean_path.exists():
                            ok_imp, out_imp = run_subprocess_script(importer, domain, extra_args=[str(clean_path)])
                            print(f"[run_all] import_nuclei -> {str(out_imp)[:180]}...")
                    else:
                        print("[run_all] No nuclei targets discovered; skipping nuclei scan")
                else:
                    print("[run_all] run_nuclei.py not found; skipping nuclei scan")
            except Exception as nuc_err:
                print(f"[run_all] nuclei error: {nuc_err}")
        print("[stage] fingerprint done", flush=True)

        # Clean raw results, build viz JSON, and import into SQLite
        try:
            print("[stage] build_graph start", flush=True)
            clean_script = PROJECT_ROOT / "clean_from_raw.py"
            if clean_script.exists():
                ok_c, out_c = run_python_script(clean_script, args=["--all"])
                print(f"[run_all] clean_from_raw --all -> {str(out_c)[:180]}...")
            else:
                print("[run_all] clean_from_raw.py not found; skipping clean step")

            minmap_script = PROJECT_ROOT / "minmap_format.py"
            if minmap_script.exists():
                ok_m, out_m = run_python_script(minmap_script, args=[])
                print(f"[run_all] minmap_format -> {str(out_m)[:180]}...")
            else:
                print("[run_all] minmap_format.py not found; skipping viz build step")

            # NOTE: The DB is populated incrementally by per-tool importers (html links, fingerprint, etc).
            # Importing viz JSON here would wipe node.details (crawl depth/parent) and other enrichments.
            print("[run_all] Skipping import-visualized-data (DB is already populated by importers)")
            print("[stage] build_graph done", flush=True)
        except Exception as post_err:
            print(f"[run_all] post-processing error: {post_err}")

        print("[stage] done start", flush=True)
        print(f"[run_all] Done. Results directory: {RESULTS_DIR}")
        print("[stage] done done", flush=True)
    finally:
        record_scan_timestamp(domain, finished=True, scan_id=CURRENT_SCAN_ID)
if __name__ == "__main__":
    main()
