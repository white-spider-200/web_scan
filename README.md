# Web Recon Map

Web Recon Map is a full-stack toolkit for running web reconnaissance scans and visualizing results as an interactive graph. It combines a Python-based recon orchestrator, a Node/Express API backed by SQLite, and a React UI for exploring websites, nodes, technologies, and relationships.

## What This Repo Includes

- Recon orchestration that runs subdomain discovery, HTTP scanning, and link discovery.
- A SQLite schema and API server for storing and serving scan results.
- A React app that renders recon data as a graph and supports reporting views.

## Repository Layout

- `src/` React UI (graph + report views).
- `server/` Express API, SQLite DB, schema, and import helpers.
- `recon/` Python recon tools and import helpers.
- `results/` Scan outputs produced by the orchestrator.
- `docs/` Architecture notes and diagrams.
- `web_recon/` Legacy standalone recon scripts and wordlists.

## Quick Start (UI + API)

1) Install client dependencies and start the UI:
```bash
npm install
npm start
```

2) Start the API server (in a separate terminal):
```bash
cd server
npm install
npm start
```

The UI runs at `http://localhost:3000` and the API runs at `http://localhost:3001`.

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

- `PORT` (default 3001)
- `CORS_ORIGINS` (comma-separated list, default `http://localhost:3000,http://localhost:5500`)
- `BODY_LIMIT` for API request size (default `1mb`)
- `RATE_LIMIT_*` for API throttling
- `PDF_ALLOW_NO_SANDBOX` only if your environment requires it

## Run a Recon Scan

The orchestrator writes results into `server/data.db` and the `results/` folder.

```bash
# Initialize the SQLite DB (safe to run multiple times)
node server/init_and_import.js

# Run a full scan for a domain and import into SQLite
node server/init_and_import.js example.com

# Or run the Python orchestrator directly
python3 run_all.py example.com
```

Targets must be a hostname or IP address (no paths).

## Data Integrity

If repeated imports ever create duplicates (broken graphs / inconsistent UI), run:

```bash
node server/dedupe-nodes.js
```

This deduplicates nodes safely, enforces a UNIQUE node identity constraint, and writes a `server/data.db.bak-*` backup. Details: `docs/data-integrity.md`.

## Vulnerability Scanning

The pipeline can run two safe vulnerability sources:

- Nmap NSE (`--script vuln,vulners`) for service CVEs.
- Nuclei for HTTP/HTTPS CVE templates.

### Install Nuclei

Follow the official install guide: https://github.com/projectdiscovery/nuclei#installation

### Enable/Disable

```bash
# Disable nmap vuln scanning
python3 run_all.py example.com --disable-nmap-vuln

# Disable nuclei scanning
python3 run_all.py example.com --disable-nuclei
```

### Configuration Options

```bash
# Lower/raise the CVSS threshold for vulners output (default 7.0)
python3 run_all.py example.com --nmap-vuln-mincvss 5.0

# Set nuclei severity filters (default medium,high,critical)
python3 run_all.py example.com --nuclei-severities medium,high,critical

# Point nuclei to a template path (optional, e.g. cves/)
python3 run_all.py example.com --nuclei-templates cves/

# Update nuclei templates before scan (optional)
python3 run_all.py example.com --nuclei-update-templates
```

### Output Schemas

Nmap NSE output:
```json
{
  "target": "example.com",
  "generatedAt": "2025-01-01T00:00:00Z",
  "hosts": {
    "1.2.3.4": {
      "ports": {
        "80/tcp": {
          "service": "http Apache httpd 2.4.49",
          "cves": [
            {
              "id": "CVE-2021-41773",
              "cvss": 8.1,
              "source": "vulners",
              "url": "https://nvd.nist.gov/vuln/detail/CVE-2021-41773"
            }
          ]
        }
      }
    }
  }
}
```

Nuclei output:
```json
{
  "target": "example.com",
  "generatedAt": "2025-01-01T00:00:00Z",
  "findings": [
    {
      "url": "https://example.com/login",
      "template": "CVE-2021-41773",
      "cve": "CVE-2021-41773",
      "severity": "high",
      "name": "Apache 2.4.49 Path Traversal",
      "refs": ["https://nvd.nist.gov/vuln/detail/CVE-2021-41773"]
    }
  ]
}
```

## Docs

- Architecture notes: `docs/architecture.md`
- System diagram: `docs/architecture.svg`
- Project report: `docs/project_report.md`
- Interactive diagram: `docs/interactive_diagram.html`

## Notes

- The API expects a local SQLite DB at `server/data.db`.
- If you see `Missing dependency: sqlite3`, run `cd server && npm install sqlite3`.
- Security guidance is documented in `SECURITY.md`.

## Tests

```bash
cd server
npm test
```
