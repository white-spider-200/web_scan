import React, { useEffect, useMemo, useState, useRef } from 'react';
import './DetailsPanel.css';
import { ScanStepper } from './ScanStepper';

const STATUS_MAP = {
  '2': { label: 'OK', tone: 'good' },
  '3': { label: 'Redirect', tone: 'warm' },
  '4': { label: 'Client Error', tone: 'warn' },
  '5': { label: 'Server Error', tone: 'alert' }
};

const formatStatus = (status) => {
  const normalized = String(status || '').trim() || '200';
  const group = normalized[0];
  const { label, tone } = STATUS_MAP[group] || { label: 'Unknown', tone: 'neutral' };
  return { code: normalized, label, tone };
};

const buildFullUrl = (node, scanContext) => {
  const isHttp = (value) => /^https?:\/\//i.test(String(value || '').trim());
  const sanitize = (value) => String(value || '').trim();
  const normalizeBase = (value) => {
    if (!value) return '';
    const trimmed = sanitize(value);
    if (isHttp(trimmed)) return trimmed.replace(/\/+$/, '');
    return `https://${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  };
  const normalizePath = (value) => {
    const trimmed = sanitize(value);
    if (!trimmed) return '';
    if (trimmed.startsWith('?')) return trimmed;
    return `/${trimmed.replace(/^\/+/, '')}`;
  };

  // Examples:
  // buildFullUrl({ url: "https://example.com/a" }) -> https://example.com/a
  // buildFullUrl({ path: "/wp-content/themes" }, { domain: "www.waitbutwhy.com" }) -> https://www.waitbutwhy.com/wp-content/themes
  // buildFullUrl({ value: "/login?next=/" }, { baseUrl: "https://example.com" }) -> https://example.com/login?next=/

  const direct = sanitize(node?.url || node?.fullUrl || node?.href || '');
  if (direct && isHttp(direct)) return direct;

  const rawPath = sanitize(node?.path || node?.value || node?.fullLabel || '');
  const path = rawPath && !isHttp(rawPath) ? rawPath : '';

  const base = normalizeBase(scanContext?.baseUrl || scanContext?.domain || node?.hostname || node?.meta?.host || '');
  if (!base) return null;

  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) return base;
  return `${base}${normalizedPath}`;
};

const normalizeHttpUrl = (raw) => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (/^(javascript|data):/i.test(trimmed)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch (e) {
    return null;
  }
};

const extractTechnologies = (node) => {
  if (!node) return [];
  if (Array.isArray(node.technologies)) return node.technologies;
  if (node.meta && Array.isArray(node.meta.technologies)) return node.meta.technologies;
  return [];
};

const extractVulnerabilities = (node) => {
  if (!node) return { nmap: [], nuclei: [] };
  const meta = node.meta?.vulns || node.vulns || {};
  const nmap = Array.isArray(meta.nmap) ? meta.nmap : [];
  const nuclei = Array.isArray(meta.nuclei) ? meta.nuclei : [];
  if (!nmap.length && Array.isArray(node.vulnerabilities)) {
    const legacy = node.vulnerabilities.map((v) => ({
      id: String(v),
      source: 'legacy'
    }));
    return { nmap: legacy, nuclei };
  }
  return { nmap, nuclei };
};

const iconForType = (type) => {
  switch (type) {
    case 'domain':
      return '🌐';
    case 'subdomain':
      return '🔗';
    case 'directory':
      return '📁';
    case 'endpoint':
      return '📄';
    case 'ip':
      return '🧷';
    default:
      return '🧩';
  }
};

export const DetailsPanel = ({ node, onClose, scan, relations = [], bookmarked = false, onToggleBookmark, locked = false, onToggleLock }) => {
  const technologies = useMemo(() => extractTechnologies(node), [node]);
  const vulnerabilities = useMemo(() => extractVulnerabilities(node), [node]);

  const [activeTab, setActiveTab] = useState('details');
  const [copyNotice, setCopyNotice] = useState('');
  const [urlNotice, setUrlNotice] = useState('');
  const notesStorageKey = useMemo(() => {
    const base = String(node?.value || node?.id || '').trim();
    return base ? `wrm:notes:${base}` : '';
  }, [node?.id, node?.value]);
  const [notes, setNotes] = useState('');
  const [showAllNmap, setShowAllNmap] = useState(false);
  const [showAllNuclei, setShowAllNuclei] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('detailsPanelWidth');
      const parsed = stored ? parseInt(stored, 10) : NaN;
      if (!Number.isNaN(parsed)) return Math.min(Math.max(parsed, 360), 960);
    }
    return 560; // default width
  });
  const minWidth = 360;
  const maxWidth = 960;
  const startDragRef = useRef({ active: false });

  // Expose panel width to CSS so the graph can reserve space on the right
  useEffect(() => {
    const w = (node || scan) ? panelWidth : 0;
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--details-panel-width', `${w}px`);
    }
    return () => {
      // On unmount, clear the reservation to avoid stale margins
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--details-panel-width', '0px');
      }
    };
  }, [panelWidth, node, scan]);

  useEffect(() => {
    const handleMove = (e) => {
      if (!startDragRef.current.active) return;
      const newWidth = Math.min(Math.max(window.innerWidth - e.clientX, minWidth), maxWidth);
      setPanelWidth(newWidth);
    };
    const handleUp = () => {
      if (startDragRef.current.active) {
        startDragRef.current.active = false;
        window.localStorage.setItem('detailsPanelWidth', String(panelWidth));
        document.body.classList.remove('dp-resizing');
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [panelWidth]);

  const beginResize = (e) => {
    e.preventDefault();
    startDragRef.current.active = true;
    document.body.classList.add('dp-resizing');
  };

  // Keep the selected node visible while resizing the panel
  useEffect(() => {
    try {
      if (node && window?.graphInstance?.focusOn) {
        window.graphInstance.focusOn(node.id, { zoom: 1.6, duration: 240 });
      }
    } catch (e) {
      // non-fatal; graph may not be ready
    }
  }, [panelWidth, node]);

  const resetWidth = () => {
    setPanelWidth(560);
    window.localStorage.setItem('detailsPanelWidth', '560');
  };

  useEffect(() => {
    setActiveTab('details');
    setShowAllNmap(false);
    setShowAllNuclei(false);
    setUrlNotice('');
  }, [node]);

  useEffect(() => {
    if (!notesStorageKey) {
      setNotes('');
      return;
    }
    try {
      setNotes(window.localStorage.getItem(notesStorageKey) || '');
    } catch (e) {
      setNotes('');
    }
  }, [notesStorageKey]);

  if (!node && !scan) return null;

  const statusInfo = formatStatus(node?.status);
  const ipAddress = node?.ip || node?.meta?.ip || 'Unknown';
  const server = node?.server || node?.meta?.server || 'Unknown';
  const scanContext = {
    baseUrl: scan?.baseUrl || scan?.target || '',
    domain: scan?.domain || scan?.target || ''
  };
  const fullUrl = buildFullUrl(node, scanContext);
  const fullUrlDisplay = fullUrl || 'URL unavailable';
  const getDisplayName = (nodeData) => {
    if (!nodeData) return 'Node details';
    if (nodeData.type === 'host') {
      return nodeData.hostname || nodeData.label || nodeData.id || 'Node details';
    }
    const candidate = nodeData.fullLabel || nodeData.value || '';
    if (typeof candidate === 'string' && candidate.trim()) {
      const cleaned = candidate.split('#')[0].split('?')[0];
      const parts = cleaned.split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return nodeData.label || nodeData.id || 'Node details';
  };
  const displayName = getDisplayName(node);
  const nodeType = node?.type || 'node';
  const nodeTypeLabel = (function() {
    const raw = String(nodeType || '').toLowerCase();
    if (raw === 'domain' || raw === 'root') return 'Domain';
    if (raw === 'subdomain' || raw === 'host') return 'Subdomain';
    if (raw === 'directory' || raw === 'dir') return 'Directory';
    if (raw === 'ip') return 'IP';
    if (raw === 'endpoint' || raw === 'url' || raw === 'path' || raw === 'file') return 'Endpoint';
    return raw ? raw[0].toUpperCase() + raw.slice(1) : 'Node';
  })();
  const copyFullPath = async () => {
    if (!fullUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullUrl);
      } else {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyNotice('Copied');
      setTimeout(() => setCopyNotice(''), 1200);
    } catch (e) {
      setCopyNotice('Copy failed');
      setTimeout(() => setCopyNotice(''), 1200);
    }
  };

  const openFullPath = () => {
    if (!fullUrl) {
      setUrlNotice('URL unavailable');
      setTimeout(() => setUrlNotice(''), 1400);
      return;
    }
    const normalized = normalizeHttpUrl(fullUrl);
    if (!normalized) {
      setUrlNotice('Invalid URL');
      setTimeout(() => setUrlNotice(''), 1400);
      return;
    }
    window.open(normalized, '_blank', 'noopener,noreferrer');
  };

  const copyValue = async (value) => {
    if (!value) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value));
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(value);
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyNotice('Copied');
      setTimeout(() => setCopyNotice(''), 1200);
    } catch (e) {
      setCopyNotice('Copy failed');
      setTimeout(() => setCopyNotice(''), 1200);
    }
  };

  const handleNotesChange = (e) => {
    const next = e.target.value;
    setNotes(next);
    if (!notesStorageKey) return;
    try {
      window.localStorage.setItem(notesStorageKey, next);
    } catch (err) {
      // ignore storage errors
    }
  };

  // Tabs
  const tabs = [
    { key: 'details', label: 'Node Details' },
    { key: 'tech', label: 'Technologies' },
    { key: 'security', label: 'Vulnerabilities' }
  ];

  const nmapFindings = Array.isArray(vulnerabilities.nmap) ? vulnerabilities.nmap : [];
  const nucleiFindings = Array.isArray(vulnerabilities.nuclei) ? vulnerabilities.nuclei : [];

  const cvssToSeverity = (cvss) => {
    const score = Number(cvss);
    if (Number.isNaN(score)) return null;
    if (score >= 9.0) return 'critical';
    if (score >= 7.0) return 'high';
    if (score >= 4.0) return 'medium';
    if (score > 0) return 'low';
    return null;
  };

  const severityRank = (sev) => {
    switch (String(sev || '').toLowerCase()) {
      case 'critical': return 4;
      case 'high': return 3;
      case 'medium': return 2;
      case 'low': return 1;
      default: return 0;
    }
  };

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  nmapFindings.forEach((f) => {
    const sev = cvssToSeverity(f?.cvss);
    if (sev && counts[sev] != null) counts[sev] += 1;
  });
  nucleiFindings.forEach((f) => {
    const sev = String(f?.severity || '').toLowerCase();
    if (counts[sev] != null) counts[sev] += 1;
  });

  const sortedNmap = [...nmapFindings].sort((a, b) => {
    const aScore = Number(a?.cvss) || 0;
    const bScore = Number(b?.cvss) || 0;
    return bScore - aScore;
  });

  const sortedNuclei = [...nucleiFindings].sort((a, b) => severityRank(b?.severity) - severityRank(a?.severity));

  const nmapVisible = showAllNmap ? sortedNmap : sortedNmap.slice(0, 20);
  const nucleiVisible = showAllNuclei ? sortedNuclei : sortedNuclei.slice(0, 20);

  return (
    <aside className="details-panel dp-panel" style={{ width: panelWidth }}>
      <div
        className="dp-resize-handle"
        onMouseDown={beginResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details panel"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            setPanelWidth(w => Math.min(Math.max(w + 20, minWidth), maxWidth));
          } else if (e.key === 'ArrowRight') {
            setPanelWidth(w => Math.min(Math.max(w - 20, minWidth), maxWidth));
          } else if (e.key === 'Escape') {
            resetWidth();
          }
        }}
      />
      {node && (
        <div className="dp-header-section">
          <div className="dp-heading-line">
            <span className="dp-heading-icon" aria-hidden>{iconForType(nodeType)}</span>
            <div className="dp-heading-text">
              <div className="dp-heading-kicker">NODE DETAILS</div>
              <div className="dp-heading-title" title={displayName}>{displayName}</div>
            </div>
            {typeof onToggleBookmark === 'function' ? (
              <button
                type="button"
                className={`dp-bookmark ${bookmarked ? 'active' : ''}`}
                onClick={() => onToggleBookmark(node)}
                aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark node'}
                title={bookmarked ? 'Remove bookmark' : 'Bookmark node'}
              >
                {bookmarked ? '★' : '☆'}
              </button>
            ) : null}
            {typeof onToggleLock === 'function' ? (
              <button
                type="button"
                className={`dp-lock ${locked ? 'active' : ''}`}
                onClick={() => onToggleLock(node)}
                aria-label={locked ? 'Unlock node (enable physics)' : 'Lock node (disable physics)'}
                title={locked ? 'Unlock node (enable physics)' : 'Lock node (disable physics)'}
              >
                {locked ? '🔒' : '🔓'}
              </button>
            ) : null}
            <button type="button" className="dp-close" onClick={onClose} aria-label="Close details panel">×</button>
          </div>
          <div className="dp-status-line">
            <span className="dp-type-pill">{nodeTypeLabel}</span>
            <span className={`dp-status-pill ${statusInfo.tone}`}>{statusInfo.code}</span>
            <span className="dp-status-meta dp-status-meta--nowrap" title={ipAddress}>
              <span className="dp-status-label">IP</span> {ipAddress}
            </span>
            {technologies.length ? (
              <span className="dp-status-meta dp-status-meta--nowrap" title={technologies.join(', ')}>
                <span className="dp-status-label">Tech</span> {technologies.slice(0, 2).join(', ')}{technologies.length > 2 ? ` +${technologies.length - 2}` : ''}
              </span>
            ) : null}
            <button type="button" className="dp-reset-width" onClick={resetWidth} title="Reset width">Reset</button>
          </div>
        </div>
      )}

      <div className="dp-scroll">
        {scan ? <ScanStepper scan={scan} onClose={scan.onClose} /> : null}
        {node && (
          <div className="dp-meta-cards">
            {node ? (
              <div className="dp-meta-card dp-meta-card--full">
                <div className="dp-meta-label">🧭 Full URL</div>
                <div className="dp-meta-value dp-meta-value--full" title={fullUrlDisplay}>{fullUrlDisplay}</div>
                <div className="dp-meta-actions">
                  <button type="button" className="dp-copy-btn" onClick={copyFullPath} aria-label="Copy URL" title="Copy URL" disabled={!fullUrl}>Copy</button>
                  <button type="button" className="dp-copy-btn" onClick={openFullPath} aria-label="Open URL" title="Open URL" disabled={!fullUrl}>Open</button>
                </div>
                {copyNotice ? <div className="dp-copy-note">{copyNotice}</div> : null}
                {urlNotice ? <div className="dp-copy-note">{urlNotice}</div> : null}
              </div>
            ) : null}
          </div>
        )}

        {node && (
          <nav className="dp-tabs" role="tablist">
            {tabs.map(t => (
              <button
                key={t.key}
                role="tab"
                aria-selected={activeTab === t.key}
                className={`dp-tab ${activeTab === t.key ? 'active' : ''}`}
                onClick={() => setActiveTab(t.key)}
              >{t.label}</button>
            ))}
          </nav>
        )}

        <div className="dp-tab-content">
        {activeTab === 'details' && node && (
          <div className="dp-details-tab">
            <section className="dp-section">
              <div className="dp-section-title">Overview</div>
              <div className="dp-kv-grid">
                <div className="dp-kv">
                  <div className="dp-k">Type</div>
                  <div className="dp-v">{nodeTypeLabel}</div>
                </div>
                <div className="dp-kv">
                  <div className="dp-k">Status</div>
                  <div className="dp-v">{statusInfo.code}</div>
                </div>
                <div className="dp-kv">
                  <div className="dp-k">IP</div>
                  <div className="dp-v">{ipAddress}</div>
                </div>
                <div className="dp-kv">
                  <div className="dp-k">Technologies</div>
                  <div className="dp-v">
                    {technologies.length ? technologies.join(', ') : '—'}
                  </div>
                </div>
              </div>
            </section>

            <section className="dp-section">
              <div className="dp-section-title">Relations</div>
              {Array.isArray(relations) && relations.length ? (
                <ul className="dp-relations">
                  {relations.slice(0, 24).map((rel) => {
                    const relId = typeof rel === 'string' ? rel : String(rel?.id || rel?.fullLabel || rel?.label || rel?.value || '');
                    const relLabel = typeof rel === 'string'
                      ? rel
                      : (rel?.fullLabel || rel?.label || rel?.value || rel?.id || '');
                    const relType = typeof rel === 'string' ? '' : String(rel?.type || '').toLowerCase();
                    return (
                      <li key={relId} className="dp-relation">
                        <span className={`dp-relation-dot t-${relType || 'unknown'}`} aria-hidden="true" />
                        <span className="dp-relation-label" title={relLabel}>{relLabel}</span>
                        <button type="button" className="dp-copy-button" onClick={() => copyValue(relLabel)}>Copy</button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="dp-empty">No related nodes available</div>
              )}
            </section>

            <section className="dp-section">
              <div className="dp-section-title">Notes</div>
              <textarea
                className="dp-notes"
                value={notes}
                onChange={handleNotesChange}
                placeholder="Add analyst notes…"
                rows={6}
              />
            </section>

            <section className="dp-section">
              <div className="dp-section-title">Evidence</div>
              <div className="dp-evidence">
                <div className="dp-evidence-row">
                  <div className="dp-evidence-k">Full URL</div>
                  <div className="dp-evidence-v" title={fullUrlDisplay}>{fullUrlDisplay}</div>
                  <button type="button" className="dp-copy-button" onClick={copyFullPath} disabled={!fullUrl}>Copy</button>
                </div>
                <div className="dp-evidence-row">
                  <div className="dp-evidence-k">IP</div>
                  <div className="dp-evidence-v">{ipAddress}</div>
                  <button type="button" className="dp-copy-button" onClick={() => copyValue(ipAddress)} disabled={!ipAddress || ipAddress === 'Unknown'}>Copy</button>
                </div>
                <div className="dp-evidence-row">
                  <div className="dp-evidence-k">Server</div>
                  <div className="dp-evidence-v" title={server}>{server}</div>
                  <button type="button" className="dp-copy-button" onClick={() => copyValue(server)} disabled={!server || server === 'Unknown'}>Copy</button>
                </div>
                <div className="dp-evidence-row">
                  <div className="dp-evidence-k">Technologies</div>
                  <div className="dp-evidence-v" title={technologies.join(', ')}>{technologies.length ? `${technologies.length} detected` : '—'}</div>
                  <button type="button" className="dp-copy-button" onClick={() => copyValue(technologies.join(', '))} disabled={!technologies.length}>Copy</button>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'tech' && (
          <div className="dp-tech-tab">
            {technologies.length ? <ul className="dp-chip-list">{technologies.map(t => <li key={t}>{t}</li>)}</ul> : null}
          </div>
        )}

        {activeTab === 'security' && (
          <div className="dp-security-tab">
            <div className="dp-vuln-summary">
              <div className="dp-vuln-count"><span>Critical</span><strong>{counts.critical}</strong></div>
              <div className="dp-vuln-count"><span>High</span><strong>{counts.high}</strong></div>
              <div className="dp-vuln-count"><span>Medium</span><strong>{counts.medium}</strong></div>
              <div className="dp-vuln-count"><span>Low</span><strong>{counts.low}</strong></div>
            </div>

            <section className="dp-vuln-section">
              <div className="dp-vuln-header">
                <h4>Nmap Findings</h4>
                <span className="dp-vuln-meta">{nmapFindings.length} total</span>
              </div>
              {nmapFindings.length ? (
                <div className="dp-vuln-list">
                  {nmapVisible.map((f, idx) => (
                    <div className="dp-vuln-card" key={`${f?.id || 'nmap'}-${idx}`}>
                      <div className="dp-vuln-main">
                        {f?.id ? (
                          <a className="dp-vuln-id" href={f?.url || `https://nvd.nist.gov/vuln/detail/${f.id}`} target="_blank" rel="noreferrer">{f.id}</a>
                        ) : (
                          <span className="dp-vuln-id">Unknown CVE</span>
                        )}
                        {f?.cvss != null && <span className={`dp-vuln-score sev-${cvssToSeverity(f?.cvss) || 'none'}`}>CVSS {f.cvss}</span>}
                      </div>
                      <div className="dp-vuln-sub">
                        <span>{f?.service || 'Unknown service'}</span>
                        {f?.port && <span>Port {f.port}</span>}
                      </div>
                      <div className="dp-vuln-actions">
                        <button type="button" className="dp-copy-button" onClick={() => copyValue(f?.id)}>Copy CVE</button>
                        {f?.url && <a className="dp-link-button" href={f.url} target="_blank" rel="noreferrer">View</a>}
                      </div>
                    </div>
                  ))}
                  {sortedNmap.length > 20 && (
                    <button type="button" className="dp-ghost-button" onClick={() => setShowAllNmap((prev) => !prev)}>
                      {showAllNmap ? 'Show top 20' : 'Show all'}
                    </button>
                  )}
                </div>
              ) : (
                <div className="dp-empty">No nmap vulnerabilities detected</div>
              )}
            </section>

            <section className="dp-vuln-section">
              <div className="dp-vuln-header">
                <h4>Nuclei Findings</h4>
                <span className="dp-vuln-meta">{nucleiFindings.length} total</span>
              </div>
              {nucleiFindings.length ? (
                <div className="dp-vuln-list">
                  {nucleiVisible.map((f, idx) => (
                    <div className="dp-vuln-card" key={`${f?.template || 'nuclei'}-${idx}`}>
                      <div className="dp-vuln-main">
                        {Array.isArray(f?.refs) && f.refs.length ? (
                          <a className="dp-vuln-id" href={f.refs[0]} target="_blank" rel="noreferrer">
                            {f?.template || f?.cve || 'Unknown template'}
                          </a>
                        ) : (
                          <span className="dp-vuln-id">{f?.template || f?.cve || 'Unknown template'}</span>
                        )}
                        {f?.severity && <span className={`dp-vuln-score sev-${String(f.severity).toLowerCase()}`}>{String(f.severity).toUpperCase()}</span>}
                      </div>
                      <div className="dp-vuln-sub">
                        <span>{f?.name || 'Unnamed template'}</span>
                        {f?.url && <span title={f.url}>{f.url}</span>}
                      </div>
                      <div className="dp-vuln-actions">
                        <button type="button" className="dp-copy-button" onClick={() => copyValue(f?.template || f?.cve)}>Copy ID</button>
                        {f?.url && <button type="button" className="dp-copy-button" onClick={() => copyValue(f.url)}>Copy URL</button>}
                        {Array.isArray(f?.refs) && f.refs.length ? (
                          <a className="dp-link-button" href={f.refs[0]} target="_blank" rel="noreferrer">Reference</a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {sortedNuclei.length > 20 && (
                    <button type="button" className="dp-ghost-button" onClick={() => setShowAllNuclei((prev) => !prev)}>
                      {showAllNuclei ? 'Show top 20' : 'Show all'}
                    </button>
                  )}
                </div>
              ) : (
                <div className="dp-empty">No nuclei findings detected</div>
              )}
            </section>
          </div>
        )}
        </div>
      </div>
    </aside>
  );
};
