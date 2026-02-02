# Web Recon Map

**Web Recon Map** is a comprehensive full-stack toolkit designed to automate web reconnaissance and visualize the attack surface of a target in an interactive graph. It seamlessly integrates a Python-based reconnaissance engine, a Node.js/Express API, and a modern React frontend.

## 🚀 Key Features

-   **Automated Reconnaissance**: Orchestrates tools like `nmap`, `ffuf`, `nuclei`, and custom scripts.
-   **Interactive Visualization**: Explores subdomains, directories, technologies, and vulnerabilities using a node-link diagram.
-   **Vulnerability Scanning**: Integrates Nmap NSE and Nuclei for detecting CVEs and misconfigurations.
-   **Data Persistence**: Uses SQLite to store scan results, enabling historical tracking and data integrity.
-   **Search & Filtering**: Easily find specific nodes, technologies, or vulnerability severities within the graph.

## 🏗️ Architecture

The system consists of three main components:

1.  **Recon Engine (Python)**:
    -   Orchestrates the scanning pipeline (subdomain discovery, link crawling, port scanning, etc.).
    -   Outputs raw JSON results to the `results/` directory.
    -   Includes importers to parse results and populate the database.

2.  **Backend API (Node.js/Express)**:
    -   Serves as the interface between the frontend and the SQLite database (`server/data.db`).
    -   Provides endpoints for fetching graph data, search results, and scan reports.
    -   Handles data integrity and node deduplication.

3.  **Frontend Dashboard (React)**:
    -   Visualizes the data using `cytoscape` and `react-force-graph`.
    -   Provides controls for filtering, layout adjustment, and detailed node inspection.

## 📋 Prerequisites

Ensure you have the following installed on your system:

-   **Node.js** (v14 or higher)
-   **Python** (3.8 or higher)
-   **Security Tools** (Must be in your PATH):
    -   [Nmap](https://nmap.org/)
    -   [FFUF](https://github.com/ffuf/ffuf)
    -   [Nuclei](https://github.com/projectdiscovery/nuclei)

## 🛠️ Installation & Setup

### 1. Frontend Setup
Initialize the React application:
```bash
npm install
npm start
```
The UI will run at `http://localhost:3000`.

### 2. Backend Setup
In a separate terminal, set up the Express API:
```bash
cd server
npm install
npm start
```
The API will run at `http://localhost:3001`.

### 3. Environment Configuration
Copy `.env.example` to `.env` in the root directory and adjust settings if necessary:
-   `PORT`: API port (default: 3001)
-   `CORS_ORIGINS`: Allowed frontend origins.

## 🕵️ Usage

### Running a Scan
The primary entry point is `run_all.py`. This script runs the full recon pipeline against a target domain.

```bash
# Basic scan
python3 run_all.py example.com

# Scan with specific options (disable aggressive tools)
python3 run_all.py example.com --disable-nuclei --disable-nmap-vuln --workers 4
```

### Advanced Scan Options
-   **Disable Nmap Vuln Scan**: `--disable-nmap-vuln`
-   **Disable Nuclei**: `--disable-nuclei`
-   **Custom Nuclei Templates**: `--nuclei-templates path/to/templates`
-   **Update Nuclei Templates**: `--nuclei-update-templates`

### Importing Existing Data
If you have raw results in `results/` or need to re-populate the database:
```bash
node server/init_and_import.js example.com
```

### Data Maintenance
If the graph shows duplicate nodes or inconsistencies, run the deduplication utility:
```bash
node server/dedupe-nodes.js
```

## 📂 Project Structure

```
├── recon/                  # Python reconnaissance scripts & orchestrators
│   ├── run_all.py          # Main entry point for scans
│   ├── import_*.py         # Scripts to import JSON results to DB
│   └── ...
├── server/                 # Node.js API & Database
│   ├── index.js            # Express server entry point
│   ├── data.db             # SQLite database (generated)
│   ├── schema.sql          # Database schema
│   └── ...
├── src/                    # React Frontend
│   ├── components/         # UI Components (Graph, Panels, etc.)
│   ├── App.js              # Main App component
│   └── ...
├── results/                # Raw scan output files (JSON/TXT)
└── docs/                   # Documentation & Architectural diagrams
```

## 🔒 Security & Safety

**Disclaimer**: This tool is designed for authorized security testing and educational purposes only. Always ensure you have explicit permission to scan the target infrastructure.

-   **Nuclei & Nmap**: These tools can be aggressive. Use the `--disable-*` flags if you need to be stealthy or reduce load on the target.
-   **Sensitive Data**: Scan results are stored locally in `server/data.db` and `results/`. Protect these files if they contain sensitive findings.

## 📄 License

This project is intended for personal and educational use. Please check the `LICENSE` file for specific terms (if applicable).