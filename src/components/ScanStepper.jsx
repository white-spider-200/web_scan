import React, { useMemo, useRef, useState, useEffect } from 'react';

const STAGES = [
  { key: 'start', label: 'Start' },
  { key: 'subdomains', label: 'Subdomains' },
  { key: 'hyperhtml', label: 'HyperHTML' },
  { key: 'js_routes', label: 'JS Route Discovery' },
  { key: 'directories', label: 'Directories' },
  { key: 'fingerprint', label: 'Fingerprint' },
  { key: 'build_graph', label: 'Build Graph / Save DB' },
  { key: 'done', label: 'Done' }
];

const normalizeStageKey = (key) => {
  switch (key) {
    case 'html_links': return 'hyperhtml';
    case 'dirs': return 'directories';
    default: return key || 'start';
  }
};

const statusLabel = (status) => {
  switch (status) {
    case 'queued': return 'Queued';
    case 'cancelling': return 'Cancelling';
    case 'cancelled': return 'Cancelled';
    case 'failed': return 'Failed';
    case 'done':
    case 'completed': return 'Done';
    default: return 'Running';
  }
};

const getCompletedCount = (stages, states) => {
  const totalStages = stages.filter(s => s.key !== 'done');
  const completed = totalStages.filter(s => states[s.key] === 'done').length;
  return { completed, total: totalStages.length };
};

const getActiveStage = (stages, states) => stages.find(s => states[s.key] === 'running') || null;

export const ScanStepper = ({ scan, onClose }) => {
  const [showLogs, setShowLogs] = useState(scan.status === 'running');
  const logRef = useRef(null);
  const logPanelId = `scan-logs-${scan.scanId || 'active'}`;

  const currentStageKey = normalizeStageKey(scan.currentStage);
  const stageIndex = STAGES.findIndex(s => s.key === currentStageKey);

  const stageStates = useMemo(() => {
    const states = {};
    STAGES.forEach((stage, idx) => {
      if (scan.status === 'cancelled' && stage.key === currentStageKey) {
        states[stage.key] = 'failed';
        return;
      }
      if (scan.status === 'failed' && stage.key === currentStageKey) {
        states[stage.key] = 'failed';
        return;
      }
      if (scan.status === 'completed' || scan.status === 'done') {
        states[stage.key] = 'done';
        return;
      }
      if (idx < stageIndex) states[stage.key] = 'done';
      else if (idx === stageIndex) states[stage.key] = 'running';
      else states[stage.key] = 'pending';
    });
    STAGES.forEach((stage) => {
      const override = scan.stageMeta?.[stage.key]?.status;
      if (override) {
        states[stage.key] = override;
      }
    });
    return states;
  }, [scan.status, currentStageKey, stageIndex, scan.stageMeta]);

  const progressSummary = useMemo(() => getCompletedCount(STAGES, stageStates), [stageStates]);
  const activeStage = useMemo(() => getActiveStage(STAGES, stageStates), [stageStates]);

  const elapsed = useMemo(() => {
    if (!scan.startedAt) return '—';
    const started = new Date(scan.startedAt).getTime();
    if (!Number.isFinite(started)) return '—';
    const now = Date.now();
    const seconds = Math.max(0, Math.floor((now - started) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }, [scan.startedAt]);

  const lastUpdate = useMemo(() => {
    if (!scan.lastUpdateAt) return '—';
    const updated = new Date(scan.lastUpdateAt).getTime();
    if (!Number.isFinite(updated)) return '—';
    const now = Date.now();
    const seconds = Math.max(0, Math.floor((now - updated) / 1000));
    return `${seconds}s ago`;
  }, [scan.lastUpdateAt]);

  const isStalled = useMemo(() => {
    if (!scan.lastUpdateAt) return false;
    if (!['running', 'cancelling'].includes(String(scan.status || ''))) return false;
    const updated = new Date(scan.lastUpdateAt).getTime();
    if (!Number.isFinite(updated)) return false;
    return (Date.now() - updated) > 15000;
  }, [scan.lastUpdateAt, scan.status]);

  useEffect(() => {
    if (!showLogs) return;
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom || scan.status === 'running') {
      el.scrollTop = el.scrollHeight;
    }
  }, [scan.logLines, showLogs, scan.status]);

  useEffect(() => {
    if (scan.status === 'running' && Array.isArray(scan.logLines) && scan.logLines.length) {
      setShowLogs(true);
    }
  }, [scan.status, scan.logLines]);

  const copyLogs = async () => {
    try {
      const text = (scan.logLines || []).join('\n');
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch (e) {
      // ignore
    }
  };

  return (
    <section className="scan-stepper">
      <div className="scan-stepper-header">
        <div className="scan-stepper-title">Scan: {scan.target || 'Unknown'}</div>
        <div className="scan-stepper-actions">
          <span className={`scan-status-chip ${scan.status === 'failed' ? 'error' : scan.status === 'cancelled' || scan.status === 'cancelling' ? 'warn' : scan.status === 'completed' || scan.status === 'done' ? 'good' : 'running'}`}>
            {statusLabel(scan.status)}
          </span>
          {onClose ? (
            <button type="button" className="scan-stepper-close" onClick={onClose} aria-label="Close scan panel">×</button>
          ) : null}
        </div>
      </div>

      <div className="scan-stepper-meta-row">
        <span>Elapsed: {elapsed}</span>
        <span>Last update: {lastUpdate}</span>
        <span className="scan-stepper-progress">Completed: {progressSummary.completed} / {progressSummary.total} steps</span>
        <span className="scan-stepper-active">
          {activeStage ? `Current step: ${activeStage.label}` : (scan.status === 'completed' || scan.status === 'done' ? 'Scan completed' : 'Finalizing scan…')}
        </span>
        {isStalled ? <span className="scan-stepper-stalled">Progress delayed…</span> : null}
      </div>

      <div className="scan-stepper-list">
        {STAGES.map((stage) => {
          const state = stageStates[stage.key];
          const meta = scan.stageMeta?.[stage.key] || {};
          let metaLine = 'Pending';
          if (state === 'running') {
            const prefix = scan.status === 'cancelling' ? 'Cancelling...' : 'Running...';
            metaLine = `${prefix}${scan.message ? ` ${scan.message}` : ''}`;
          } else if (state === 'done') {
            const duration = meta.durationSeconds ? `${meta.durationSeconds}s` : null;
            const count = meta.count != null ? `Found ${meta.count}` : null;
            metaLine = ['Completed', duration, count].filter(Boolean).join(' • ');
          } else if (state === 'timed_out') {
            metaLine = meta.message || 'Timed out • partial';
          } else if (state === 'capped') {
            metaLine = meta.message || 'Capped • partial';
          } else if (state === 'failed') {
            metaLine = scan.status === 'cancelled' ? 'Cancelled' : (meta.message ? `Failed • ${meta.message}` : 'Failed');
          }
          const limitNote = stage.key === 'subdomains' ? 'Limit 50s' : null;
          const metaDisplay = limitNote ? [metaLine, limitNote].filter(Boolean).join(' • ') : metaLine;
          return (
            <div key={stage.key} className={`step ${state}`}>
              <div className="rail">
                {stage.key !== 'start' ? <span className="lineTop" /> : null}
                <div className="dot" />
                {stage.key !== 'done' ? <span className="lineBottom" /> : null}
              </div>
              <div className="label">
                <div className="name">{stage.label}</div>
                <div className="meta">{metaDisplay}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="scan-stepper-actions-row">
        <button
          type="button"
          className={`scan-stepper-logs-toggle ${showLogs ? 'active' : ''}`}
          onClick={() => setShowLogs(v => !v)}
          aria-expanded={showLogs}
          aria-controls={logPanelId}
        >
          {showLogs ? 'Hide Logs' : 'Show Logs'}
        </button>
        {scan.canCancel ? (
          <button
            type="button"
            className="scan-stepper-cancel-btn"
            onClick={scan.onCancel}
            disabled={scan.cancelling}
          >
            {scan.cancelling ? 'Cancelling…' : 'Cancel Scan'}
          </button>
        ) : null}
      </div>
      <div className={`log-drawer ${showLogs ? 'open' : 'closed'}`} aria-hidden={!showLogs}>
        <div className="log-panel" id={logPanelId}>
          <div className="log-toolbar">
            <button type="button" className="log-copy-btn" onClick={copyLogs}>Copy</button>
          </div>
          <div className="log-output" ref={logRef}>
            {(scan.logLines && scan.logLines.length) ? (
              scan.logLines.map((line, idx) => {
                const isLatest = idx === scan.logLines.length - 1;
                return (
                  <div key={`${idx}-${line.slice(0, 16)}`} className={`log-line ${isLatest ? 'latest' : ''}`}>
                    {line}
                  </div>
                );
              })
            ) : (
              <div className="log-empty">Waiting for logs...</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
