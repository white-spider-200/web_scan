import React, { useEffect, useMemo, useState } from 'react';
import './LegendPanel.css';

const DEFAULT_OPEN = true;

const swatches = [
  { key: 'root', label: 'Root domain', color: '#2DE2E6' },
  { key: 'subdomain', label: 'Subdomain/host', color: '#3B82F6' },
  { key: 'directory', label: 'Directory', color: '#FBBF24' },
  { key: 'endpoint', label: 'Endpoint/file', color: '#EF4444' },
  { key: 'ip', label: 'IP address', color: '#FB923C' },
  { key: 'cluster', label: 'Collapsed cluster', color: '#A855F7' }
];

export const LegendPanel = ({ perspective = 'sitemap' }) => {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_OPEN;
    try {
      const raw = localStorage.getItem('wrm:legendOpen');
      if (raw == null) return DEFAULT_OPEN;
      return raw === '1';
    } catch (e) {
      return DEFAULT_OPEN;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('wrm:legendOpen', open ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }, [open]);

  const isAttack = String(perspective || '').toLowerCase() === 'attack';

  const items = useMemo(() => swatches, []);
  const attackCategories = useMemo(() => ([
    { key: 'attack_findings', label: 'Findings', color: '#EF4444' },
    { key: 'attack_auth', label: 'Auth & Login', color: '#F59E0B' },
    { key: 'attack_admin', label: 'Admin & Internal', color: '#A855F7' },
    { key: 'attack_api', label: 'API & Docs', color: '#3B82F6' },
    { key: 'attack_leaks', label: 'Leaks & Secrets', color: '#FB923C' },
    { key: 'attack_restricted', label: 'Restricted (401/403)', color: '#FBBF24' },
    { key: 'attack_errors', label: 'Errors (5xx)', color: '#F43F5E' },
    { key: 'attack_other', label: 'Other URLs', color: '#94A3B8' }
  ]), []);

  return (
    <div className={`legend-panel ${open ? 'open' : 'collapsed'}`} aria-label="Legend panel">
      <button
        type="button"
        className="legend-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open ? 'true' : 'false'}
        title={open ? 'Collapse legend' : 'Expand legend'}
      >
        <span className="legend-title">Legend</span>
        <span className="legend-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="legend-body">
          <div className="legend-section">
            <div className="legend-section-title">Nodes</div>
            <div className="legend-grid">
              {items.map((it) => (
                <div key={it.key} className="legend-item">
                  <span className="legend-dot" style={{ background: it.color }} />
                  <span className="legend-label">{it.label}</span>
                </div>
              ))}
            </div>
          </div>

          {isAttack ? (
            <div className="legend-section">
              <div className="legend-section-title">Attack Surface Categories</div>
              <div className="legend-grid">
                {attackCategories.map((it) => (
                  <div key={it.key} className="legend-item">
                    <span className="legend-dot" style={{ background: it.color }} />
                    <span className="legend-label">{it.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="legend-section">
            <div className="legend-section-title">Size</div>
            <div className="legend-lines">
              {isAttack ? (
                <>
                  <div className="legend-line"><span className="legend-k">Larger</span><span className="legend-v">higher priority (score), clusters</span></div>
                  <div className="legend-line"><span className="legend-k">Smaller</span><span className="legend-v">lower signal URLs</span></div>
                </>
              ) : (
                <>
                  <div className="legend-line"><span className="legend-k">Larger</span><span className="legend-v">root, selected, clusters</span></div>
                  <div className="legend-line"><span className="legend-k">Smaller</span><span className="legend-v">deep endpoints/files</span></div>
                </>
              )}
            </div>
          </div>

          <div className="legend-section">
            <div className="legend-section-title">Links</div>
            <div className="legend-lines">
              <div className="legend-line">
                <span className="legend-link" style={{ background: 'rgba(45,226,230,0.32)' }} />
                <span className="legend-v">Containment (parent → child)</span>
              </div>
              <div className="legend-line">
                <span className="legend-link" style={{ background: '#F59E0B' }} />
                <span className="legend-v">Highlighted path</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
