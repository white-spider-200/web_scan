# Web Recon Map

**Web Recon Map** is a full-stack toolkit designed for orchestrating web reconnaissance scans and visualizing the results in an interactive graph. It integrates a Python-based recon engine, a Node.js/Express API, and a React-based frontend.

## Project Overview

*   **Goal:** Automate the discovery of subdomains, directories, technologies, and vulnerabilities, and present this data in a navigable node-link diagram.
*   **Architecture:**
    *   **Recon Engine (Python):** Orchestrates tools like `nmap`, `ffuf`, `nuclei`, and custom scripts to gather data.
    *   **Backend (Node.js):** An Express API that interfaces with a SQLite database to store and serve scan results.
    *   **Frontend (React):** A visualization dashboard using libraries like `cytoscape` and `react-force-graph` to explore the target's attack surface.

## Key Components & Structure

### 1. Reconnaissance (`/recon`, `/root`)
*   **`run_all.py`**: The main entry point. Orchestrates the entire scan pipeline:
    1.  `ffuf_subs`: Subdomain discovery.
    2.  `html_link_discovery`: Crawling for internal links.
    3.  `js_route_discovery`: Extracting endpoints from JavaScript assets.
    4.  `dirsearch`: Directory and file enumeration (per subdomain).
    5.  `simple_fingerprint`: Header and technology analysis.
    6.  `nmap`: Port scanning and vulnerability detection.
    7.  `nuclei`: Template-based vulnerability scanning.
*   **`recon/`**: Contains individual Python scripts for each task and their corresponding "importers" (e.g., `import_dirsearch.py`) which push data to the database.
*   **`results/`**: Stores raw and processed JSON output from the recon tools.

### 2. Backend (`/server`)
*   **`index.js`**: Main Express server entry point (Default Port: 3001).
*   **`data.db`**: SQLite database storing the graph data (nodes, edges, vulnerabilities).
*   **`init_and_import.js`**: Helper script to initialize the DB and import existing scan data.
*   **`dedupe-nodes.js`**: Utility to maintain data integrity by merging duplicate nodes.

### 3. Frontend (`/src`, `/public`)
*   **`App.js`**: Main React component structure.
*   **Visualizations**: Uses `cytoscape`, `d3`, and `react-force-graph` for the interactive map.
*   **Configuration**: `package.json` in the root manages frontend dependencies and scripts.

## Building and Running

### Prerequisites
*   Node.js (v14+)
*   Python 3.8+
*   Nmap, FFUF, Nuclei (installed and in PATH)

### 1. Start the Frontend
Runs the React UI on `http://localhost:3000`.
```bash
npm install
npm start
```

### 2. Start the Backend
Runs the Express API on `http://localhost:3001`.
```bash
cd server
npm install
npm start
```

### 3. Run a Scan
Executes the full recon pipeline against a target.
```bash
# Basic scan
python3 run_all.py example.com

# Scan options
python3 run_all.py example.com --disable-nuclei --disable-nmap-vuln --workers 4
```

### 4. Data Management
If you have raw results or need to re-import:
```bash
node server/init_and_import.js example.com
```

## Data Flow
1.  **Scan**: `run_all.py` triggers tools -> outputs JSON to `results/`.
2.  **Import**: Python "importers" (called by `run_all.py`) parse JSON -> insert into `server/data.db`.
3.  **Serve**: Express API queries `server/data.db`.
4.  **View**: React Frontend fetches graph data from API.

## Development Conventions
*   **Recon Scripts**: Python scripts should output JSON files to `results/` and have a corresponding `import_*.py` script to handle DB insertion.
*   **Database**: SQLite is the single source of truth. Use `server/schema.sql` (or active schema logic) for reference.
*   **Safety**: All scans should be authorized. The tool includes flags to disable aggressive scanners (`--disable-nuclei`).
