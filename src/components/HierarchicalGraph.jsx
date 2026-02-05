import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import './Graph.css';
import ForceGraph2D from 'react-force-graph-2d';
import { forceManyBody, forceCollide, forceLink, forceCenter, forceRadial, forceX, forceY } from 'd3-force';
import { useGraphSettings } from '../context/GraphSettingsContext';

export const HierarchicalGraph = ({
  data,
  onNodeClick,
  highlightedNodes = [],
  highlightPath = [],
  disableLevelSystem = false,
  selectedNodeId = null,
  bookmarkedNodeIds = null,
  lockedNodeIds = null,
  lockLayout = false,
  onToggleLock,
  layoutPreset = 'radial',
  onLayoutChange
}) => {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const { layout: settingsLayout, display: settingsDisplay, groups: settingsGroups } = useGraphSettings();
  const suppressAutoFit = useRef(false);
  const tooltipCacheRef = useRef(new Map());
  const labelLayoutRef = useRef({ boxes: [] });
  const exportSnapshotRef = useRef({ nodes: [], links: [] });
  const exportFnsRef = useRef({ getNodeColor: () => '#94A3B8', getNodeSize: () => 10 });
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [levels, setLevels] = useState(new Map());
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [maxVisibleLevel, setMaxVisibleLevel] = useState(2); // force visibility by level
  const [hoverNodeId, setHoverNodeId] = useState(null);
  const [, setPinnedNodes] = useState(new Set());
  const [labelMode, setLabelMode] = useState(() => {
    if (typeof window === 'undefined') return 'smart';
    try {
      return localStorage.getItem('graphLabelMode') || 'smart';
    } catch (e) {
      return 'smart';
    }
  });
  const [layout, setLayout] = useState(() => {
    if (typeof window === 'undefined') return 'radial';
    try {
      return localStorage.getItem('graphLayoutPreset') || 'radial';
    } catch (e) {
      return 'radial';
    }
  });

  // Ensure any leftover debug panel from previous builds or edits is removed from the DOM
  useEffect(() => {
    try {
      if (typeof document !== 'undefined') {
        const old = document.getElementById('graph-debug');
        if (old) old.remove();
      }
    } catch (e) { /* ignore */ }
  }, []);

  const maxExistingLevel = useMemo(() => {
    if (!data?.nodes?.length) return 1;
    let mx = 1;
    data.nodes.forEach((n) => {
      const fallbackLevel =
        n.type === 'host' && n.role === 'root'
          ? 1
          : (n.type === 'host' && n.role === 'subdomain') || n.type === 'dir'
            ? 2
            : 3;
      const lvl = levels.get(n.id) ?? fallbackLevel;
      if (lvl > mx) mx = lvl;
    });
    return mx;
  }, [data, levels]);

  // Keep the active level within the max depth present in the graph.
  useEffect(() => {
    if (disableLevelSystem) return;
    setMaxVisibleLevel((prev) => {
      const base = prev == null ? 2 : prev;
      const next = Math.max(1, Math.min(maxExistingLevel, base));
      return next === prev ? prev : next;
    });
  }, [disableLevelSystem, maxExistingLevel]);

  // Local small component for level buttons rendered over the graph
  const LevelButtons = () => {
    const maxLevel = maxExistingLevel;
    const cur = Math.max(1, Math.min(maxLevel, maxVisibleLevel ?? 2));
    const canDec = cur > 1;
    const canInc = cur < maxLevel;

    const setLevel = (lvl) => {
      const newLvl = Math.max(1, Math.min(maxLevel, lvl));
      setExpanded(() => new Set());
      setMaxVisibleLevel(newLvl);
    };

    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => setLevel(cur - 1)} disabled={!canDec} title="Previous level">−</button>
        <div className="level-display" style={{ minWidth: 110, textAlign: 'center', padding: '6px 10px', borderRadius: 6 }}>
          Level {cur} / {maxLevel}
        </div>
        <button onClick={() => setLevel(cur + 1)} disabled={!canInc} title="Next level">+</button>
      </div>
    );
  };

  // Load persisted expandedNodes from localStorage once
  useEffect(() => {
    try {
      const raw = localStorage.getItem('expandedNodes');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setExpandedNodes(new Set(arr));
      }
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('graphLabelMode', labelMode);
    } catch (e) {
      // ignore
    }
  }, [labelMode]);

  useEffect(() => {
    try {
      localStorage.setItem('graphLayoutPreset', layout);
    } catch (e) {
      // ignore persistence errors
    }
  }, [layout]);

  useEffect(() => {
    if (layoutPreset && layoutPreset !== layout) {
      setLayout(layoutPreset);
    }
  }, [layoutPreset, layout]);

  useEffect(() => {
    if (!disableLevelSystem) return;
    setMaxVisibleLevel(null);
  }, [disableLevelSystem]);

  useEffect(() => {
    const inst = fgRef.current;
    if (!inst || typeof inst.pauseAnimation !== 'function') return;
    try {
      if (lockLayout || settingsLayout.isFrozen) inst.pauseAnimation();
      else inst.resumeAnimation();
    } catch (e) {
      // ignore
    }
  }, [lockLayout, settingsLayout.isFrozen]);

  // centralized setter that persists and emits event
  const setExpanded = useCallback((updater) => {
    setExpandedNodes(prev => {
      const next = typeof updater === 'function' ? updater(prev) : new Set(updater);
      // Debug logging to help trace expansion changes
      try { console.debug('[graph] setExpanded ->', Array.from(next)); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('graphExpansionChanged', { detail: { expanded: Array.from(next) } })); } catch (e) {}
      try { localStorage.setItem('expandedNodes', JSON.stringify(Array.from(next))); } catch (e) {}
      return next;
    });
  }, []);

  // Compute node levels and update forces
  useEffect(() => {
    if (!data?.nodes?.length || !fgRef.current) return;

    const root = data.nodes.find(n => n.type === 'host' && n.role === 'root') || data.nodes.find(n => n.type === 'host');
    if (!root) return;

    // Assign hierarchical levels (prefer explicit node.level when present)
    const newLevels = new Map();
    data.nodes.forEach(node => {
      if (Number.isFinite(node.level)) {
        newLevels.set(node.id, node.level);
        return;
      }
      if (node.type === 'host' && node.role === 'root') {
        newLevels.set(node.id, 1);
        return;
      }
      if (node.type === 'host' && node.role === 'subdomain') {
        newLevels.set(node.id, 2);
        return;
      }
      if (node.type === 'dir') {
        newLevels.set(node.id, 2);
        return;
      }
      if (node.type === 'path' || node.type === 'file') {
        newLevels.set(node.id, 3);
        return;
      }
      newLevels.set(node.id, 3);
    });
    setLevels(newLevels);
  }, [data]);

  // Function to expand all parents of a node to make it visible
  const expandToNode = useCallback((nodeId) => {
    if (!data || !data.nodes || !data.links) return;
    
    const nodesToExpand = new Set();
    const findParents = (id) => {
      const parentLinks = data.links.filter(l => {
        if (l.type !== 'contains') return false;
        const tgt = typeof l.target === 'object' ? l.target.id : l.target;
        return String(tgt) === String(id);
      });
      parentLinks.forEach(link => {
        const src = typeof link.source === 'object' ? link.source.id : link.source;
        nodesToExpand.add(src);
        findParents(src);
      });
    };
    
    findParents(nodeId);
    setExpanded(prev => new Set([...prev, ...nodesToExpand]));
  }, [data, setExpanded]);

  const manualFit = useCallback((padding = 420, duration = 160, delay = 120) => {
    suppressAutoFit.current = true;
    setTimeout(() => {
      const inst = fgRef.current;
      if (!inst || typeof inst.zoomToFit !== 'function') {
        suppressAutoFit.current = false;
        return;
      }
      try {
        inst.zoomToFit(padding, duration);
      } catch (e) {
        console.debug('[graph] manualFit error', e);
      } finally {
        setTimeout(() => { suppressAutoFit.current = false; }, duration + 80);
      }
    }, Math.max(0, delay));
  }, []);

  // Expose zoom-related helpers globally
  useEffect(() => {
    const expandType = (type) => {
      if (!data || !data.nodes) return;
      const roots = data.nodes.filter(n => n.type === type).map(n => n.id);
      setExpanded(prev => new Set([...prev, ...roots]));
    };

    const expandNode = (nodeId) => setExpanded(prev => new Set([...prev, nodeId]));
    const collapseNode = (nodeId) => setExpanded(prev => { const next = new Set(prev); next.delete(nodeId); return next; });
    const toggleNode = (nodeId) => setExpanded(prev => { const next = new Set(prev); if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId); return next; });
    const collapseAll = () => setExpanded(() => new Set());
    // Expand immediate children of a node (one level)
    const expandChildren = (nodeId) => {
      if (!data || !data.links) return;
      const children = data.links.filter(l => l.source === nodeId && l.type === 'contains').map(l => l.target);
      if (!children.length) return;
      setExpanded(prev => new Set([...prev, ...children]));
    };

    // Recursively expand all descendants of a node
    const expandAllDescendants = (nodeId) => {
      if (!data || !data.links) return;
      const toVisit = [nodeId];
      const all = new Set();
      while (toVisit.length) {
        const cur = toVisit.pop();
        const kids = data.links.filter(l => l.source === cur && l.type === 'contains').map(l => l.target);
        for (const k of kids) {
          if (!all.has(k)) {
            all.add(k);
            toVisit.push(k);
          }
        }
      }
      setExpanded(prev => new Set([...prev, ...all]));
    };

    // Expand up to a given hierarchical level (1 = root only). When used we switch to
    // a level-driven visibility mode: getVisibleNodes will return nodes whose level <= given
    // level and ignore the normal expansion set. This prevents accidentally expanding beyond
    // the maximum depth present in the graph.
    const expandToLevel = (level) => {
      // compute integer level
      const lvl = Number.isFinite(Number(level)) ? Math.max(1, Math.floor(Number(level))) : 1;
      // clear manual expansions to avoid conflicting state
      setExpanded(() => new Set());
      setMaxVisibleLevel(lvl);
      try { console.debug('[graph] expandToLevel ->', lvl); } catch (e) {}
    };

    const clearLevel = () => {
      setMaxVisibleLevel(null);
      try { console.debug('[graph] clearLevel'); } catch (e) {}
    };

    // Shrink (collapse) immediate children of a node
    const shrinkChildren = (nodeId) => {
      if (!data || !data.links) return;
      const children = data.links.filter(l => l.source === nodeId && l.type === 'contains').map(l => l.target);
      if (!children.length) return;
      setExpanded(prev => {
        const next = new Set(prev);
        children.forEach(c => next.delete(c));
        return next;
      });
    };

    const isExpanded = (nodeId) => expandedNodes.has(nodeId);

  // debug overlay removed: no DOM debug panel

    const getCanvasEl = () => {
      try {
        const root = containerRef.current;
        if (!root) return null;
        const canvases = Array.from(root.querySelectorAll('canvas'));
        if (!canvases.length) return null;
        const visible = canvases.find((c) => {
          try {
            const rect = c.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && c.style.display !== 'none';
          } catch (e) {
            return false;
          }
        });
        return visible || canvases[0] || null;
      } catch (e) {
        return null;
      }
    };

    const getVisibleGraphData = () => {
      const snap = exportSnapshotRef.current || { nodes: [], links: [] };
      const colorFn = exportFnsRef.current?.getNodeColor || (() => '#94A3B8');
      const sizeFn = exportFnsRef.current?.getNodeSize || (() => 10);

      const nodes = (snap.nodes || []).map((n) => ({
        id: String(n.id),
        type: n.type,
        role: n.role,
        label: n.label,
        fullLabel: n.fullLabel,
        hostname: n.hostname,
        path: n.path,
        level: n.level,
        status: n.status,
        technologies: n.technologies || n.meta?.technologies || [],
        ip: n.ip || n.meta?.ip,
        count: n.count,
        clusterType: n.clusterType,
        parentId: n.parentId,
        x: Number.isFinite(n.x) ? n.x : null,
        y: Number.isFinite(n.y) ? n.y : null,
        color: (() => { try { return colorFn(n); } catch (e) { return '#94A3B8'; } })(),
        radius: (() => { try { return sizeFn(n); } catch (e) { return 10; } })(),
        bookmarked: bookmarkedNodeIds instanceof Set ? bookmarkedNodeIds.has(String(n.id)) : Array.isArray(bookmarkedNodeIds) ? bookmarkedNodeIds.includes(String(n.id)) : false
      }));

      const links = (snap.links || []).map((l) => {
        const src = String(typeof l.source === 'object' ? l.source.id : l.source);
        const tgt = String(typeof l.target === 'object' ? l.target.id : l.target);
        return { source: src, target: tgt, type: l.type || 'contains' };
      });

      return {
        meta: {
          layout,
          labelMode,
          maxExistingLevel,
          maxVisibleLevel
        },
        nodes,
        links
      };
    };

    // Wrap methods to log calls and update debug overlay
    window.graphInstance = {
      expandType: (...a) => { try { console.debug('[graph] expandType', ...a); } catch(e){}; return expandType(...a); },
      expandNode: (...a) => { try { console.debug('[graph] expandNode', ...a); } catch(e){}; return expandNode(...a); },
      collapseNode: (...a) => { try { console.debug('[graph] collapseNode', ...a); } catch(e){}; return collapseNode(...a); },
      toggleNode: (...a) => { try { console.debug('[graph] toggleNode', ...a); } catch(e){}; return toggleNode(...a); },
      collapseAll: (...a) => { try { console.debug('[graph] collapseAll', ...a); } catch(e){}; return collapseAll(...a); },
      expandChildren: (...a) => { try { console.debug('[graph] expandChildren', ...a); } catch(e){}; return expandChildren(...a); },
      expandAllDescendants: (...a) => { try { console.debug('[graph] expandAllDescendants', ...a); } catch(e){}; return expandAllDescendants(...a); },
      shrinkChildren: (...a) => { try { console.debug('[graph] shrinkChildren', ...a); } catch(e){}; return shrinkChildren(...a); },
      expandToLevel: (...a) => { try { console.debug('[graph] expandToLevel', ...a); } catch(e){}; return expandToLevel(...a); },
      clearLevel: (...a) => { try { console.debug('[graph] clearLevel', ...a); } catch(e){}; return clearLevel(...a); },
      isExpanded: (...a) => { try { console.debug('[graph] isExpanded', ...a); } catch(e){}; return isExpanded(...a); },
      getExpandedNodes: () => { try { console.debug('[graph] getExpandedNodes'); } catch(e){}; return Array.from(expandedNodes); },
      manualFit: (...a) => { try { console.debug('[graph] manualFit', ...a); } catch(e){}; return manualFit(...a); },
      getCanvas: () => getCanvasEl(),
      getVisibleGraphData: () => getVisibleGraphData(),
      focusOn: (id, opts = {}) => {
        try { console.debug('[graph] focusOn', id, opts); } catch(e){}
        const n = (data?.nodes || []).find(nn => nn.id === id);
        if (!n) return;
        const { zoom = 1.8, duration = 600 } = opts;
        const inst = fgRef.current;
        if (!inst || !isFinite(n.x) || !isFinite(n.y)) return;
        suppressAutoFit.current = true;
        try {
          inst.centerAt(n.x, n.y, duration);
          inst.zoom(zoom, duration);
        } finally {
          setTimeout(() => { suppressAutoFit.current = false; }, duration + 60);
        }
      },
      setLayoutPreset: (preset) => {
        if (!preset) return;
        const next = String(preset).toLowerCase();
        try { console.debug('[graph] setLayoutPreset', next); } catch (e) {}
        setLayout(prev => (prev === next ? prev : next));
      },
      getLayoutPreset: () => {
        try { console.debug('[graph] getLayoutPreset ->', layout); } catch (e) {}
        return layout;
      }
      };
    }, [data, expandToNode, manualFit, layout, expandedNodes, labelMode, maxVisibleLevel, maxExistingLevel, bookmarkedNodeIds, setExpanded]);

  const focusOnNode = useCallback((node, { zoom = 1.8, duration = 600, delay = 140, retries = 3 } = {}) => {
    if (!node) return;

    const attempt = (remaining) => {
      const inst = fgRef.current;
      if (!inst || !isFinite(node.x) || !isFinite(node.y)) {
        if (remaining <= 0) return;
        setTimeout(() => attempt(remaining - 1), 120);
        return;
      }
      suppressAutoFit.current = true;
      try {
        inst.centerAt(node.x, node.y, duration);
        inst.zoom(zoom, duration);
      } finally {
        setTimeout(() => { suppressAutoFit.current = false; }, duration + 60);
      }
    };

    setTimeout(() => attempt(retries), Math.max(0, delay));
  }, []);

  // Filter visible nodes based on hierarchy and expansion state
  const getVisibleNodes = useCallback(() => {
    if (!data || !data.nodes) return [];
    if (disableLevelSystem) {
      return data.nodes.map(n => {
        n.level = levels.get(n.id) ?? n.level;
        return n;
      });
    }

    // Build parent/child maps from links
    const parentMap = new Map();
    const childMap = new Map();
    (data.links || []).forEach(l => {
      if (l.type !== 'contains') return;
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      const tgt = typeof l.target === 'object' ? l.target.id : l.target;
      const arr = parentMap.get(tgt) || [];
      arr.push(src);
      parentMap.set(tgt, arr);
      const kids = childMap.get(src) || [];
      kids.push(tgt);
      childMap.set(src, kids);
    });

    const visible = new Set();
    // If level-driven visibility mode is active, show nodes up to that level only
    if (maxVisibleLevel !== null) {
      data.nodes.forEach(n => {
        const fallbackLevel = (n.type === 'host' && n.role === 'root') ? 1 : ((n.type === 'host' && n.role === 'subdomain') || n.type === 'dir' ? 2 : 3);
        const lvl = levels.get(n.id) ?? fallbackLevel;
        if (lvl <= maxVisibleLevel) visible.add(n.id);
      });

      // Branch expansion: when a node is expanded, reveal its children even if deeper than maxVisibleLevel.
      const queue = [];
      const queued = new Set();
      expandedNodes.forEach((id) => {
        const sid = String(id);
        if (!visible.has(sid)) return;
        queue.push(sid);
        queued.add(sid);
      });
      let guard = 0;
      while (queue.length && guard++ < 20000) {
        const pid = queue.shift();
        const kids = childMap.get(pid) || [];
        for (const childId of kids) {
          const cid = String(childId);
          if (visible.has(cid)) continue;
          visible.add(cid);
          if (expandedNodes.has(cid) && !queued.has(cid)) {
            queue.push(cid);
            queued.add(cid);
          }
        }
      }
    } else {
      // Show root host and its immediate subdomain children by default
      const root = data.nodes.find(n => n.type === 'host' && n.role === 'root') || data.nodes.find(n => n.type === 'host');
      if (root) visible.add(root.id);
      (data.links || []).forEach(l => {
        if (l.type !== 'contains') return;
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        const tgt = typeof l.target === 'object' ? l.target.id : l.target;
        if (src === root?.id) {
          const childNode = data.nodes.find(nn => nn.id === tgt);
          if (childNode && childNode.type === 'host' && childNode.role === 'subdomain') visible.add(tgt);
        }
      });
    }

    // Helper: is any ancestor expanded?
    const isAncestorExpanded = (nodeId, seen = new Set()) => {
      if (seen.has(nodeId)) return false;
      seen.add(nodeId);
      const parents = parentMap.get(nodeId) || [];
      for (const p of parents) {
        if (expandedNodes.has(p)) return true;
        if (isAncestorExpanded(p, seen)) return true;
      }
      return false;
    };

    // Include path/file nodes only if they have an expanded ancestor
    data.nodes.forEach(n => {
      if (n.type === 'dir' || n.type === 'path' || n.type === 'file') {
        if (maxVisibleLevel === null) {
          // normal mode: include only if ancestor expanded
          if (isAncestorExpanded(n.id)) visible.add(n.id);
        } else {
          // level mode: already included above by level check
        }
      }
    });

    // Build resulting visible nodes array and add simple level hints
    const visibleNodes = [];
    data.nodes.forEach(n => {
      if (visible.has(n.id)) {
        n.level = levels.get(n.id) ?? n.level;
        visibleNodes.push(n);
      }
    });

    return visibleNodes;
  }, [data, expandedNodes, levels, maxVisibleLevel, disableLevelSystem]);
  
  // Get visible links based on visible nodes
  const getVisibleLinks = useCallback((visibleNodes) => {
    if (!data || !data.links) return [];
    
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    return data.links.filter(l => {
      const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
      const targetId = typeof l.target === 'object' ? l.target.id : l.target;
      return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
    });
  }, [data]);

  // Color mapping aligned with Web Recon Map UI:
  // Subdomains: blue, Directories: yellow, Endpoints: red, IPs: orange, Accent: teal/cyan.
  const getNodeColor = useCallback((node) => {
    if (!node || !node.type) return '#9CA3AF';

    // Apply Custom Groups First
    if (settingsGroups && settingsGroups.length) {
      for (const group of settingsGroups) {
        if (!group.active) continue;
        const q = (group.query || '').trim().toLowerCase();
        
        // Status Check (e.g., status:403)
        if (q.startsWith('status:')) {
          const code = q.split(':')[1];
          if (String(node.status || '').includes(code)) return group.color;
        }
        
        // Risk Check (e.g., risk:high)
        if (q.startsWith('risk:')) {
          const level = q.split(':')[1];
          const score = Number(node.attackScore || node.riskScore || 0);
          if (level === 'critical' && score >= 9) return group.color;
          if (level === 'high' && score >= 7) return group.color;
          if (level === 'medium' && score >= 4) return group.color;
          if (level === 'low' && score > 0) return group.color;
        }

        // Tag/Label Check (fallback)
        if (String(node.label || '').toLowerCase().includes(q)) return group.color;
      }
    }

    if (node.type === 'cluster') {
      const ct = String(node.clusterType || '').toLowerCase();
      if (ct.startsWith('attack_')) {
        const map = {
          attack_findings: '#EF4444',
          attack_auth: '#F59E0B',
          attack_admin: '#A855F7',
          attack_api: '#3B82F6',
          attack_leaks: '#FB923C',
          attack_restricted: '#FBBF24',
          attack_errors: '#F43F5E',
          attack_other: '#94A3B8',
          attack_subdomains: '#60A5FA'
        };
        return map[ct] || '#A855F7';
      }
      return '#A855F7';
    }
    if (node.type === 'host' && node.role === 'root') return '#2DE2E6';
    if (node.type === 'host' && node.role === 'subdomain') return '#3B82F6';

    const colors = {
      dir: '#FBBF24',   // Yellow - directory
      path: '#EF4444',  // Red - endpoint
      file: '#EF4444',  // Red - endpoint
      ip: '#FB923C',    // Orange - IP
      port: '#7C3AED',
      service: '#0891B2'
    };

    return colors[node.type] || '#94A3B8';
  }, [settingsGroups]);
  
  // Get node size based on type and expansion state
  const getNodeSize = useCallback((node) => {
    // Basic fixed sizing if requested
    if (settingsDisplay.nodeSize === 'fixed') {
      const isRoot = node.role === 'root';
      const base = isRoot ? 12 : 6;
      return base * (expandedNodes.has(node.id) ? 1.2 : 1) * (highlightedNodes.includes(String(node.id)) ? 1.3 : 1);
    }

    const baseSizes = {
      host: node.role === 'root' ? 25 : 18,
      dir: 14,
      path: 12,
      file: 12,
      ip: 12,
      cluster: node?.attackView ? 22 : 18,
      port: 10,
      service: 10
    };

    const baseSize = baseSizes[node.type] || 10;
    const countBoost = node?.count ? Math.min(18, Math.log2(node.count + 1) * 4) : 0;
    const attackScore = Number(node?.attackScore);
    let attackBoost = node?.attackView && Number.isFinite(attackScore) && attackScore > 0
      ? Math.min(18, Math.log2(attackScore + 1) * 4)
      : 0;
    
    if (settingsDisplay.nodeSize === 'risk') {
       attackBoost *= 2.5; // Emphasize risk
    } else if (settingsDisplay.nodeSize === 'degree') {
       // De-emphasize risk, rely on base size (type/count)
       attackBoost *= 0.5; 
    }
    
    // Make expanded nodes slightly larger
    const expandedMultiplier = expandedNodes.has(node.id) ? 1.2 : 1;
    
    // Make highlighted nodes larger
    const highlightMultiplier = highlightedNodes.includes(String(node.id)) ? 1.3 : 1;
    
    return (baseSize + countBoost + attackBoost) * expandedMultiplier * highlightMultiplier;
  }, [expandedNodes, highlightedNodes, settingsDisplay.nodeSize]);

  const isExpandableNode = useCallback((node) => {
    if (!node) return false;
    const t = String(node.type || '');
    if (t === 'host') return String(node.role || '') === 'subdomain';
    return t === 'dir';
  }, []);

  useEffect(() => {
    exportFnsRef.current.getNodeColor = getNodeColor;
    exportFnsRef.current.getNodeSize = getNodeSize;
  }, [getNodeColor, getNodeSize]);
  

const handleNodeHover = useCallback((node) => {
  setHoverNodeId(node?.id || null);
  const inst = fgRef.current;
  if (!inst) return;

  if (node) {
    // Pause simulation when hovering a node to stop it from moving away (Bloodhound-like behavior)
    try { inst.pauseAnimation(); } catch (e) {}
    
    // Stop the d3 simulation completely
    try {
      const sim = inst.d3Simulation?.();
      if (sim) {
        sim.stop();
      }
    } catch (e) {}
    
    // Fix ALL node positions to prevent any drift during hover
    // This ensures nodes stay exactly where they are
    try {
      const graphData = inst.graphData();
      if (graphData && graphData.nodes) {
        graphData.nodes.forEach(n => {
          if (isFinite(n.x) && isFinite(n.y)) {
            n.fx = n.x;
            n.fy = n.y;
            // Also zero out velocities to prevent any momentum
            n.vx = 0;
            n.vy = 0;
          }
        });
      }
    } catch (e) {}
  } else {
    // Resume if not locked
    if (!lockLayout) {
      // Unfreeze nodes that aren't explicitly locked by the user
      try {
        const graphData = inst.graphData();
        if (graphData && graphData.nodes) {
          graphData.nodes.forEach(n => {
            const nodeId = String(n.id || '').trim();
            // Only unfreeze if not in the user's locked set
            const isUserLocked = lockedNodeIds instanceof Set 
              ? lockedNodeIds.has(nodeId) 
              : Array.isArray(lockedNodeIds) 
                ? lockedNodeIds.includes(nodeId) 
                : false;
            if (!isUserLocked) {
              n.fx = undefined;
              n.fy = undefined;
            }
          });
        }
      } catch (e) {}
      
      // Restart simulation with low energy
      try {
        const sim = inst.d3Simulation?.();
        if (sim) {
          sim.alpha(0.1); // Low energy restart
          sim.restart();
        }
      } catch (e) {}
      
      try { inst.resumeAnimation(); } catch (e) {}
    }
  }
}, [lockLayout, lockedNodeIds]);

  // Handle node click:
  // - Click expandable nodes => expand/collapse (no auto-zoom, no details fetch)
  // - Shift+click (or leaf nodes) => focus + show details
  // - Cluster nodes => delegate to parent (no auto-zoom)
  const handleNodeClick = useCallback((node, event) => {
    if (!node) return;
    const id = String(node.id);

    if (node.type === 'cluster') {
      onNodeClick && onNodeClick(node, [id]);
      return;
    }

    const hasChildren = data?.links?.some((l) => {
      if (l.type !== 'contains') return false;
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      return String(src) === id;
    });

    const wantsDetails = !!event?.shiftKey;
    if (!disableLevelSystem && hasChildren && isExpandableNode(node) && !wantsDetails) {
      // Toggle expansion state using centralized setter (persists and emits change event)
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          // Collapse: remove this node and its immediate children (do not recurse)
          next.delete(id);
          const childLinks = (data.links || []).filter((l) => {
            if (l.type !== 'contains') return false;
            const src = typeof l.source === 'object' ? l.source.id : l.source;
            return String(src) === id;
          });
          childLinks.forEach((link) => {
            const tgt = typeof link.target === 'object' ? link.target.id : link.target;
            next.delete(String(tgt));
          });
        } else {
          next.add(id);
        }
        return next;
      });
      return;
    }

    // Details/inspect mode
    expandToNode(id);
    focusOnNode(node);
    onNodeClick && onNodeClick(node, [id]);
  }, [data, disableLevelSystem, expandToNode, focusOnNode, isExpandableNode, onNodeClick, setExpanded]);
  
  const parseUrlParts = useCallback((fullLabel, node) => {
    const empty = {
      protocol: '',
      hostname: node?.hostname || '',
      pathname: '',
      filename: '',
      extension: '',
      query: '',
      fragment: '',
      depth: 0
    };
    if (!fullLabel) return empty;
    const raw = String(fullLabel).trim();
    if (!raw) return empty;
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
    if (!hasScheme && raw.startsWith('/')) {
      const pathOnly = raw.split('#')[0];
      const [pathPart, queryPart] = pathOnly.split('?');
      const pathname = pathPart || '/';
      const parts = pathname.split('/').filter(Boolean);
      const filename = parts.length ? parts[parts.length - 1] : '';
      const ext = filename.includes('.') ? filename.split('.').pop() : '';
      return {
        ...empty,
        pathname,
        filename: node?.type === 'file' ? filename : '',
        extension: node?.type === 'file' ? ext : '',
        query: queryPart || '',
        fragment: raw.includes('#') ? raw.split('#').slice(1).join('#') : '',
        depth: parts.length
      };
    }
    let parsed;
    try {
      parsed = new URL(hasScheme ? raw : `http://${raw}`);
    } catch (e) {
      return empty;
    }
    const pathname = parsed.pathname || '/';
    const parts = pathname.split('/').filter(Boolean);
    const filename = parts.length ? parts[parts.length - 1] : '';
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    const query = parsed.search ? parsed.search.replace(/^\?/, '') : '';
    const fragment = parsed.hash ? parsed.hash.replace(/^#/, '') : '';
    return {
      protocol: parsed.protocol ? parsed.protocol.replace(':', '') : '',
      hostname: parsed.hostname || empty.hostname,
      pathname,
      filename: node?.type === 'file' ? filename : '',
      extension: node?.type === 'file' ? ext : '',
      query,
      fragment,
      depth: parts.length
    };
  }, []);

  const escapeHtml = useCallback((value) => {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }, []);

  const renderHoverCard = useCallback((node) => {
    if (!node) return '';
    const key = `${node.id}:${node.fullLabel || node.value || ''}:${String(selectedNodeId || '')}:${disableLevelSystem ? 'd' : 'l'}:${expandedNodes.has(node.id) ? '1' : '0'}`;
    const cached = tooltipCacheRef.current.get(key);
    if (cached) return cached;

    const parts = parseUrlParts(node.fullLabel || node.value || '', node);
    const header = String(node.label || node.id || '').trim();
    const headerText = header.length > 28 ? `${header.slice(0, 28)}…` : header;
    const typeLabel = node.type === 'host' ? 'Host' : (node.type === 'ip' ? 'IP' : (node.type === 'dir' ? 'Dir' : (node.type === 'file' ? 'File' : (node.type === 'cluster' ? 'Cluster' : 'Path'))));
    const extText = parts.extension ? parts.extension : '—';
    const hostText = parts.hostname || '—';
    const pathText = parts.pathname || '/';
    const normalizedText = parts.protocol && parts.hostname ? `${parts.protocol}://${parts.hostname}${parts.pathname}${parts.query ? `?${parts.query}` : ''}${parts.fragment ? `#${parts.fragment}` : ''}` : '';
    const hasChildren = data?.links?.some((l) => {
      if (l.type !== 'contains') return false;
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      return String(src) === String(node.id);
    });
    const canExpand = hasChildren && !disableLevelSystem && isExpandableNode(node);
    const isSelected = selectedNodeId && String(node.id) === String(selectedNodeId);
    const actionText = (function () {
      if (isSelected) return 'Selected';
      if (node.type === 'cluster') return 'Expand';
      if (canExpand) {
        const base = expandedNodes.has(node.id) ? 'Collapse' : 'Expand';
        return `${base} (Shift: details)`;
      }
      return 'Details';
    })();

    const html = `<div style="background: rgba(7, 16, 23, 0.92); color: #E2E8F0; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(45,226,230,0.14); box-shadow: 0 16px 38px rgba(0,0,0,0.5); backdrop-filter: blur(8px); max-width: 360px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
        <div style="font-weight:700; font-size:13px; color:${escapeHtml(getNodeColor(node))}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(headerText)}</div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.14em; padding:2px 8px; border-radius:10px; background:rgba(45,226,230,0.10); color:#BDFBFB; border: 1px solid rgba(45,226,230,0.14);">${escapeHtml(typeLabel)}</div>
      </div>
      <div style="display:grid; grid-template-columns: 70px 1fr; gap:6px 10px; font-size:11px;">
        <div style="color:#94A3B8;">Host</div>
        <div style="color:#E2E8F0; text-align:right;">${escapeHtml(hostText)}</div>
        <div style="color:#94A3B8;">Path</div>
        <div style="color:#E2E8F0;">
          <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; background:rgba(15,23,42,0.6); border:1px solid rgba(148,163,184,0.22); padding:6px 8px; border-radius:8px; max-height:72px; overflow:auto; word-break:break-word;">${escapeHtml(pathText)}</div>
        </div>
        <div style="color:#94A3B8;">Extension</div>
        <div style="color:#E2E8F0; text-align:right;">${escapeHtml(extText)}</div>
        <div style="color:#94A3B8;">Depth</div>
        <div style="color:#E2E8F0; text-align:right;">${escapeHtml(parts.depth)}</div>
        <div style="color:#94A3B8;">Action</div>
        <div style="color:#E2E8F0; text-align:right; font-weight:700;">${escapeHtml(actionText)}</div>
        ${normalizedText ? `<div style="color:#94A3B8;">Normalized</div>
        <div style="color:#E2E8F0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; word-break:break-all; user-select:text;">${escapeHtml(normalizedText)}</div>` : ''}
      </div>
    </div>`;
    tooltipCacheRef.current.set(key, html);
    return html;
  }, [data, disableLevelSystem, escapeHtml, expandedNodes, getNodeColor, isExpandableNode, parseUrlParts, selectedNodeId]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    
    const resize = () => {
      const rect = el.getBoundingClientRect();
      setSize({ 
        width: Math.max(400, Math.floor(rect.width)), 
        height: Math.max(300, Math.floor(rect.height)) 
      });
    };
    
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    
    return () => ro.disconnect();
  }, []);

  // Get current visible graph data
  const visibleNodes = getVisibleNodes();
  const visibleLinks = getVisibleLinks(visibleNodes);
  const orderedNodes = useMemo(() => {
    if (!Array.isArray(visibleNodes) || !visibleNodes.length) return [];
    const priority = (n) => {
      if (!n) return 0;
      const id = String(n.id);
      if (selectedNodeId && id === String(selectedNodeId)) return 1000;
      if (hoverNodeId && id === String(hoverNodeId)) return 920;
      if (highlightedNodes.includes(id)) return 900;
      if (highlightPath.includes(id)) return 860;
      if (n.type === 'host' && n.role === 'root') return 820;
      if (n.type === 'cluster') return 800;
      if (n.type === 'host') return 500;
      if (n.type === 'dir') return 420;
      if (n.type === 'path' || n.type === 'file') return 360;
      if (n.type === 'ip') return 320;
      return 100;
    };
    return [...visibleNodes].sort((a, b) => priority(b) - priority(a));
  }, [visibleNodes, selectedNodeId, hoverNodeId, highlightedNodes, highlightPath]);

  const graphData = { nodes: orderedNodes, links: visibleLinks };

  useEffect(() => {
    exportSnapshotRef.current = { nodes: orderedNodes, links: visibleLinks };
  }, [orderedNodes, visibleLinks]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const sid = String(selectedNodeId);
    return orderedNodes.find((n) => String(n.id) === sid) || null;
  }, [orderedNodes, selectedNodeId]);

  const depthByNodeId = useMemo(() => {
    const depth = new Map();
    if (!selectedNodeId || !visibleLinks.length) return depth;
    const start = String(selectedNodeId);
    depth.set(start, 0);
    const adj = new Map();

    visibleLinks.forEach((link) => {
      const src = String(typeof link.source === 'object' ? link.source.id : link.source);
      const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
      if (!adj.has(src)) adj.set(src, new Set());
      if (!adj.has(tgt)) adj.set(tgt, new Set());
      adj.get(src).add(tgt);
      adj.get(tgt).add(src);
    });

    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const d = depth.get(id) || 0;
      const neighbors = adj.get(id);
      if (!neighbors) continue;
      neighbors.forEach((nb) => {
        if (depth.has(nb)) return;
        depth.set(nb, d + 1);
        queue.push(nb);
      });
    }
    return depth;
  }, [visibleLinks, selectedNodeId]);

  const renderSelectionRings = useCallback((ctx, globalScale) => {
    // Reset per-frame label occupancy so collision checks apply only within the current frame.
    labelLayoutRef.current.boxes = [];

    if (!selectedNodeId || !selectedNode) return;
    const x = selectedNode.x;
    const y = selectedNode.y;
    if (!isFinite(x) || !isFinite(y)) return;

    let maxDepth = 0;
    try {
      depthByNodeId.forEach((d) => {
        const v = Number(d);
        if (Number.isFinite(v)) maxDepth = Math.max(maxDepth, v);
      });
    } catch (e) {}
    maxDepth = Math.min(3, Math.max(0, maxDepth));

    const ringStep = 160;
    const rings = Array.from({ length: maxDepth }, (_, idx) => (ringStep * (idx + 1)) / Math.max(0.3, globalScale));
    const widths = Array.from({ length: maxDepth }, (_, idx) => (2.1 - idx * 0.35) / Math.max(0.6, globalScale));
    const colors = ['rgba(45,226,230,0.18)', 'rgba(45,226,230,0.12)', 'rgba(45,226,230,0.08)'];

    ctx.save();
    rings.forEach((radius, idx) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
      ctx.lineWidth = widths[idx] || 1;
      ctx.strokeStyle = colors[idx] || colors[colors.length - 1];
      ctx.stroke();
    });
    ctx.restore();
  }, [selectedNode, selectedNodeId, depthByNodeId]);

  // Set up hierarchical positioning
  useEffect(() => {
    try {
      if (!fgRef.current || !visibleNodes.length) return;
    
    // Enhanced force configuration for hierarchical layout
    const simulation = fgRef.current.d3Force;
    if (simulation) {
      if (layout === 'radial') {
        const ringRadius = (node) => {
          return ((node.level || 1) - 1) * 160 + 60;
        };
        simulation('radial', forceRadial(
          ringRadius,
          size.width / 2,
          size.height / 2
        ).strength(0.92));
        simulation('x', null);
        simulation('y', null);
      } else if (layout === 'hierarchical') {
        simulation('radial', null);
        const maxLevel = visibleNodes.reduce((mx, n) => {
          const lvl = Number(n?.level);
          return Number.isFinite(lvl) ? Math.max(mx, Math.max(1, Math.floor(lvl))) : mx;
        }, 1);
        const gap = Math.min(170, Math.max(90, (size.height - 160) / Math.max(1, maxLevel)));
        const top = (size.height / 2) - ((maxLevel - 1) * gap) / 2;
        const yFor = (node) => {
          const lvl = Number(node?.level);
          const safe = Number.isFinite(lvl) ? Math.max(1, Math.floor(lvl)) : 1;
          return top + (safe - 1) * gap;
        };
        simulation('x', forceX(size.width / 2).strength(0.06));
        simulation('y', forceY(yFor).strength(0.34));
      } else {
        simulation('radial', null);
        simulation('x', null);
        simulation('y', null);
      }
      
      simulation('charge', forceManyBody()
        .strength((node) => {
          const baseStrength = -(settingsLayout.forces.repulsion || 300);
          const levelMultiplier = Math.max(0.3, 1 - (node.level || 0) * 0.2);
          return baseStrength * levelMultiplier;
        })
      );
      
      simulation('collision', forceCollide()
        .radius((node) => getNodeSize(node) + 15)
        .strength(0.9)
      );
      
      // Normalize links so d3-force receives node objects as source/target to avoid "node not found" errors
      const idMap = new Map(visibleNodes.map(n => [n.id, n]));
      const normalizedLinks = visibleLinks.map(l => {
        const srcId = typeof l.source === 'object' ? l.source.id : l.source;
        const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
        const srcNode = idMap.get(srcId);
        const tgtNode = idMap.get(tgtId);
        if (!srcNode || !tgtNode) return null; // will be filtered out
        return Object.assign({}, l, { source: srcNode, target: tgtNode });
      }).filter(Boolean);

      simulation('link', forceLink(normalizedLinks)
        .id(d => d.id)
        .distance((link) => {
          const baseDist = settingsLayout.forces.linkDistance || 100;
          const sourceNode = link.source;
          const targetNode = link.target;
          const levelDiff = Math.abs((sourceNode?.level || 1) - (targetNode?.level || 1));
          return baseDist + levelDiff * 60; // Longer links between different levels
        })
        .strength(0.6)
      );
      
      simulation('center', forceCenter(size.width / 2, size.height / 2).strength(settingsLayout.forces.center || 0.05));
    }
    } catch (err) {
      console.error('[graph] layout error', err);
    }
  }, [visibleNodes, visibleLinks, size, getNodeSize, layout, settingsLayout.forces.linkDistance, settingsLayout.forces.repulsion, settingsLayout.forces.center]);

  // Apply lock freezing to locked nodes
  useEffect(() => {
    if (!fgRef.current || !orderedNodes.length) return;
    if (!lockedNodeIds || lockedNodeIds.size === 0) {
      // Unfreeze all nodes if no locks
      orderedNodes.forEach(node => {
        node.fx = undefined;
        node.fy = undefined;
      });
      return;
    }

    // Freeze positions for locked nodes
    orderedNodes.forEach(node => {
      const nodeId = String(node.id || '').trim();
      if (lockedNodeIds.has(nodeId)) {
        // Lock this node at its current position
        if (isFinite(node.x) && isFinite(node.y)) {
          node.fx = node.x;
          node.fy = node.y;
        }
      } else {
        // Unlock this node
        node.fx = undefined;
        node.fy = undefined;
      }
    });
  }, [lockedNodeIds, orderedNodes]);

  // Toolbar actions: zoom in/out, reset home (fit)
  const zoomIn = () => {
    try {
      const fg = fgRef.current;
      if (!fg) return;
  let cur = 1;
      try { cur = fg.zoom(); } catch (e) { /* ignore if not available */ }
      const next = Math.min(6, cur * 1.3);
  suppressAutoFit.current = true;
  fg.zoom(next, 300);
  setTimeout(() => { suppressAutoFit.current = false; }, 350);
    } catch (e) { console.debug('[graph] zoomIn error', e); }
  };

  const zoomOut = () => {
    try {
      const fg = fgRef.current;
      if (!fg) return;
      let cur = 1;
      try { cur = fg.zoom(); } catch (e) { /* ignore */ }
      const next = Math.max(0.2, cur / 1.3);
  suppressAutoFit.current = true;
  fg.zoom(next, 300);
  setTimeout(() => { suppressAutoFit.current = false; }, 350);
    } catch (e) { console.debug('[graph] zoomOut error', e); }
  };

  const goHome = useCallback(() => {
    try {
      manualFit(400, 100, 80);
    } catch (e) { console.debug('[graph] goHome error', e); }
  }, [manualFit]);

  const cycleLabelMode = useCallback(() => {
    setLabelMode((prev) => {
      const cur = String(prev || 'smart');
      if (cur === 'smart') return 'all';
      if (cur === 'all') return 'off';
      return 'smart';
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e) return;
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      const tag = String(target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      const key = String(e.key || '');
      const lower = key.toLowerCase();

      if (lower === 'l') {
        cycleLabelMode();
        e.preventDefault();
        return;
      }
      if (lower === 'f') {
        goHome();
        e.preventDefault();
        return;
      }
      if (lower === 'g') {
        const next = layout === 'radial' ? 'force' : layout === 'force' ? 'hierarchical' : 'radial';
        setLayout(next);
        if (onLayoutChange) onLayoutChange(next);
        e.preventDefault();
        return;
      }

      if (disableLevelSystem) return;

      const isPlus = key === '+' || key === '=' || (key === '=' && e.shiftKey);
      const isMinus = key === '-' || key === '_' || key === '–' || key === '−';
      if (!isPlus && !isMinus) return;

      const maxLevel = maxExistingLevel || 1;
      const cur = Math.max(1, Math.min(maxLevel, maxVisibleLevel ?? 2));
      const next = isPlus ? Math.min(maxLevel, cur + 1) : Math.max(1, cur - 1);
      if (next === cur) return;
      setExpanded(() => new Set());
      setMaxVisibleLevel(next);
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleLabelMode, disableLevelSystem, goHome, layout, maxExistingLevel, maxVisibleLevel, onLayoutChange, setExpanded]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Level controls (placed over graph) */}
      <div className="graph-toolbar">
        <div className="panel">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={zoomIn} title="Zoom in" aria-label="Zoom in">🔍+</button>
            <button onClick={zoomOut} title="Zoom out" aria-label="Zoom out">🔍−</button>
            <button onClick={goHome} title="Fit to view" aria-label="Home">🏠</button>
          </div>

          <div className="sep" />

          {!disableLevelSystem ? <LevelButtons /> : null}

          <div className="sep" />

          <button
            className="wide"
            onClick={cycleLabelMode}
            title="Toggle labels (Smart → All → Off)"
            aria-label="Toggle labels"
          >
            <span className="muted">Labels</span>
            <span className="value">
              {labelMode === 'smart' ? 'Smart' : labelMode === 'all' ? 'All' : 'Off'}
            </span>
          </button>

          <div className="sep" />

          <button
            onClick={() => {
              const next = layout === 'radial' ? 'force' : layout === 'force' ? 'hierarchical' : 'radial';
              setLayout(next);
              if (onLayoutChange) onLayoutChange(next);
            }}
            title="Toggle layout"
          >
            {layout === 'radial' ? 'Radial' : layout === 'force' ? 'Force' : 'Hierarchy'}
          </button>

          <button
            onClick={() => onToggleLock && onToggleLock(!lockLayout)}
            title="Lock layout"
          >
            {lockLayout ? '🔒' : '🔓'}
          </button>

          {/* removed expand/collapse buttons as requested */}
        </div>
      </div>
      <ForceGraph2D
        ref={fgRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        backgroundColor="rgba(0,0,0,0)"
        onRenderFramePre={renderSelectionRings}
        
        // Node styling
        nodeColor={getNodeColor}
        nodeVal={getNodeSize}
        nodeLabel={renderHoverCard}
        
        // Node interactions
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onNodeDragEnd={(node) => {
          if (!node) return;
          node.fx = node.x;
          node.fy = node.y;
          setPinnedNodes(prev => new Set(prev).add(node.id));
        }}
        
        // Link styling
        linkWidth={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          const baseWidth = (function() {
            if (isHighlighted) return 3;
            if (selectedNodeId) {
              const relevant = src === String(selectedNodeId) || tgt === String(selectedNodeId);
              return relevant ? 2 : 1;
            }
            return link.type === 'contains' ? 2.5 : 1;
          })();

          if (!selectedNodeId) return baseWidth;

          const depthA = depthByNodeId.get(src);
          const depthB = depthByNodeId.get(tgt);
          const bucket = Math.min(3, Math.max(depthA ?? 3, depthB ?? 3));
          const factor = bucket === 0 ? 1 : bucket === 1 ? 0.9 : bucket === 2 ? 0.7 : 0.55;
          return baseWidth * factor;
        }}
        
        linkColor={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          let r = 148;
          let g = 163;
          let b = 184;
          let a = link.type === 'contains' ? 0.22 : 0.16;

          if (isHighlighted) {
            r = 45; g = 226; b = 230; a = 1.0;
          } else if (selectedNodeId) {
            const relevant = src === String(selectedNodeId) || tgt === String(selectedNodeId);
            r = 45; g = 226; b = 230; a = relevant ? 0.62 : 0.10;
          } else if (link.type === 'contains') {
            r = 45; g = 226; b = 230; a = 0.32;
          }

          if (selectedNodeId && !isHighlighted) {
            const depthA = depthByNodeId.get(src);
            const depthB = depthByNodeId.get(tgt);
            const bucket = Math.min(3, Math.max(depthA ?? 3, depthB ?? 3));
            const factor = bucket === 0 ? 1 : bucket === 1 ? 0.85 : bucket === 2 ? 0.55 : 0.3;
            a *= factor;
          }

          return `rgba(${r},${g},${b},${a})`;
        }}
        
        linkDirectionalArrowLength={0}
        linkDirectionalArrowRelPos={0.9}
        linkDirectionalArrowColor={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? '#2DE2E6' : 'rgba(96,165,250,0.9)';
        }}
        
        linkDirectionalParticles={2}
        linkDirectionalParticleWidth={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? 4 : 0;
        }}
        linkDirectionalParticleColor={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? '#FFFFFF' : 'rgba(0,0,0,0)';
        }}
        linkDirectionalParticleSpeed={(link) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? 0.012 : 0;
        }}

        linkCanvasObjectMode={() => 'after'}
        linkCanvasObject={(link, ctx) => {
          const src = String(typeof link.source === 'object' ? link.source.id : link.source);
          const tgt = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightPath.includes(src) && highlightPath.includes(tgt);
          
          if (isHighlighted && link.source.x != null && link.target.x != null) {
            // Draw a subtle glow behind the link
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.shadowColor = 'rgba(45, 226, 230, 0.8)';
            ctx.shadowBlur = 15;
            ctx.lineWidth = 6;
            ctx.strokeStyle = 'rgba(45, 226, 230, 0.2)';
            ctx.stroke();
            ctx.restore();
          }
        }}
        
  // Performance optimizations
  cooldownTicks={100}
  onEngineStop={() => { /* disable automatic fit; manualFit handles explicit requests */ }}
        
        // Custom node rendering for better visuals

nodeCanvasObject={(node, ctx, globalScale) => {
  if (node.x === undefined || node.y === undefined || !isFinite(node.x) || !isFinite(node.y)) return;

  const id = String(node.id);
  const isSelected = selectedNodeId && id === String(selectedNodeId);
  const rawDepth = selectedNodeId ? (depthByNodeId.get(id) ?? 99) : 0;
  const depthBucket = selectedNodeId ? Math.min(3, rawDepth) : 0;
  const isHighlighted = highlightedNodes.includes(id);
  const color = getNodeColor(node);
  const hasChildren = !disableLevelSystem && data?.links?.some((l) => {
    if (l.type !== 'contains') return false;
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    return String(src) === String(node.id);
  });
  const canExpand = hasChildren && isExpandableNode(node);
  const isExpanded = expandedNodes.has(node.id);

  const baseRadius = getNodeSize(node);
  const depthScale = !selectedNodeId ? 1 : (depthBucket === 0 ? 1.15 : depthBucket === 1 ? 1 : depthBucket === 2 ? 0.9 : 0.8);
  const nodeRadius = baseRadius * depthScale;

  const alpha = !selectedNodeId ? 0.92 : (depthBucket === 0 ? 1 : depthBucket === 1 ? 0.9 : depthBucket === 2 ? 0.62 : 0.38);
  const finalAlpha = isHighlighted ? 1 : alpha;

  const attackScore = Number(node?.attackScore);
  const attackGlow = node?.attackView
    ? (node.type === 'cluster' ? 0.18 : (Number.isFinite(attackScore) && attackScore >= 90 ? 0.34 : Number.isFinite(attackScore) && attackScore >= 60 ? 0.22 : 0))
    : 0;
  const glowStrength = Math.max(
    isHighlighted ? 0.42 : isSelected ? 0.3 : (depthBucket === 1 ? 0.12 : 0),
    attackGlow
  );
  if (glowStrength > 0) {
    try {
      const glowSize = Math.max(nodeRadius * 3, 26);
      const gradient = ctx.createRadialGradient(node.x, node.y, nodeRadius, node.x, node.y, glowSize);
      const rgb = (function() {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
          const hex = c.slice(1);
          if (hex.length === 3) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            return { r, g, b };
          }
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          return { r, g, b };
        }
        return { r: 45, g: 226, b: 230 };
      })();
      gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${glowStrength})`);
      gradient.addColorStop(0.4, `rgba(${rgb.r},${rgb.g},${rgb.b},${glowStrength * 0.5})`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI, false);
      ctx.fillStyle = gradient;
      ctx.fill();
    } catch (e) {}
  }

  // node body
  ctx.save();
  ctx.globalAlpha = finalAlpha;
  ctx.beginPath();
  ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI, false);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  // outline
  ctx.save();
  ctx.beginPath();
  ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI, false);
  ctx.lineWidth = Math.max(1, 1.8 / Math.max(1, globalScale));
  ctx.strokeStyle = isSelected
    ? 'rgba(45,226,230,0.85)'
    : depthBucket === 1
      ? 'rgba(45,226,230,0.24)'
      : 'rgba(255,255,255,0.06)';
  ctx.stroke();
  ctx.restore();

  const isBookmarked =
    bookmarkedNodeIds instanceof Set
      ? bookmarkedNodeIds.has(id)
      : Array.isArray(bookmarkedNodeIds)
        ? bookmarkedNodeIds.includes(id)
        : false;
  if (isBookmarked) {
    try {
      ctx.save();
      const fs = Math.max(10, 12 / Math.max(0.7, globalScale));
      ctx.font = `${fs}px Inter, Arial`;
      ctx.fillStyle = 'rgba(45,226,230,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ox = node.x + nodeRadius + (10 / Math.max(0.7, globalScale));
      const oy = node.y - nodeRadius - (10 / Math.max(0.7, globalScale));
      ctx.fillText('★', ox, oy);
      ctx.restore();
    } catch (e) {}
  }

  // Draw lock indicator for locked nodes
  const isLocked =
    lockedNodeIds instanceof Set
      ? lockedNodeIds.has(id)
      : Array.isArray(lockedNodeIds)
        ? lockedNodeIds.includes(id)
        : false;
  if (isLocked) {
    try {
      ctx.save();
      const fs = Math.max(10, 12 / Math.max(0.7, globalScale));
      ctx.font = `${fs}px Inter, Arial`;
      ctx.fillStyle = 'rgba(251, 146, 60, 0.92)'; // orange color
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ox = node.x + nodeRadius + (10 / Math.max(0.7, globalScale));
      const oy = node.y + nodeRadius + (10 / Math.max(0.7, globalScale));
      ctx.fillText('🔒', ox, oy);
      ctx.restore();
    } catch (e) {}
  }

  // Hover action cue
  const isHovered = hoverNodeId && id === String(hoverNodeId);
  if (isHovered && !isSelected && canExpand) {
    try {
      const label = isExpanded ? 'Collapse' : 'Expand';
      ctx.save();
      ctx.font = `${Math.max(10, 11 / globalScale)}px Inter, Arial`;
      const tw = ctx.measureText(label).width;
      const padX = 10 / Math.max(0.6, globalScale);
      const padY = 6 / Math.max(0.6, globalScale);
      const w = tw + padX * 2;
      const h = (12 / Math.max(0.6, globalScale)) + padY * 2;
      const x = node.x - w / 2;
      const y = node.y - nodeRadius - h - (10 / Math.max(0.6, globalScale));
      const r = 8 / Math.max(0.6, globalScale);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
      else {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(13, 22, 30, 0.82)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(45,226,230,0.22)';
      ctx.lineWidth = Math.max(1, 1 / Math.max(1, globalScale));
      ctx.stroke();
      ctx.fillStyle = 'rgba(180, 255, 255, 0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, node.x, y + h / 2 + (0.5 / Math.max(1, globalScale)));
      ctx.restore();
    } catch (e) {}
  }

  // Expansion indicator
  if (canExpand) {
    try {
      ctx.save();
      const indicatorR = Math.max(8, nodeRadius * 0.55);
      const ix = node.x + nodeRadius - indicatorR;
      const iy = node.y - nodeRadius + indicatorR;
      ctx.beginPath();
      ctx.arc(ix, iy, indicatorR, 0, 2 * Math.PI, false);
      ctx.fillStyle = isExpanded ? 'rgba(45,226,230,0.8)' : 'rgba(148,163,184,0.5)';
      ctx.fill();
      ctx.fillStyle = 'rgba(2,6,12,0.92)';
      ctx.font = `${Math.max(8, 10 / globalScale)}px Inter, Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isExpanded ? '−' : '+', ix, iy);
      ctx.restore();
    } catch (e) {}
  }

  // === SMART LABEL LOGIC ===
  // Determine if we should show the label based on labelMode and context

  let showLabel = false;

  if (labelMode === "off") {
    showLabel = false;
  } else if (labelMode === "all") {
    // Show all labels, but fade them at extreme zoom-out
    showLabel = globalScale > 0.15;
  } else {
    // "smart" mode - show labels based on node importance and zoom level
    const nodeType = String(node.type || "").toLowerCase();
    const nodeRole = String(node.role || "").toLowerCase();

    // Priority levels for smart label display:
    // 1. Always show: selected, hovered, highlighted, on path
    // 2. Root nodes: show when zoom > 0.2
    // 3. Host/subdomain nodes: show when zoom > 0.35
    // 4. Directory nodes: show when zoom > 0.5
    // 5. Path/file nodes: show when zoom > 0.7
    // 6. Other nodes: show when zoom > 0.9

    const isOnPath = highlightPath.includes(id);

    if (isSelected || isHovered || isHighlighted || isOnPath) {
      showLabel = true;
    } else if (nodeType === "host" && nodeRole === "root") {
      // Root domain - always visible except at extreme zoom-out
      showLabel = globalScale > 0.15;
    } else if (nodeType === "host" || nodeType === "cluster") {
      // Subdomains and clusters - visible at moderate zoom
      showLabel = globalScale > 0.3;
    } else if (nodeType === "dir" || nodeType === "directory") {
      // Directories - visible when zoomed in a bit
      showLabel = globalScale > 0.45;
    } else if (
      nodeType === "path" ||
      nodeType === "file" ||
      nodeType === "endpoint"
    ) {
      // Endpoints/files - only visible when fairly zoomed in
      showLabel = globalScale > 0.65;
    } else if (
      nodeType === "ip" ||
      nodeType === "port" ||
      nodeType === "service"
    ) {
      // Technical nodes - only when very zoomed in
      showLabel = globalScale > 0.8;
    } else {
      // Unknown types - default behavior
      showLabel = globalScale > 0.7;
    }
  }

  // Render the label if needed
  if (showLabel) {
    const label =
      node.label || node.fullLabel || node.value || String(node.id);

    // Adaptive label truncation based on zoom
    let maxLen;
    if (globalScale < 0.3) {
      maxLen = 8;
    } else if (globalScale < 0.5) {
      maxLen = 12;
    } else if (globalScale < 0.8) {
      maxLen = 18;
    } else if (globalScale < 1.2) {
      maxLen = 25;
    } else {
      maxLen = 35;
    }

    const truncated =
      label.length > maxLen ? label.slice(0, maxLen - 1) + "…" : label;

    // Adaptive font size
    const baseFontSize = isSelected ? 12 : isHighlighted ? 11 : 10;
    const fontSize = Math.max(
      8,
      Math.min(14, baseFontSize / Math.max(0.5, globalScale)),
    );

    ctx.font = `${isSelected ? "bold " : ""}${fontSize}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const labelY = node.y + nodeRadius + 3;

    // Text shadow for readability
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillText(truncated, node.x + 0.5, labelY + 0.5);

    // Actual label
    ctx.fillStyle = isSelected
      ? "#ffffff"
      : isHighlighted
        ? "#e0f7fa"
        : isHovered
          ? "#ffffff"
          : "rgba(255,255,255,0.85)";
    ctx.fillText(truncated, node.x, labelY);
  }
}}
      />
      
  {/* legend removed per user request - they already have an external explanation */}
    </div>
  );
};