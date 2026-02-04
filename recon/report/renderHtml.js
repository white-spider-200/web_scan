function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso;
  }
}

function renderStatCard(label, value, colorClass = '') {
  return `
    <div class="stat-card ${colorClass}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderBarChart(data, title, maxItems = 10) {
  const entries = Object.entries(data || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems);
  
  if (!entries.length) return '';

  const maxVal = Math.max(...entries.map(e => e[1]));
  
  const bars = entries.map(([label, count]) => {
    const pct = (count / maxVal) * 100;
    return `
      <div class="chart-row">
        <div class="chart-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="chart-bar-container">
          <div class="chart-bar" style="width: ${pct}%"></div>
          <span class="chart-value">${count}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card chart-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="chart-body">
        ${bars}
      </div>
    </div>
  `;
}

function renderTable(headers, rows, emptyMsg = 'No data available') {
  if (!rows || !rows.length) return `<div class="empty-state">${emptyMsg}</div>`;
  
  const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  return `
    <div class="table-container">
      <table>
        <thead><tr>${ths}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderHtml(report) {
  const { meta, summary, nodes } = report;
  const nodeLimit = 5000; // Increased limit for print
  const hasMore = nodes.length > nodeLimit;
  const jsonData = JSON.stringify(report).replace(/</g, '\u003c');

  // Summary Metrics
  const vulnCount = Object.values(summary.byVulnSeverity || {}).reduce((a, b) => a + b, 0);
  const techCount = Object.keys(summary.byTech || {}).length;

  // Tables Rows
  const topHubsRows = summary.topHubs.map(h => `
    <tr>
      <td>${escapeHtml(h.label)}</td>
      <td><span class="badge badge-type">${escapeHtml(h.type)}</span></td>
      <td class="text-right">${h.outCount}</td>
    </tr>
  `).join('');

  const interestingRows = summary.interestingEndpoints.map(n => `
    <tr>
      <td>${escapeHtml(n.label)}</td>
      <td class="wrap"><a href="${escapeHtml(n.fullUrl)}" target="_blank">${escapeHtml(n.fullUrl)}</a></td>
      <td><span class="badge badge-status status-${String(n.status)[0]}xx">${escapeHtml(n.status)}</span></td>
    </tr>
  `).join('');

  const vulnRows = (summary.topVulns || []).map(v => `
    <tr>
      <td><span class="badge badge-severity severity-${escapeHtml(v.severity)}">${escapeHtml(v.severity)}</span></td>
      <td>${escapeHtml(v.name)}</td>
      <td>${escapeHtml(v.host)}</td>
    </tr>
  `).join(''); 
  // Note: summary.topVulns isn't explicitly built in buildReport, but we can iterate nodes if needed.
  // Let's build a quick vuln list from nodes since buildReport aggregates counts but not a list in summary.
  let allVulns = [];
  nodes.forEach(n => {
    if(n.vulns && n.vulns.length) {
      n.vulns.forEach(v => {
        allVulns.push({ ...v, host: n.label });
      });
    }
  });
  // Sort by severity
  const severityOrder = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0 };
  allVulns.sort((a, b) => (severityOrder[b.severity?.toLowerCase()] || 0) - (severityOrder[a.severity?.toLowerCase()] || 0));
  const topVulnsRows = allVulns.slice(0, 50).map(v => `
    <tr>
      <td><span class="badge badge-severity severity-${escapeHtml(v.severity?.toLowerCase())}">${escapeHtml(v.severity)}</span></td>
      <td>${escapeHtml(v.info?.name || v.id || 'Unknown Issue')}</td>
      <td>${escapeHtml(v.host)}</td>
      <td class="wrap text-muted">${escapeHtml(v.info?.description || v.matcher_name || '')}</td>
    </tr>
  `).join('');


  const nodeRows = nodes.slice(0, nodeLimit).map(n => `
    <tr>
      <td><span class="badge badge-type">${escapeHtml(n.type)}</span></td>
      <td class="wrap">${escapeHtml(n.fullUrl || n.label)}</td>
      <td><span class="badge badge-status status-${String(n.status)[0]}xx">${escapeHtml(n.status ?? '-')}</span></td>
      <td class="text-muted">${escapeHtml(n.technologies?.join(', ') || '')}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recon Report: ${escapeHtml(meta.scanId)}</title>
  <style>
    /* Reset & Base */
    :root { 
      --primary: #2563eb; 
      --bg: #f8fafc; 
      --card-bg: #ffffff; 
      --text-main: #1e293b; 
      --text-muted: #64748b;
      --border: #e2e8f0;
      
      --severity-critical: #7f1d1d;
      --severity-high: #991b1b;
      --severity-medium: #b45309;
      --severity-low: #1e40af;
      --severity-info: #155e75;

      --status-2xx: #166534;
      --status-3xx: #854d0e;
      --status-4xx: #991b1b;
      --status-5xx: #7f1d1d;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background: var(--bg); color: var(--text-main); font-size: 14px; line-height: 1.5; -webkit-print-color-adjust: exact; }
    
    /* Layout */
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 30px; border-bottom: 1px solid var(--border); padding-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
    .header h1 { margin: 0; font-size: 28px; color: #0f172a; font-weight: 700; letter-spacing: -0.5px; }
    .header .meta { color: var(--text-muted); font-size: 13px; margin-top: 5px; }
    
    .actions { display: flex; gap: 10px; }
    .btn { background: #fff; border: 1px solid var(--border); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; color: var(--text-main); transition: all 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
    .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    .btn-primary:hover { background: #1d4ed8; }

    /* Grid */
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 30px; }
    
    /* Cards */
    .card { background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); padding: 20px; overflow: hidden; }
    .card h3 { margin: 0 0 15px; font-size: 16px; font-weight: 600; color: #334155; display: flex; align-items: center; gap: 8px; }
    
    /* Stat Cards */
    .stat-card { background: #fff; padding: 20px; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .stat-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 8px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #0f172a; }
    
    /* Charts */
    .chart-row { display: flex; align-items: center; margin-bottom: 8px; font-size: 13px; }
    .chart-label { width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
    .chart-bar-container { flex: 1; display: flex; align-items: center; gap: 10px; }
    .chart-bar { height: 12px; background: #e2e8f0; border-radius: 6px; position: relative; min-width: 2px; }
    .chart-card:first-child .chart-bar { background: #3b82f6; }
    .chart-card:last-child .chart-bar { background: #64748b; }
    .chart-value { font-weight: 600; color: #334155; font-size: 12px; width: 30px; text-align: right; }

    /* Tables */
    .table-container { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border); background: #f8fafc; color: var(--text-muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: #334155; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .wrap { word-break: break-all; max-width: 400px; }
    .text-right { text-align: right; }
    .text-muted { color: #94a3b8; }

    /* Badges */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; line-height: 1.4; }
    .badge-type { background: #e2e8f0; color: #475569; text-transform: uppercase; }
    
    .badge-status { color: #fff; }
    .status-2xx { background: #22c55e; }
    .status-3xx { background: #eab308; }
    .status-4xx { background: #f97316; }
    .status-5xx { background: #ef4444; }
    
    .badge-severity { color: #fff; text-transform: uppercase; }
    .severity-critical { background: #ef4444; }
    .severity-high { background: #f97316; }
    .severity-medium { background: #f59e0b; }
    .severity-low { background: #3b82f6; }
    .severity-info { background: #0ea5e9; }
    .severity-unknown { background: #94a3b8; }

    /* Print Overrides */
    @media print {
      body { background: #fff; font-size: 12px; }
      .container { padding: 0; max-width: none; }
      .card, .stat-card { box-shadow: none; border: 1px solid #ccc; break-inside: avoid; }
      .actions { display: none; }
      .header { border-bottom: 2px solid #000; }
      th { border-bottom: 2px solid #000; color: #000; }
      td { border-bottom: 1px solid #ddd; }
      h1 { color: #000; }
      .chart-bar { background: #999 !important; -webkit-print-color-adjust: exact; }
      a { text-decoration: none; color: #000; }
      .table-container { overflow: visible; }
    }
  </style>
</head>
<body>

<div class="container">
  
  <header class="header">
    <div>
      <h1>Scan Report</h1>
      <div class="meta">
        <strong>Target:</strong> ${escapeHtml(meta.scanId)} <br>
        <strong>Generated:</strong> ${formatDate(meta.generatedAt)}
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="window.print()">Print Report</button>
      <button class="btn" onclick="downloadJson()">Download JSON</button>
      <button class="btn" onclick="downloadPdf()">Download PDF</button>
    </div>
  </header>

  <!-- High Level Stats -->
  <section class="grid-4">
    ${renderStatCard('Total Nodes', meta.nodeCount)}
    ${renderStatCard('Vulnerabilities', vulnCount, vulnCount > 0 ? (vulnCount > 10 ? 'severity-high' : 'severity-medium') : '')}
    ${renderStatCard('Technologies', techCount)}
    ${renderStatCard('First Seen', formatDate(meta.firstSeenMin))}
  </section>

  <!-- Charts Row -->
  <section class="grid-2">
    ${renderBarChart(summary.byType, 'Nodes by Type')}
    ${renderBarChart(summary.byStatus, 'Status Codes')}
  </section>

  <!-- Technologies & Vulns Row -->
  <section class="grid-2">
    <div class="card">
      <h3>Technologies Detected</h3>
      ${renderBarChart(summary.byTech, '', 15)}
    </div>
    <div class="card">
      <h3>Vulnerability Severity</h3>
      ${renderBarChart(summary.byVulnSeverity, '', 10)}
    </div>
  </section>

  <!-- Top Vulnerabilities Table -->
  ${topVulnsRows.length ? `
    <section class="card" style="margin-bottom: 30px;">
      <h3>Detected Vulnerabilities</h3>
      ${renderTable(['Severity', 'Name', 'Host', 'Description'], topVulnsRows)}
    </section>
  ` : ''}

  <!-- Interesting Endpoints -->
  <section class="card" style="margin-bottom: 30px;">
    <h3>Interesting Endpoints (200, 3xx, 401, 403, 500)</h3>
    ${renderTable(['Label', 'URL', 'Status'], interestingRows)}
  </section>

  <!-- Top Hubs -->
  <section class="card" style="margin-bottom: 30px;">
    <h3>Top Hubs (Nodes with most connections)</h3>
    ${renderTable(['Label', 'Type', 'Children'], topHubsRows)}
  </section>

  <!-- Full Node List -->
  <section class="card">
    <h3>All Nodes (${nodes.length})</h3>
    ${renderTable(
      ['Type', 'URL / Label', 'Status', 'Tech'],
      nodeRows
    )}
    ${hasMore ? `<div style="padding:10px; color:#666; font-style:italic;">Showing first ${nodeLimit} nodes. Download JSON for full dataset.</div>` : ''}
  </section>

</div>

<script>
  const REPORT_DATA = ${jsonData};
  
  function downloadJson() {
    const blob = new Blob([JSON.stringify(REPORT_DATA, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scan_report_${escapeHtml(meta.scanId)}.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function downloadPdf() {
    const scanId = encodeURIComponent('${escapeHtml(meta.scanId)}');
    // Assuming backend endpoint exists as seen in original code
    window.open('/api/report/full.pdf?scanId=' + scanId, '_blank');
  }
</script>

</body>
</html>