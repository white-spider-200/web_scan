import React, { useEffect, useMemo, useState } from 'react';
import './StatsPanel.css';

const DEFAULT_OPEN = true;

const formatNumber = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString();
};

const formatDuration = (seconds) => {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  const total = Math.max(0, Math.floor(s));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const formatLocalTime = (iso) => {
  const v = String(iso || '').trim();
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString();
  } catch (e) {
    return v;
  }
};

export const StatsPanel = ({ stats, scan }) => {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_OPEN;
    try {
      const raw = localStorage.getItem('wrm:statsOpen');
      if (raw == null) return DEFAULT_OPEN;
      return raw === '1';
    } catch (e) {
      return DEFAULT_OPEN;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('wrm:statsOpen', open ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }, [open]);

  const summary = useMemo(() => {
    const empty = {
      total: 0,
      domain: 0,
      subdomain: 0,
      directory: 0,
      endpoint: 0,
      ip: 0,
      statusTop: [],
      statusUnknown: 0,
      techTop: [],
      techUnique: 0,
      techTotal: 0
    };
    if (!stats) return empty;
    return { ...empty, ...stats };
  }, [stats]);

  const elapsedSeconds = useMemo(() => {
    if (!scan?.startedAt) return null;
    try {
      const started = new Date(scan.startedAt).getTime();
      if (!Number.isFinite(started)) return null;
      const end = scan?.finishedAt ? new Date(scan.finishedAt).getTime() : Date.now();
      if (!Number.isFinite(end)) return null;
      return Math.max(0, Math.floor((end - started) / 1000));
    } catch (e) {
      return null;
    }
  }, [scan?.finishedAt, scan?.startedAt]);

  return (
    <div className={`stats-panel ${open ? 'open' : 'collapsed'}`} aria-label="Statistics">
      <button
        type="button"
        className="stats-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open ? 'true' : 'false'}
        title={open ? 'Collapse statistics' : 'Expand statistics'}
      >
        <span className="stats-title">Overview</span>
        <span className="stats-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="stats-body">
          <div className="stats-metrics">
            <div className="stats-metric">
              <div className="stats-k">Total nodes</div>
              <div className="stats-v">{formatNumber(summary.total)}</div>
            </div>
            <div className="stats-metric">
              <div className="stats-k">Elapsed</div>
              <div className="stats-v">{elapsedSeconds == null ? '—' : formatDuration(elapsedSeconds)}</div>
            </div>
            <div className="stats-metric">
              <div className="stats-k">Started</div>
              <div className="stats-v sm">{formatLocalTime(scan?.startedAt)}</div>
            </div>
            <div className="stats-metric">
              <div className="stats-k">Finished</div>
              <div className="stats-v sm">{formatLocalTime(scan?.finishedAt)}</div>
            </div>
          </div>

          <div className="stats-section">
            <div className="stats-section-title">By Type</div>
            <div className="stats-grid">
              <div className="stats-row"><span className="dot" style={{ background: '#2DE2E6' }} />Domain <span className="count">{formatNumber(summary.domain)}</span></div>
              <div className="stats-row"><span className="dot" style={{ background: '#3B82F6' }} />Subdomains <span className="count">{formatNumber(summary.subdomain)}</span></div>
              <div className="stats-row"><span className="dot" style={{ background: '#FBBF24' }} />Directories <span className="count">{formatNumber(summary.directory)}</span></div>
              <div className="stats-row"><span className="dot" style={{ background: '#EF4444' }} />Endpoints <span className="count">{formatNumber(summary.endpoint)}</span></div>
              <div className="stats-row"><span className="dot" style={{ background: '#FB923C' }} />IPs <span className="count">{formatNumber(summary.ip)}</span></div>
            </div>
          </div>

          <div className="stats-section">
            <div className="stats-section-title">HTTP Status</div>
            <div className="stats-list">
              {summary.statusTop.length ? (
                summary.statusTop.map((row) => (
                  <div key={row.code} className="stats-line">
                    <span className="stats-pill">{row.code}</span>
                    <span className="stats-line-v">{formatNumber(row.count)}</span>
                  </div>
                ))
              ) : (
                <div className="stats-empty">No status metadata yet</div>
              )}
              {summary.statusUnknown ? (
                <div className="stats-line muted">
                  <span className="stats-pill muted">—</span>
                  <span className="stats-line-v">{formatNumber(summary.statusUnknown)}</span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="stats-section">
            <div className="stats-section-title">Technologies</div>
            <div className="stats-tech">
              <div className="stats-tech-summary">
                <span className="stats-k">Unique</span>
                <span className="stats-v">{formatNumber(summary.techUnique)}</span>
                <span className="stats-k">Total tags</span>
                <span className="stats-v">{formatNumber(summary.techTotal)}</span>
              </div>
              {summary.techTop.length ? (
                <div className="stats-list">
                  {summary.techTop.map((t) => (
                    <div key={t.name} className="stats-line">
                      <span className="stats-tech-name">{t.name}</span>
                      <span className="stats-line-v">{formatNumber(t.count)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stats-empty">No technologies tagged yet</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
