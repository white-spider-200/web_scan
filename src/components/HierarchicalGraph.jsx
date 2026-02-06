import React, {
  useRef,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from 'react';
import './Graph.css';
import ForceGraph2D from 'react-force-graph-2d';
import {
  forceManyBody,
  forceCollide,
  forceLink,
  forceCenter,
  forceRadial,
  forceX,
  forceY,
} from 'd3-force';
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
  onLayoutChange,
}) => {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const {
    layout: settingsLayout,
    display: settingsDisplay,
    groups: settingsGroups,
  } = useGraphSettings();
  const suppressAutoFit = useRef(false);
  const tooltipCacheRef = useRef(new Map());
  const labelLayoutRef = useRef({ boxes: [] });
  const exportSnapshotRef = useRef({ nodes: [], links: [] });
  const exportFnsRef = useRef({
    getNodeColor: () => '#94A3B8',
    getNodeSize: () => 10,
  });
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
    } catch (e) {
      /* ignore */
    }
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
        <button
          onClick={() => setLevel(cur - 1)}
          disabled={!canDec}
          title="Previous level"
        >
          −
        </button>
        <div
          className="level-display"
          style={{
            minWidth: 110,
            textAlign: 'center',
            padding: '6px 10px',
            borderRadius: 6,
          }}
        >
          Level {cur} / {maxLevel}
        </div>
        <button
          onClick={() => setLevel(cur + 1)}
          disabled={!canInc}
          title="Next level"
        >
          +
        </button>
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
    setExpandedNodes((prev) => {
      const next =
        typeof updater === 'function' ? updater(prev) : new Set(updater);
      // Debug logging to help trace expansion changes
      try {
        console.debug('[graph] setExpanded ->', Array.from(next));
      } catch (e) {}
      try {
        window.dispatchEvent(
          new CustomEvent('graphExpansionChanged', {
            detail: { expanded: Array.from(next) },
          }),
        );
      } catch (e) {}
      try {
        localStorage.setItem('expandedNodes', JSON.stringify(Array.from(next)));
      } catch (e) {}
      return next;
    });
  }, []);

  // Compute node levels and update forces
  useEffect(() => {
    if (!data?.nodes?.length || !fgRef.current) return;

    const root =
      data.nodes.find((n) => n.type === 'host' && n.role === 'root') ||
      data.nodes.find((n) => n.type === 'host');
    if (!root) return;

    // Assign hierarchical levels (prefer explicit node.level when present)
    const newLevels = new Map();
    data.nodes.forEach((node) => {
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
  const expandToNode = useCallback(
    (nodeId) => {
      if (!data || !data.nodes || !data.links) return;

      const nodesToExpand = new Set();
      const findParents = (id) => {
        const parentLinks = data.links.filter((l) => {
          if (l.type !== 'contains') return false;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return String(tgt) === String(id);
        });
        parentLinks.forEach((link) => {
          const src =
            typeof link.source === 'object' ? link.source.id : link.source;
          nodesToExpand.add(src);
          findParents(src);
        });
      };

      findParents(nodeId);
      setExpanded((prev) => new Set([...prev, ...nodesToExpand]));
    },
    [data, setExpanded],
  );

  const manualFit = useCallback(
    (padding = 420, duration = 160, delay = 120) => {
      suppressAutoFit.current = true;
      setTimeout(
        () => {
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
            setTimeout(() => {
              suppressAutoFit.current = false;
            }, duration + 80);
          }
        },
        Math.max(0, delay),
      );
    },
    [],
  );

  // Expose zoom-related helpers globally
  useEffect(() => {
    const expandType = (type) => {
      if (!data || !data.nodes) return;
      const roots = data.nodes.filter((n) => n.type === type).map((n) => n.id);
      setExpanded((prev) => new Set([...prev, ...roots]));
    };

    const expandNode = (nodeId) =>
      setExpanded((prev) => new Set([...prev, nodeId]));
    const collapseNode = (nodeId) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    const toggleNode = (nodeId) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
    const collapseAll = () => setExpanded(() => new Set());
    // Expand immediate children of a node (one level)
    const expandChildren = (nodeId) => {
      if (!data || !data.links) return;
      const children = data.links
        .filter((l) => l.source === nodeId && l.type === 'contains')
        .map((l) => l.target);
      if (!children.length) return;
      setExpanded((prev) => new Set([...prev, ...children]));
    };

    // Recursively expand all descendants of a node
    const expandAllDescendants = (nodeId) => {
      if (!data || !data.links) return;
      const toVisit = [nodeId];
      const all = new Set();
      while (toVisit.length) {
        const cur = toVisit.pop();
        const kids = data.links
          .filter((l) => l.source === cur && l.type === 'contains')
          .map((l) => l.target);
        for (const k of kids) {
          if (!all.has(k)) {
            all.add(k);
            toVisit.push(k);
          }
        }
      }
      setExpanded((prev) => new Set([...prev, ...all]));
    };

    // Expand up to a given hierarchical level (1 = root only). When used we switch to
    // a level-driven visibility mode: getVisibleNodes will return nodes whose level <= given
    // level and ignore the normal expansion set. This prevents accidentally expanding beyond
    // the maximum depth present in the graph.
    const expandToLevel = (level) => {
      // compute integer level
      const lvl = Number.isFinite(Number(level))
        ? Math.max(1, Math.floor(Number(level)))
        : 1;
      // clear manual expansions to avoid conflicting state
      setExpanded(() => new Set());
      setMaxVisibleLevel(lvl);
      try {
        console.debug('[graph] expandToLevel ->', lvl);
      } catch (e) {}
    };

    const clearLevel = () => {
      setMaxVisibleLevel(null);
      try {
        console.debug('[graph] clearLevel');
      } catch (e) {}
    };

    // Shrink (collapse) immediate children of a node
    const shrinkChildren = (nodeId) => {
      if (!data || !data.links) return;
      const children = data.links
        .filter((l) => l.source === nodeId && l.type === 'contains')
        .map((l) => l.target);
      if (!children.length) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        children.forEach((c) => next.delete(c));
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
            return (
              rect.width > 0 && rect.height > 0 && c.style.display !== 'none'
            );
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
        color: (() => {
          try {
            return colorFn(n);
          } catch (e) {
            return '#94A3B8';
          }
        })(),
        radius: (() => {
          try {
            return sizeFn(n);
          } catch (e) {
            return 10;
          }
        })(),
        bookmarked:
          bookmarkedNodeIds instanceof Set
            ? bookmarkedNodeIds.has(String(n.id))
            : Array.isArray(bookmarkedNodeIds)
              ? bookmarkedNodeIds.includes(String(n.id))
              : false,
      }));

      const links = (snap.links || []).map((l) => {
        const src = String(
          typeof l.source === 'object' ? l.source.id : l.source,
        );
        const tgt = String(
          typeof l.target === 'object' ? l.target.id : l.target,
        );
        return { source: src, target: tgt, type: l.type || 'contains' };
      });

      return {
        meta: {
          layout,
          labelMode,
          maxExistingLevel,
          maxVisibleLevel,
        },
        nodes,
        links,
      };
    };

    // Wrap methods to log calls and update debug overlay
    window.graphInstance = {
      expandType: (...a) => {
        try {
          console.debug('[graph] expandType', ...a);
        } catch (e) {}
        return expandType(...a);
      },
      expandNode: (...a) => {
        try {
          console.debug('[graph] expandNode', ...a);
        } catch (e) {}
        return expandNode(...a);
      },
      collapseNode: (...a) => {
        try {
          console.debug('[graph] collapseNode', ...a);
        } catch (e) {}
        return collapseNode(...a);
      },
      toggleNode: (...a) => {
        try {
          console.debug('[graph] toggleNode', ...a);
        } catch (e) {}
        return toggleNode(...a);
      },
      collapseAll: (...a) => {
        try {
          console.debug('[graph] collapseAll', ...a);
        } catch (e) {}
        return collapseAll(...a);
      },
      expandChildren: (...a) => {
        try {
          console.debug('[graph] expandChildren', ...a);
        } catch (e) {}
        return expandChildren(...a);
      },
      expandAllDescendants: (...a) => {
        try {
          console.debug('[graph] expandAllDescendants', ...a);
        } catch (e) {}
        return expandAllDescendants(...a);
      },
      shrinkChildren: (...a) => {
        try {
          console.debug('[graph] shrinkChildren', ...a);
        } catch (e) {}
        return shrinkChildren(...a);
      },
      expandToLevel: (...a) => {
        try {
          console.debug('[graph] expandToLevel', ...a);
        } catch (e) {}
        return expandToLevel(...a);
      },
      clearLevel: (...a) => {
        try {
          console.debug('[graph] clearLevel', ...a);
        } catch (e) {}
        return clearLevel(...a);
      },
      isExpanded: (...a) => {
        try {
          console.debug('[graph] isExpanded', ...a);
        } catch (e) {}
        return isExpanded(...a);
      },
      getExpandedNodes: () => {
        try {
          console.debug('[graph] getExpandedNodes');
        } catch (e) {}
        return Array.from(expandedNodes);
      },
      manualFit: (...a) => {
        try {
          console.debug('[graph] manualFit', ...a);
        } catch (e) {}
        return manualFit(...a);
      },
      getCanvas: () => getCanvasEl(),
      getVisibleGraphData: () => getVisibleGraphData(),
      focusOn: (id, opts = {}) => {
        try {
          console.debug('[graph] focusOn', id, opts);
        } catch (e) {}
        const n = (data?.nodes || []).find((nn) => nn.id === id);
        if (!n) return;
        const { zoom = 1.8, duration = 600 } = opts;
        const inst = fgRef.current;
        if (!inst || !isFinite(n.x) || !isFinite(n.y)) return;
        suppressAutoFit.current = true;
        try {
          inst.centerAt(n.x, n.y, duration);
          inst.zoom(zoom, duration);
        } finally {
          setTimeout(() => {
            suppressAutoFit.current = false;
          }, duration + 60);
        }
      },
      setLayoutPreset: (preset) => {
        if (!preset) return;
        const next = String(preset).toLowerCase();
        try {
          console.debug('[graph] setLayoutPreset', next);
        } catch (e) {}
        setLayout((prev) => (prev === next ? prev : next));
      },
      getLayoutPreset: () => {
        try {
          console.debug('[graph] getLayoutPreset ->', layout);
        } catch (e) {}
        return layout;
      },
    };
  }, [
    data,
    expandToNode,
    manualFit,
    layout,
    expandedNodes,
    labelMode,
    maxVisibleLevel,
    maxExistingLevel,
    bookmarkedNodeIds,
    setExpanded,
  ]);

  const focusOnNode = useCallback(
    (node, { zoom = 1.8, duration = 600, delay = 140, retries = 3 } = {}) => {
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
          setTimeout(() => {
            suppressAutoFit.current = false;
          }, duration + 60);
        }
      };

      setTimeout(() => attempt(retries), Math.max(0, delay));
    },
    [],
  );

  // Filter visible nodes based on hierarchy and expansion state
  const getVisibleNodes = useCallback(() => {
    if (!data || !data.nodes) return [];
    if (disableLevelSystem) {
      return data.nodes.map((n) => {
        n.level = levels.get(n.id) ?? n.level;
        return n;
      });
    }

    // Build parent/child maps from links
    const parentMap = new Map();
    const childMap = new Map();
    (data.links || []).forEach((l) => {
      if (l.type !== 'contains') return;
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      const tgt = typeof l.target === 'object' ? l.target.id : l.target;
      const srcId = String(src);
      const tgtId = String(tgt);
      
      const arr = parentMap.get(tgtId) || [];
      arr.push(srcId);
      parentMap.set(tgtId, arr);
      
      const kids = childMap.get(srcId) || [];
      kids.push(tgtId);
      childMap.set(srcId, kids);
    });

    const visible = new Set();
    
    // If level-driven visibility mode is active, show nodes up to that level only
    if (maxVisibleLevel !== null) {
      data.nodes.forEach((n) => {
        const nodeId = String(n.id);
        const fallbackLevel =
          n.type === 'host' && n.role === 'root'
            ? 1
            : (n.type === 'host' && n.role === 'subdomain') || n.type === 'dir'
              ? 2
              : 3;
        const lvl = levels.get(n.id) ?? fallbackLevel;
        if (lvl <= maxVisibleLevel) visible.add(nodeId);
      });

      // Branch expansion: when a node is expanded, reveal its immediate children
      // Use a queue to handle nested expansions
      const processExpansion = () => {
        let changed = true;
        let iterations = 0;
        const maxIterations = 100; // Safety limit
        
        while (changed && iterations < maxIterations) {
          changed = false;
          iterations++;
          
          expandedNodes.forEach((expandedId) => {
            const eid = String(expandedId);
            // Only process if the expanded node is visible
            if (!visible.has(eid)) return;
            
            const children = childMap.get(eid) || [];
            children.forEach((childId) => {
              const cid = String(childId);
              if (!visible.has(cid)) {
                visible.add(cid);
                changed = true;
              }
            });
          });
        }
      };
      
      processExpansion();
    } else {
      // No level mode - show root and handle expansions manually
      const root =
        data.nodes.find((n) => n.type === 'host' && n.role === 'root') ||
        data.nodes.find((n) => n.type === 'host');
      
      if (root) {
        visible.add(String(root.id));
        
        // Show immediate children of root (subdomains)
        const rootChildren = childMap.get(String(root.id)) || [];
        rootChildren.forEach((childId) => {
          const childNode = data.nodes.find((nn) => String(nn.id) === String(childId));
          if (childNode && childNode.type === 'host' && childNode.role === 'subdomain') {
            visible.add(String(childId));
          }
        });
      }
      
      // Process all expanded nodes and show their children
      const processExpansion = () => {
        let changed = true;
        let iterations = 0;
        const maxIterations = 100;
        
        while (changed && iterations < maxIterations) {
          changed = false;
          iterations++;
          
          expandedNodes.forEach((expandedId) => {
            const eid = String(expandedId);
            if (!visible.has(eid)) return;
            
            const children = childMap.get(eid) || [];
            children.forEach((childId) => {
              const cid = String(childId);
              if (!visible.has(cid)) {
                visible.add(cid);
                changed = true;
              }
            });
          });
        }
      };
      
      processExpansion();
    }

    // Build resulting visible nodes array and add simple level hints
    const visibleNodes = [];
    data.nodes.forEach((n) => {
      if (visible.has(String(n.id))) {
        n.level = levels.get(n.id) ?? n.level;
        visibleNodes.push(n);
      }
    });

    return visibleNodes;
  }, [data, expandedNodes, levels, maxVisibleLevel, disableLevelSystem]);

// ...existing code...

  // Handle node click:
  // - Click expandable nodes => expand/collapse (no auto-zoom, no details fetch)
  // - Shift+click (or leaf nodes) => focus + show details
  // - Cluster nodes => delegate to parent (no auto-zoom)



  // Get visible links based on visible nodes
  const getVisibleLinks = useCallback(
    (visibleNodes) => {
      if (!data || !data.links) return [];

      const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
      return data.links.filter((l) => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
      });
    },
    [data],
  );

  // Color mapping aligned with Web Recon Map UI:
  // Subdomains: blue, Directories: yellow, Endpoints: red, IPs: orange, Accent: teal/cyan.
  const getNodeColor = useCallback(
    (node) => {
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
          if (
            String(node.label || '')
              .toLowerCase()
              .includes(q)
          )
            return group.color;
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
            attack_subdomains: '#60A5FA',
          };
          return map[ct] || '#A855F7';
        }
        return '#A855F7';
      }
      if (node.type === 'host' && node.role === 'root') return '#2DE2E6';
      if (node.type === 'host' && node.role === 'subdomain') return '#3B82F6';

      const colors = {
        dir: '#FBBF24', // Yellow - directory
        path: '#EF4444', // Red - endpoint
        file: '#EF4444', // Red - endpoint
        ip: '#FB923C', // Orange - IP
        port: '#7C3AED',
        service: '#0891B2',
      };

      return colors[node.type] || '#94A3B8';
    },
    [settingsGroups],
  );

  // Get node size based on type and expansion state
  const getNodeSize = useCallback(
    (node) => {
      // Basic fixed sizing if requested
      if (settingsDisplay.nodeSize === 'fixed') {
        const isRoot = node.role === 'root';
        const base = isRoot ? 12 : 6;
        return (
          base *
          (expandedNodes.has(node.id) ? 1.2 : 1) *
          (highlightedNodes.includes(String(node.id)) ? 1.3 : 1)
        );
      }

      const baseSizes = {
        host: node.role === 'root' ? 25 : 18,
        dir: 14,
        path: 12,
        file: 12,
        ip: 12,
        cluster: node?.attackView ? 22 : 18,
        port: 10,
        service: 10,
      };

      const baseSize = baseSizes[node.type] || 10;
      const countBoost = node?.count
        ? Math.min(18, Math.log2(node.count + 1) * 4)
        : 0;
      const attackScore = Number(node?.attackScore);
      let attackBoost =
        node?.attackView && Number.isFinite(attackScore) && attackScore > 0
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
      const highlightMultiplier = highlightedNodes.includes(String(node.id))
        ? 1.3
        : 1;

      return (
        (baseSize + countBoost + attackBoost) *
        expandedMultiplier *
        highlightMultiplier
      );
    },
    [expandedNodes, highlightedNodes, settingsDisplay.nodeSize],
  );

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


 
  const handleNodeHover = useCallback(
    (node) => {
      setHoverNodeId(node?.id || null);
      const inst = fgRef.current;
      if (!inst) return;

      // Always freeze all nodes when hovering ANY node to prevent movement
      if (node) {
        // Stop simulation completely
        try {
          const sim = inst.d3Simulation?.();
          if (sim) {
            sim.stop();
            sim.alpha(0);
          }
        } catch (e) {}

        // Fix ALL node positions
        try {
          const graphData = inst.graphData();
          if (graphData && graphData.nodes) {
            graphData.nodes.forEach((n) => {
              if (isFinite(n.x) && isFinite(n.y)) {
                n.fx = n.x;
                n.fy = n.y;
                n.vx = 0;
                n.vy = 0;
              }
            });
          }
        } catch (e) {}
      } else {
        // Only resume if NOT locked
        if (!lockLayout && !settingsLayout?.isFrozen) {
          // Unfreeze nodes that aren't explicitly locked
          try {
            const graphData = inst.graphData();
            if (graphData && graphData.nodes) {
              graphData.nodes.forEach((n) => {
                const nodeId = String(n.id || '').trim();
                const isUserLocked =
                  lockedNodeIds instanceof Set
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

          // Restart with VERY low energy
          try {
            const sim = inst.d3Simulation?.();
            if (sim) {
              sim.alpha(0.05);
              sim.alphaDecay(0.05); // Faster decay = stops sooner
              sim.restart();
            }
          } catch (e) {}
        }
      }
    },
    [lockLayout, lockedNodeIds, settingsLayout?.isFrozen],
  );

  // Handle node click:
  // - Click expandable nodes => expand/collapse (no auto-zoom, no details fetch)
  // - Shift+click (or leaf nodes) => focus + show details
  // - Cluster nodes => delegate to parent (no auto-zoom)
  const handleNodeClick = useCallback(
    (node, event) => {
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
      if (
        !disableLevelSystem &&
        hasChildren &&
        isExpandableNode(node) &&
        !wantsDetails
      ) {
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
              const tgt =
                typeof link.target === 'object' ? link.target.id : link.target;
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
    },
    [
      data,
      disableLevelSystem,
      expandToNode,
      focusOnNode,
      isExpandableNode,
      onNodeClick,
      setExpanded,
    ],
  );

  const parseUrlParts = useCallback((fullLabel, node) => {
    const empty = {
      protocol: '',
      hostname: node?.hostname || '',
      pathname: '',
      filename: '',
      extension: '',
      query: '',
      fragment: '',
      depth: 0,
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
        depth: parts.length,
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
      depth: parts.length,
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

  const renderHoverCard = useCallback(
    (node) => {
      if (!node) return '';
      const key = `${node.id}:${node.fullLabel || node.value || ''}:${String(selectedNodeId || '')}:${disableLevelSystem ? 'd' : 'l'}:${expandedNodes.has(node.id) ? '1' : '0'}`;
      const cached = tooltipCacheRef.current.get(key);
      if (cached) return cached;

      const parts = parseUrlParts(node.fullLabel || node.value || '', node);
      const header = String(node.label || node.id || '').trim();
      const headerText =
        header.length > 28 ? `${header.slice(0, 28)}…` : header;
      const typeLabel =
        node.type === 'host'
          ? 'Host'
          : node.type === 'ip'
            ? 'IP'
            : node.type === 'dir'
              ? 'Dir'
              : node.type === 'file'
                ? 'File'
                : node.type === 'cluster'
                  ? 'Cluster'
                  : 'Path';
      const extText = parts.extension ? parts.extension : '—';
      const hostText = parts.hostname || '—';
      const pathText = parts.pathname || '/';
      const normalizedText =
        parts.protocol && parts.hostname
          ? `${parts.protocol}://${parts.hostname}${parts.pathname}${parts.query ? `?${parts.query}` : ''}${parts.fragment ? `#${parts.fragment}` : ''}`
          : '';
      const hasChildren = data?.links?.some((l) => {
        if (l.type !== 'contains') return false;
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        return String(src) === String(node.id);
      });
      const canExpand =
        hasChildren && !disableLevelSystem && isExpandableNode(node);
      const isSelected =
        selectedNodeId && String(node.id) === String(selectedNodeId);
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
        ${
          normalizedText
            ? `<div style="color:#94A3B8;">Normalized</div>
        <div style="color:#E2E8F0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; word-break:break-all; user-select:text;">${escapeHtml(normalizedText)}</div>`
            : ''
        }
      </div>
    </div>`;
      tooltipCacheRef.current.set(key, html);
      return html;
    },
    [
      data,
      disableLevelSystem,
      escapeHtml,
      expandedNodes,
      getNodeColor,
      isExpandableNode,
      parseUrlParts,
      selectedNodeId,
    ],
  );

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resize = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(400, Math.floor(rect.width)),
        height: Math.max(300, Math.floor(rect.height)),
      });
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  // Auto-focus on root node when graph first loads
  useEffect(() => {
    if (!data?.nodes?.length || !fgRef.current) return;

    // Find the root node
    const root =
      data.nodes.find((n) => n.type === 'host' && n.role === 'root') ||
      data.nodes.find((n) => n.type === 'host');
    if (!root) return;

    // Delay to allow graph to initialize and settle
    const timer = setTimeout(() => {
      manualFit(400, 200, 0);
    }, 600);

    return () => clearTimeout(timer);
  }, [data?.nodes?.length, manualFit]);

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
  }, [
    visibleNodes,
    selectedNodeId,
    hoverNodeId,
    highlightedNodes,
    highlightPath,
  ]);

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
      const src = String(
        typeof link.source === 'object' ? link.source.id : link.source,
      );
      const tgt = String(
        typeof link.target === 'object' ? link.target.id : link.target,
      );
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

  const renderSelectionRings = useCallback(
    (ctx, globalScale) => {
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
      const rings = Array.from(
        { length: maxDepth },
        (_, idx) => (ringStep * (idx + 1)) / Math.max(0.3, globalScale),
      );
      const widths = Array.from(
        { length: maxDepth },
        (_, idx) => (2.1 - idx * 0.35) / Math.max(0.6, globalScale),
      );
      const colors = [
        'rgba(45,226,230,0.18)',
        'rgba(45,226,230,0.12)',
        'rgba(45,226,230,0.08)',
      ];

      ctx.save();
      rings.forEach((radius, idx) => {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
        ctx.lineWidth = widths[idx] || 1;
        ctx.strokeStyle = colors[idx] || colors[colors.length - 1];
        ctx.stroke();
      });
      ctx.restore();
    },
    [selectedNode, selectedNodeId, depthByNodeId],
  );


  // Set up hierarchical positioning with MUCH weaker forces
  useEffect(() => {
    try {
      if (!fgRef.current || !visibleNodes.length) return;

      const simulation = fgRef.current.d3Force;
      if (simulation) {
        if (layout === 'radial') {
          const ringRadius = (node) => {
            return ((node.level || 1) - 1) * 160 + 60;
          };
          simulation(
            'radial',
            forceRadial(ringRadius, size.width / 2, size.height / 2).strength(
              0.3, // REDUCED from 0.92
            ),
          );
          simulation('x', null);
          simulation('y', null);
        } else if (layout === 'hierarchical') {
          simulation('radial', null);
          const maxLevel = visibleNodes.reduce((mx, n) => {
            const lvl = Number(n?.level);
            return Number.isFinite(lvl)
              ? Math.max(mx, Math.max(1, Math.floor(lvl)))
              : mx;
          }, 1);
          const gap = Math.min(
            170,
            Math.max(90, (size.height - 160) / Math.max(1, maxLevel)),
          );
          const top = size.height / 2 - ((maxLevel - 1) * gap) / 2;
          const yFor = (node) => {
            const lvl = Number(node?.level);
            const safe = Number.isFinite(lvl)
              ? Math.max(1, Math.floor(lvl))
              : 1;
            return top + (safe - 1) * gap;
          };
          simulation('x', forceX(size.width / 2).strength(0.02)); // REDUCED from 0.06
          simulation('y', forceY(yFor).strength(0.1)); // REDUCED from 0.34
        } else {
          simulation('radial', null);
          simulation('x', null);
          simulation('y', null);
        }

        // MUCH weaker charge to reduce pulling
        simulation(
          'charge',
          forceManyBody().strength((node) => {
            const baseStrength = -80; // REDUCED from -300
            const levelMultiplier = Math.max(0.3, 1 - (node.level || 0) * 0.2);
            return baseStrength * levelMultiplier;
          }),
        );

        // Weaker collision
        simulation(
          'collision',
          forceCollide()
            .radius((node) => getNodeSize(node) + 8) // REDUCED from +15
            .strength(0.4), // REDUCED from 0.9
        );

        // Normalize links
        const idMap = new Map(visibleNodes.map((n) => [n.id, n]));
        const normalizedLinks = visibleLinks
          .map((l) => {
            const srcId = typeof l.source === 'object' ? l.source.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
            const srcNode = idMap.get(srcId);
            const tgtNode = idMap.get(tgtId);
            if (!srcNode || !tgtNode) return null;
            return Object.assign({}, l, { source: srcNode, target: tgtNode });
          })
          .filter(Boolean);

        // MUCH weaker link force
        simulation(
          'link',
          forceLink(normalizedLinks)
            .id((d) => d.id)
            .distance((link) => {
              const baseDist = settingsLayout.forces.linkDistance || 100;
              const sourceNode = link.source;
              const targetNode = link.target;
              const levelDiff = Math.abs(
                (sourceNode?.level || 1) - (targetNode?.level || 1),
              );
              return baseDist + levelDiff * 60;
            })
            .strength(0.15), // REDUCED from 0.6
        );

        // Weaker center force
        simulation(
          'center',
          forceCenter(size.width / 2, size.height / 2).strength(0.01), // REDUCED from 0.05
        );

        // Configure simulation to settle quickly
        try {
          const sim = fgRef.current.d3Simulation?.();
          if (sim) {
            sim.alphaDecay(0.03); // Faster decay = settles faster
            sim.velocityDecay(0.6); // More friction = less movement
          }
        } catch (e) {}
      }
    } catch (err) {
      console.error('[graph] layout error', err);
    }
  }, [
    visibleNodes,
    visibleLinks,
    size,
    getNodeSize,
    layout,
    settingsLayout.forces.linkDistance,
    settingsLayout.forces.repulsion,
    settingsLayout.forces.center,
  ]);

  // Apply lock freezing to locked nodes
  useEffect(() => {
    if (!fgRef.current || !orderedNodes.length) return;
    if (!lockedNodeIds || lockedNodeIds.size === 0) {
      // Unfreeze all nodes if no locks
      orderedNodes.forEach((node) => {
        node.fx = undefined;
        node.fy = undefined;
      });
      return;
    }

    // Freeze positions for locked nodes
    orderedNodes.forEach((node) => {
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
      try {
        cur = fg.zoom();
      } catch (e) {
        /* ignore if not available */
      }
      const next = Math.min(6, cur * 1.3);
      suppressAutoFit.current = true;
      fg.zoom(next, 300);
      setTimeout(() => {
        suppressAutoFit.current = false;
      }, 350);
    } catch (e) {
      console.debug('[graph] zoomIn error', e);
    }
  };

  const zoomOut = () => {
    try {
      const fg = fgRef.current;
      if (!fg) return;
      let cur = 1;
      try {
        cur = fg.zoom();
      } catch (e) {
        /* ignore */
      }
      const next = Math.max(0.2, cur / 1.3);
      suppressAutoFit.current = true;
      fg.zoom(next, 300);
      setTimeout(() => {
        suppressAutoFit.current = false;
      }, 350);
    } catch (e) {
      console.debug('[graph] zoomOut error', e);
    }
  };

  const goHome = useCallback(() => {
    try {
      manualFit(400, 100, 80);
    } catch (e) {
      console.debug('[graph] goHome error', e);
    }
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
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable)
        return;

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
        const next =
          layout === 'radial'
            ? 'force'
            : layout === 'force'
              ? 'hierarchical'
              : 'radial';
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
  }, [
    cycleLabelMode,
    disableLevelSystem,
    goHome,
    layout,
    maxExistingLevel,
    maxVisibleLevel,
    onLayoutChange,
    setExpanded,
  ]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {/* Level controls (placed over graph) */}
      <div className="graph-toolbar">
        <div className="panel">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={zoomIn} title="Zoom in" aria-label="Zoom in">
              🔍+
            </button>
            <button onClick={zoomOut} title="Zoom out" aria-label="Zoom out">
              🔍−
            </button>
            <button onClick={goHome} title="Fit to view" aria-label="Home">
              🏠
            </button>
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
              {labelMode === 'smart'
                ? 'Smart'
                : labelMode === 'all'
                  ? 'All'
                  : 'Off'}
            </span>
          </button>

          <div className="sep" />

          <button
            onClick={() => {
              const next =
                layout === 'radial'
                  ? 'force'
                  : layout === 'force'
                    ? 'hierarchical'
                    : 'radial';
              setLayout(next);
              if (onLayoutChange) onLayoutChange(next);
            }}
            title="Toggle layout"
          >
            {layout === 'radial'
              ? 'Radial'
              : layout === 'force'
                ? 'Force'
                : 'Hierarchy'}
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
          
          // Always pin the dragged node where it was dropped
          node.fx = node.x;
          node.fy = node.y;
          node.vx = 0;
          node.vy = 0;
          
          // Stop simulation briefly to prevent other nodes from jumping
          try {
            const sim = fgRef.current?.d3Simulation?.();
            if (sim) {
              sim.alpha(0);
              sim.stop();
            }
          } catch (e) {}
          
          // Freeze all other nodes momentarily
          try {
            const graphData = fgRef.current?.graphData();
            if (graphData && graphData.nodes) {
              graphData.nodes.forEach((n) => {
                if (isFinite(n.x) && isFinite(n.y)) {
                  n.vx = 0;
                  n.vy = 0;
                }
              });
            }
          } catch (e) {}
          
          setPinnedNodes((prev) => new Set(prev).add(node.id));
          
          // If not locked, restart with minimal energy after a delay
          if (!lockLayout && !settingsLayout?.isFrozen) {
            setTimeout(() => {
              try {
                const sim = fgRef.current?.d3Simulation?.();
                if (sim) {
                  sim.alpha(0.02); // Very low energy
                  sim.restart();
                }
              } catch (e) {}
            }, 300);
          }
        }}
        // Link styling
        linkWidth={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          const baseWidth = (function () {
            if (isHighlighted) return 3;
            if (selectedNodeId) {
              const relevant =
                src === String(selectedNodeId) ||
                tgt === String(selectedNodeId);
              return relevant ? 2 : 1;
            }
            return link.type === 'contains' ? 2.5 : 1;
          })();

          if (!selectedNodeId) return baseWidth;

          const depthA = depthByNodeId.get(src);
          const depthB = depthByNodeId.get(tgt);
          const bucket = Math.min(3, Math.max(depthA ?? 3, depthB ?? 3));
          const factor =
            bucket === 0 ? 1 : bucket === 1 ? 0.9 : bucket === 2 ? 0.7 : 0.55;
          return baseWidth * factor;
        }}
        linkColor={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          let r = 148;
          let g = 163;
          let b = 184;
          let a = link.type === 'contains' ? 0.22 : 0.16;

          if (isHighlighted) {
            r = 45;
            g = 226;
            b = 230;
            a = 1.0;
          } else if (selectedNodeId) {
            const relevant =
              src === String(selectedNodeId) || tgt === String(selectedNodeId);
            r = 45;
            g = 226;
            b = 230;
            a = relevant ? 0.62 : 0.1;
          } else if (link.type === 'contains') {
            r = 45;
            g = 226;
            b = 230;
            a = 0.32;
          }

          if (selectedNodeId && !isHighlighted) {
            const depthA = depthByNodeId.get(src);
            const depthB = depthByNodeId.get(tgt);
            const bucket = Math.min(3, Math.max(depthA ?? 3, depthB ?? 3));
            const factor =
              bucket === 0
                ? 1
                : bucket === 1
                  ? 0.85
                  : bucket === 2
                    ? 0.55
                    : 0.3;
            a *= factor;
          }

          return `rgba(${r},${g},${b},${a})`;
        }}
        linkDirectionalArrowLength={0}
        linkDirectionalArrowRelPos={0.9}
        linkDirectionalArrowColor={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? '#2DE2E6' : 'rgba(96,165,250,0.9)';
        }}
        linkDirectionalParticles={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? 3 : 0;
        }}
        linkDirectionalParticleWidth={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? 4 : 0;
        }}
        linkDirectionalParticleColor={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? '#FFFFFF' : 'rgba(0,0,0,0)';
        }}
        linkDirectionalParticleSpeed={(link) => {
          const src = String(
            typeof link.source === 'object' ? link.source.id : link.source,
          );
          const tgt = String(
            typeof link.target === 'object' ? link.target.id : link.target,
          );
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          return isHighlighted ? 0.008 : 0;
        }}
        // Use canvas mode for custom link rendering


        // Use canvas mode for custom link rendering
        linkCanvasObjectMode={() => 'replace'}
        linkCanvasObject={(link, ctx, globalScale) => {
          const sourceNode =
            typeof link.source === 'object' ? link.source : null;
          const targetNode =
            typeof link.target === 'object' ? link.target : null;

          if (!sourceNode || !targetNode) return;
          if (
            !isFinite(sourceNode.x) ||
            !isFinite(sourceNode.y) ||
            !isFinite(targetNode.x) ||
            !isFinite(targetNode.y)
          )
            return;

          const src = String(sourceNode.id);
          const tgt = String(targetNode.id);
          const isHighlighted =
            highlightPath.includes(src) && highlightPath.includes(tgt);
          const isSelectedLink =
            selectedNodeId &&
            (src === String(selectedNodeId) || tgt === String(selectedNodeId));
          const isHoveredLink =
            hoverNodeId &&
            (src === String(hoverNodeId) || tgt === String(hoverNodeId));

          // Get child node color (target node in contains relationship)
          const childNode = link.type === 'contains' ? targetNode : targetNode;
          const childColor = getNodeColor(childNode);

          // Parse color to RGB
          const parseColor = (c) => {
            const str = String(c || '').trim();
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str)) {
              const hex = str.slice(1);
              if (hex.length === 3) {
                return {
                  r: parseInt(hex[0] + hex[0], 16),
                  g: parseInt(hex[1] + hex[1], 16),
                  b: parseInt(hex[2] + hex[2], 16),
                };
              }
              return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
              };
            }
            return { r: 148, g: 163, b: 184 }; // default gray
          };

          const rgb = parseColor(childColor);

          // Calculate link properties based on state
          // LIGHTER BASE - reduced alpha values
          let baseWidth = link.type === 'contains' ? 2.5 : 1.8;
          let alpha = link.type === 'contains' ? 0.35 : 0.25;

          if (isHighlighted) {
            baseWidth = 5;
            alpha = 0.9;
          } else if (isHoveredLink) {
            baseWidth = 4;
            alpha = 0.75;
          } else if (isSelectedLink) {
            baseWidth = 3.5;
            alpha = 0.6;
          }

          // Depth-based fade when a node is selected
          if (
            selectedNodeId &&
            !isHighlighted &&
            !isHoveredLink &&
            !isSelectedLink
          ) {
            const depthA = depthByNodeId.get(src);
            const depthB = depthByNodeId.get(tgt);
            const maxDepth = Math.max(depthA ?? 3, depthB ?? 3);
            const bucket = Math.min(3, maxDepth);
            const factor =
              bucket === 0
                ? 1
                : bucket === 1
                  ? 0.7
                  : bucket === 2
                    ? 0.45
                    : 0.25;
            alpha *= factor;
            baseWidth *= Math.max(0.6, factor);
          }

          const lineWidth = baseWidth / Math.max(0.5, globalScale);

          // Calculate start and end points (slightly inside nodes)
          const dx = targetNode.x - sourceNode.x;
          const dy = targetNode.y - sourceNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) return;

          const sourceRadius = getNodeSize(sourceNode) * 0.8;
          const targetRadius = getNodeSize(targetNode) * 0.8;

          const startX = sourceNode.x + (dx / dist) * sourceRadius;
          const startY = sourceNode.y + (dy / dist) * sourceRadius;
          const endX = targetNode.x - (dx / dist) * targetRadius;
          const endY = targetNode.y - (dy / dist) * targetRadius;

          ctx.save();

          // === GLOW EFFECT - LIGHTER ===
          const glowAlpha = isHighlighted
            ? 0.35
            : isHoveredLink
              ? 0.3
              : isSelectedLink
                ? 0.2
                : 0.08;
          const glowWidth = isHighlighted
            ? 3
            : isHoveredLink
              ? 2.5
              : isSelectedLink
                ? 2
                : 1.2;

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`;
          ctx.lineWidth = lineWidth + glowWidth / Math.max(0.5, globalScale);
          ctx.lineCap = 'round';
          ctx.stroke();

          // === GRADIENT LINE FROM PARENT TO CHILD - LIGHTER ===
          const gradient = ctx.createLinearGradient(startX, startY, endX, endY);

          if (isHighlighted) {
            // Bright cyan gradient for highlighted paths
            gradient.addColorStop(0, `rgba(45, 226, 230, ${alpha})`);
            gradient.addColorStop(
              0.5,
              `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`,
            );
            gradient.addColorStop(
              1,
              `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`,
            );
          } else {
            // Lighter colorful gradient from source color blend to child color
            const sourceColor = getNodeColor(sourceNode);
            const srcRgb = parseColor(sourceColor);

            // Blend from source color to child color with reduced alpha
            gradient.addColorStop(
              0,
              `rgba(${srcRgb.r}, ${srcRgb.g}, ${srcRgb.b}, ${alpha * 0.6})`,
            );
            gradient.addColorStop(
              0.4,
              `rgba(${Math.floor((srcRgb.r + rgb.r) / 2)}, ${Math.floor((srcRgb.g + rgb.g) / 2)}, ${Math.floor((srcRgb.b + rgb.b) / 2)}, ${alpha * 0.7})`,
            );
            gradient.addColorStop(
              1,
              `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha * 0.8})`,
            );
          }

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = gradient;
          ctx.lineWidth = lineWidth;
          ctx.lineCap = 'round';
          ctx.stroke();

          // === INNER BRIGHT LINE FOR DEPTH (only on interaction) ===
          if (isHoveredLink || isHighlighted || isSelectedLink) {
            const innerGradient = ctx.createLinearGradient(
              startX,
              startY,
              endX,
              endY,
            );
            innerGradient.addColorStop(
              0,
              `rgba(255, 255, 255, ${alpha * 0.3})`,
            );
            innerGradient.addColorStop(
              0.5,
              `rgba(255, 255, 255, ${alpha * 0.15})`,
            );
            innerGradient.addColorStop(
              1,
              `rgba(255, 255, 255, ${alpha * 0.3})`,
            );

            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.strokeStyle = innerGradient;
            ctx.lineWidth = lineWidth * 0.25;
            ctx.lineCap = 'round';
            ctx.stroke();
          }

          // === DOTTED PATTERN FOR NON-CONTAINS LINKS ===
          if (link.type !== 'contains' && !isHighlighted) {
            ctx.setLineDash([6 / globalScale, 4 / globalScale]);
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.2})`;
            ctx.lineWidth = lineWidth * 0.3;
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // === FLOW DOTS FOR HIGHLIGHTED/HOVERED LINKS ===
          if (isHighlighted || isHoveredLink) {
            const time = Date.now() * 0.002;
            const numDots = isHighlighted ? 4 : 3;

            for (let i = 0; i < numDots; i++) {
              const t = (time + i / numDots) % 1;
              const dotX = startX + (endX - startX) * t;
              const dotY = startY + (endY - startY) * t;
              const dotSize =
                (3 + Math.sin(t * Math.PI) * 1.5) / Math.max(0.5, globalScale);

              const dotGradient = ctx.createRadialGradient(
                dotX,
                dotY,
                0,
                dotX,
                dotY,
                dotSize,
              );
              dotGradient.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
              dotGradient.addColorStop(
                0.4,
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`,
              );
              dotGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

              ctx.beginPath();
              ctx.arc(dotX, dotY, dotSize, 0, 2 * Math.PI);
              ctx.fillStyle = dotGradient;
              ctx.fill();
            }
          }

          // === ARROW HEAD AT TARGET (smaller, lighter) ===
          if (dist > 30) {
            const arrowSize =
              isHoveredLink || isHighlighted
                ? Math.max(6, 8 / Math.max(0.5, globalScale))
                : Math.max(4, 5 / Math.max(0.5, globalScale));
            const angle = Math.atan2(dy, dx);

            const arrowX = endX;
            const arrowY = endY;

            ctx.beginPath();
            ctx.moveTo(arrowX, arrowY);
            ctx.lineTo(
              arrowX - arrowSize * Math.cos(angle - Math.PI / 7),
              arrowY - arrowSize * Math.sin(angle - Math.PI / 7),
            );
            ctx.lineTo(
              arrowX - arrowSize * Math.cos(angle + Math.PI / 7),
              arrowY - arrowSize * Math.sin(angle + Math.PI / 7),
            );
            ctx.closePath();
            ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha * 0.7})`;
            ctx.fill();
          }

          ctx.restore();
        }}
        // Performance optimizations
        cooldownTicks={100}
        onEngineStop={() => {
          /* disable automatic fit; manualFit handles explicit requests */
        }}
        // Custom node rendering for better visuals

        nodeCanvasObject={(node, ctx, globalScale) => {
          if (
            node.x === undefined ||
            node.y === undefined ||
            !isFinite(node.x) ||
            !isFinite(node.y)
          )
            return;

          const id = String(node.id);
          const isSelected = selectedNodeId && id === String(selectedNodeId);
          const rawDepth = selectedNodeId ? (depthByNodeId.get(id) ?? 99) : 0;
          const depthBucket = selectedNodeId ? Math.min(3, rawDepth) : 0;
          const isHighlighted = highlightedNodes.includes(id);
          const isHovered = hoverNodeId && id === String(hoverNodeId);
          const isOnPath = highlightPath.includes(id);
          const color = getNodeColor(node);

          const hasChildren =
            !disableLevelSystem &&
            data?.links?.some((l) => {
              if (l.type !== 'contains') return false;
              const src = typeof l.source === 'object' ? l.source.id : l.source;
              return String(src) === String(node.id);
            });
          const canExpand = hasChildren && isExpandableNode(node);
          const isExpanded = expandedNodes.has(node.id);

          // Parse color to RGB for glow effects
          const parseColor = (c) => {
            const str = String(c || '').trim();
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str)) {
              const hex = str.slice(1);
              if (hex.length === 3) {
                return {
                  r: parseInt(hex[0] + hex[0], 16),
                  g: parseInt(hex[1] + hex[1], 16),
                  b: parseInt(hex[2] + hex[2], 16),
                };
              }
              return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
              };
            }
            return { r: 45, g: 226, b: 230 }; // default cyan
          };

          const rgb = parseColor(color);

          // === ADAPTIVE SIZING BASED ON ZOOM ===
          const baseRadius = getNodeSize(node);
          const depthScale = !selectedNodeId
            ? 1
            : depthBucket === 0
              ? 1.15
              : depthBucket === 1
                ? 1
                : depthBucket === 2
                  ? 0.9
                  : 0.8;

          // Make nodes slightly larger when zoomed out for better visibility
          const zoomCompensation =
            globalScale < 0.5 ? 1 + (0.5 - globalScale) * 0.5 : 1;
          const nodeRadius = baseRadius * depthScale * zoomCompensation;

          // === BLOOM/GLOW INTENSITY BASED ON ZOOM AND STATE ===
          // More glow when zoomed out to create "bloom" effect
          const zoomGlowBoost =
            globalScale < 0.6 ? (0.6 - globalScale) * 1.5 : 0;

          // Base glow based on node importance
          let baseGlow = 0.15; // All nodes have subtle glow
          if (node.type === 'host' && node.role === 'root') baseGlow = 0.4;
          else if (node.type === 'host') baseGlow = 0.3;
          else if (node.type === 'cluster') baseGlow = 0.35;
          else if (node.type === 'dir') baseGlow = 0.2;

          // State-based glow boost
          const stateGlow = isSelected
            ? 0.5
            : isHovered
              ? 0.45
              : isHighlighted
                ? 0.4
                : isOnPath
                  ? 0.35
                  : 0;

          // Attack score glow
          const attackScore = Number(node?.attackScore);
          const attackGlow =
            node?.attackView && Number.isFinite(attackScore)
              ? attackScore >= 90
                ? 0.4
                : attackScore >= 60
                  ? 0.25
                  : attackScore >= 30
                    ? 0.15
                    : 0
              : 0;

          const totalGlow = Math.min(
            0.8,
            baseGlow + stateGlow + attackGlow + zoomGlowBoost,
          );

          // === OUTER BLOOM (visible when zoomed out) ===
          if (totalGlow > 0.1) {
            const outerBloomSize = nodeRadius * (3.5 + zoomGlowBoost * 2);
            const outerGradient = ctx.createRadialGradient(
              node.x,
              node.y,
              nodeRadius * 0.5,
              node.x,
              node.y,
              outerBloomSize,
            );
            outerGradient.addColorStop(
              0,
              `rgba(${rgb.r},${rgb.g},${rgb.b},${totalGlow * 0.6})`,
            );
            outerGradient.addColorStop(
              0.3,
              `rgba(${rgb.r},${rgb.g},${rgb.b},${totalGlow * 0.3})`,
            );
            outerGradient.addColorStop(
              0.6,
              `rgba(${rgb.r},${rgb.g},${rgb.b},${totalGlow * 0.1})`,
            );
            outerGradient.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.beginPath();
            ctx.arc(node.x, node.y, outerBloomSize, 0, 2 * Math.PI);
            ctx.fillStyle = outerGradient;
            ctx.fill();
          }

          // === INNER GLOW (always visible, creates depth) ===
          const innerGlowSize = nodeRadius * 2;
          const innerGradient = ctx.createRadialGradient(
            node.x,
            node.y,
            nodeRadius * 0.3,
            node.x,
            node.y,
            innerGlowSize,
          );

          // Brighter center for "lit" effect
          const centerBrightness = isSelected || isHovered ? 1 : 0.9;
          innerGradient.addColorStop(
            0,
            `rgba(${Math.min(255, rgb.r + 60)},${Math.min(255, rgb.g + 60)},${Math.min(255, rgb.b + 60)},${centerBrightness})`,
          );
          innerGradient.addColorStop(
            0.4,
            `rgba(${rgb.r},${rgb.g},${rgb.b},${0.7 + totalGlow * 0.3})`,
          );
          innerGradient.addColorStop(
            0.8,
            `rgba(${rgb.r},${rgb.g},${rgb.b},${0.3})`,
          );
          innerGradient.addColorStop(1, 'rgba(0,0,0,0)');

          ctx.beginPath();
          ctx.arc(node.x, node.y, innerGlowSize, 0, 2 * Math.PI);
          ctx.fillStyle = innerGradient;
          ctx.fill();

          // === MAIN NODE BODY ===
          const alpha = !selectedNodeId
            ? 0.95
            : depthBucket === 0
              ? 1
              : depthBucket === 1
                ? 0.9
                : depthBucket === 2
                  ? 0.7
                  : 0.5;
          const finalAlpha =
            isHighlighted || isSelected || isHovered ? 1 : alpha;

          // Gradient fill for 3D effect
          const bodyGradient = ctx.createRadialGradient(
            node.x - nodeRadius * 0.3,
            node.y - nodeRadius * 0.3,
            0,
            node.x,
            node.y,
            nodeRadius * 1.2,
          );
          bodyGradient.addColorStop(
            0,
            `rgba(${Math.min(255, rgb.r + 80)},${Math.min(255, rgb.g + 80)},${Math.min(255, rgb.b + 80)},${finalAlpha})`,
          );
          bodyGradient.addColorStop(
            0.5,
            `rgba(${rgb.r},${rgb.g},${rgb.b},${finalAlpha})`,
          );
          bodyGradient.addColorStop(
            1,
            `rgba(${Math.max(0, rgb.r - 40)},${Math.max(0, rgb.g - 40)},${Math.max(0, rgb.b - 40)},${finalAlpha})`,
          );

          ctx.beginPath();
          ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI);
          ctx.fillStyle = bodyGradient;
          ctx.fill();

          // === HIGHLIGHT RING ===
          if (isSelected || isHovered || isHighlighted || isOnPath) {
            ctx.beginPath();
            ctx.arc(
              node.x,
              node.y,
              nodeRadius + 2 / Math.max(0.5, globalScale),
              0,
              2 * Math.PI,
            );
            ctx.strokeStyle = isSelected
              ? 'rgba(255,255,255,0.9)'
              : isHovered
                ? 'rgba(255,255,255,0.7)'
                : 'rgba(45,226,230,0.8)';
            ctx.lineWidth = (isSelected ? 3 : 2) / Math.max(0.5, globalScale);
            ctx.stroke();
          }

          // === SUBTLE OUTLINE ===
          ctx.beginPath();
          ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI);
          ctx.strokeStyle = `rgba(255,255,255,${isSelected ? 0.4 : 0.15})`;
          ctx.lineWidth = 1 / Math.max(0.5, globalScale);
          ctx.stroke();

          // === SPECULAR HIGHLIGHT (shiny dot) ===
          const specularSize = nodeRadius * 0.25;
          const specularX = node.x - nodeRadius * 0.35;
          const specularY = node.y - nodeRadius * 0.35;

          const specularGradient = ctx.createRadialGradient(
            specularX,
            specularY,
            0,
            specularX,
            specularY,
            specularSize,
          );
          specularGradient.addColorStop(0, 'rgba(255,255,255,0.6)');
          specularGradient.addColorStop(1, 'rgba(255,255,255,0)');

          ctx.beginPath();
          ctx.arc(specularX, specularY, specularSize, 0, 2 * Math.PI);
          ctx.fillStyle = specularGradient;
          ctx.fill();

          // === BOOKMARK INDICATOR ===
          const isBookmarked =
            bookmarkedNodeIds instanceof Set
              ? bookmarkedNodeIds.has(id)
              : Array.isArray(bookmarkedNodeIds)
                ? bookmarkedNodeIds.includes(id)
                : false;

          if (isBookmarked) {
            const starSize = Math.max(10, 12 / Math.max(0.5, globalScale));
            const starX = node.x + nodeRadius + 6 / Math.max(0.5, globalScale);
            const starY = node.y - nodeRadius - 6 / Math.max(0.5, globalScale);

            // Star glow
            ctx.beginPath();
            ctx.arc(starX, starY, starSize * 0.8, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(45,226,230,0.3)';
            ctx.fill();

            ctx.font = `${starSize}px Inter, Arial`;
            ctx.fillStyle = '#2DE2E6';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('★', starX, starY);
          }

          // === LOCK INDICATOR ===
          const isLocked =
            lockedNodeIds instanceof Set
              ? lockedNodeIds.has(id)
              : Array.isArray(lockedNodeIds)
                ? lockedNodeIds.includes(id)
                : false;

          if (isLocked) {
            const lockSize = Math.max(10, 12 / Math.max(0.5, globalScale));
            const lockX = node.x + nodeRadius + 6 / Math.max(0.5, globalScale);
            const lockY = node.y + nodeRadius + 6 / Math.max(0.5, globalScale);

            ctx.font = `${lockSize}px Inter, Arial`;
            ctx.fillStyle = '#FB923C';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🔒', lockX, lockY);
          }

          // === EXPANSION INDICATOR ===
          if (canExpand) {
            const indicatorR = Math.max(6, nodeRadius * 0.4);
            const ix = node.x + nodeRadius * 0.7;
            const iy = node.y - nodeRadius * 0.7;

            // Indicator glow
            const indicatorGlow = ctx.createRadialGradient(
              ix,
              iy,
              0,
              ix,
              iy,
              indicatorR * 1.5,
            );
            indicatorGlow.addColorStop(
              0,
              isExpanded ? 'rgba(45,226,230,0.4)' : 'rgba(148,163,184,0.3)',
            );
            indicatorGlow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.arc(ix, iy, indicatorR * 1.5, 0, 2 * Math.PI);
            ctx.fillStyle = indicatorGlow;
            ctx.fill();

            // Indicator body
            ctx.beginPath();
            ctx.arc(ix, iy, indicatorR, 0, 2 * Math.PI);
            ctx.fillStyle = isExpanded ? '#2DE2E6' : '#94A3B8';
            ctx.fill();

            // Plus/minus sign
            ctx.fillStyle = '#0D1117';
            ctx.font = `bold ${Math.max(8, indicatorR * 1.2)}px Inter, Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(isExpanded ? '−' : '+', ix, iy);
          }

          // === HOVER TOOLTIP ===
          if (isHovered && !isSelected && canExpand) {
            const label = isExpanded ? 'Collapse' : 'Expand';
            const fontSize = Math.max(10, 11 / Math.max(0.5, globalScale));
            ctx.font = `${fontSize}px Inter, Arial`;

            const tw = ctx.measureText(label).width;
            const padX = 8 / Math.max(0.5, globalScale);
            const padY = 4 / Math.max(0.5, globalScale);
            const w = tw + padX * 2;
            const h = fontSize + padY * 2;
            const x = node.x - w / 2;
            const y = node.y - nodeRadius - h - 8 / Math.max(0.5, globalScale);
            const r = 6 / Math.max(0.5, globalScale);

            // Tooltip background with glow
            ctx.save();
            ctx.shadowColor = 'rgba(45,226,230,0.3)';
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
            ctx.fillStyle = 'rgba(13, 22, 30, 0.9)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(45,226,230,0.4)';
            ctx.lineWidth = 1 / Math.max(0.5, globalScale);
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = '#E0F7FA';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, node.x, y + h / 2);
          }

          // === SMART LABELS ===
          let showLabel = false;

          if (labelMode === 'off') {
            showLabel = false;
          } else if (labelMode === 'all') {
            showLabel = globalScale > 0.12;
          } else {
            // Smart mode
            const nodeType = String(node.type || '').toLowerCase();
            const nodeRole = String(node.role || '').toLowerCase();

            if (isSelected || isHovered || isHighlighted || isOnPath) {
              showLabel = true;
            } else if (nodeType === 'host' && nodeRole === 'root') {
              showLabel = globalScale > 0.1;
            } else if (nodeType === 'host' || nodeType === 'cluster') {
              showLabel = globalScale > 0.25;
            } else if (nodeType === 'dir') {
              showLabel = globalScale > 0.4;
            } else if (nodeType === 'path' || nodeType === 'file') {
              showLabel = globalScale > 0.6;
            } else {
              showLabel = globalScale > 0.5;
            }
          }

          if (showLabel) {
            const label =
              node.label || node.fullLabel || node.value || String(node.id);

            // Adaptive truncation
            const maxLen =
              globalScale < 0.3
                ? 8
                : globalScale < 0.5
                  ? 12
                  : globalScale < 0.8
                    ? 20
                    : 30;
            const truncated =
              label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;

            // Adaptive font size
            const baseFontSize = isSelected ? 13 : isHighlighted ? 12 : 11;
            const fontSize = Math.max(
              8,
              Math.min(16, baseFontSize / Math.max(0.4, globalScale)),
            );

            ctx.font = `${isSelected || isHighlighted ? 'bold ' : ''}${fontSize}px Inter, Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            const labelY = node.y + nodeRadius + 4 / Math.max(0.5, globalScale);

            // Text shadow/outline for readability
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 3 / Math.max(0.5, globalScale);
            ctx.strokeText(truncated, node.x, labelY);

            // Label with slight glow for important nodes
            if (isSelected || isHighlighted || isHovered) {
              ctx.shadowColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`;
              ctx.shadowBlur = 4;
            }

            ctx.fillStyle = isSelected
              ? '#FFFFFF'
              : isHighlighted
                ? '#E0F7FA'
                : isHovered
                  ? '#FFFFFF'
                  : 'rgba(255,255,255,0.9)';
            ctx.fillText(truncated, node.x, labelY);

            ctx.shadowBlur = 0;
          }
        }}
      />

      {/* legend removed per user request - they already have an external explanation */}
    </div>
  );
};
