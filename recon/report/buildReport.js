const { URL } = require('url');

const STATUS_INTERESTING = new Set([200, 301, 302, 401, 403, 500]);

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeType(node) {
  const t = (node && node.type) ? String(node.type).toLowerCase() : 'unknown';
  if (t === 'host' || t === 'domain' || t === 'subdomain') return 'host';
  if (t === 'dir' || t === 'directory') return 'dir';
  if (t === 'file') return 'file';
  if (t === 'path' || t === 'endpoint') return 'path';
  return 'unknown';
}

function extractUrlParts(node) {
  const full = node.fullUrl || node.fullLabel || node.normalizedUrl || node.value || node.id || '';
  const raw = String(full || '');
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  if (!hasScheme && raw.startsWith('/')) {
    return { hostname: node.hostname || '', pathname: raw, full };
  }
  try {
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    return { hostname: u.hostname || '', pathname: u.pathname || '/', full };
  } catch (e) {
    return { hostname: node.hostname || '', pathname: '', full };
  }
}

function getExtension(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  const idx = last.lastIndexOf('.');
  if (idx <= 0 || idx === last.length - 1) return '';
  return last.slice(idx + 1).toLowerCase();
}

function buildAdjacency(edges) {
  const outCounts = new Map();
  for (const e of edges) {
    const src = (e && e.source && typeof e.source === 'object') ? e.source.id : e.source;
    const tgt = (e && e.target && typeof e.target === 'object') ? e.target.id : e.target;
    if (!src || !tgt) continue;
    outCounts.set(src, (outCounts.get(src) || 0) + 1);
  }
  return outCounts;
}

function buildReport(graph, meta = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : (Array.isArray(graph.links) ? graph.links : []);

  const byType = {};
  const byHost = {};
  const byStatus = {};
  const byExt = {};
  const byTech = {};
  const byVulnSeverity = {};
  let minFirstSeen = null;
  let maxLastSeen = null;

  const normalizedNodes = nodes.map((node) => {
    const type = normalizeType(node);
    const status = safeNumber(node.status || node.httpStatus);
    const firstSeen = node.firstSeen || node.meta?.firstSeen || null;
    const lastSeen = node.lastSeen || node.meta?.lastSeen || null;
    if (firstSeen && (!minFirstSeen || firstSeen < minFirstSeen)) minFirstSeen = firstSeen;
    if (lastSeen && (!maxLastSeen || lastSeen > maxLastSeen)) maxLastSeen = lastSeen;

    const { hostname, pathname, full } = extractUrlParts(node);
    const ext = getExtension(pathname);
    byType[type] = (byType[type] || 0) + 1;
    if (hostname) byHost[hostname] = (byHost[hostname] || 0) + 1;
    if (status != null) byStatus[String(status)] = (byStatus[String(status)] || 0) + 1;
    if (ext) byExt[ext] = (byExt[ext] || 0) + 1;

    // Technologies
    const techs = node.technologies || node.meta?.technologies || [];
    if (Array.isArray(techs)) {
      techs.forEach(t => {
        if (!t) return;
        byTech[t] = (byTech[t] || 0) + 1;
      });
    }

    // Vulns
    const vulns = node.vulns || node.meta?.vulns || {};
    // Normalize vulns to a flat list for counting severity
    const flatVulns = [];
    if (vulns.nmap && Array.isArray(vulns.nmap)) flatVulns.push(...vulns.nmap);
    if (vulns.nuclei && Array.isArray(vulns.nuclei)) flatVulns.push(...vulns.nuclei);
    
    flatVulns.forEach(v => {
      const severity = (v.severity || 'info').toLowerCase();
      byVulnSeverity[severity] = (byVulnSeverity[severity] || 0) + 1;
    });

    return {
      id: node.id || node.value || '',
      label: node.label || node.value || node.id || '',
      type,
      fullUrl: full,
      status,
      firstSeen,
      lastSeen,
      seenCount: node.seenCount || node.meta?.seenCount || null,
      technologies: techs,
      vulns: flatVulns
    };
  });

  const outCounts = buildAdjacency(edges);
  const topHubs = normalizedNodes
    .map(n => ({ id: n.id, label: n.label, type: n.type, outCount: outCounts.get(n.id) || 0 }))
    .sort((a, b) => b.outCount - a.outCount)
    .slice(0, 30);

  const interestingEndpoints = normalizedNodes
    .filter(n => n.status != null && STATUS_INTERESTING.has(Number(n.status)))
    .slice(0, 200);

  return {
    meta: {
      scanId: meta.scanId || '',
      generatedAt: meta.generatedAt || new Date().toISOString(),
      nodeCount: normalizedNodes.length,
      edgeCount: edges.length,
      firstSeenMin: minFirstSeen,
      lastSeenMax: maxLastSeen
    },
    summary: {
      byType,
      byHost,
      byStatus,
      byExt,
      byTech,
      byVulnSeverity,
      topHubs,
      interestingEndpoints
    },
    nodes: normalizedNodes,
    edges
  };
}

module.exports = { buildReport };
