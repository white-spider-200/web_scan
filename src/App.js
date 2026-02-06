import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import './components/SearchImprovements.css';
import { HierarchicalGraph } from './components/HierarchicalGraph';
import { TreeExplorer } from './components/TreeExplorer';
import { DetailsPanel } from './components/DetailsPanel';
import { LegendPanel } from './components/LegendPanel';
import { GraphSettingsPanel } from './components/GraphSettingsPanel';
import { useGraphSettings } from './context/GraphSettingsContext';
import { StatsPanel } from './components/StatsPanel';
import axios from 'axios';

const normalizeUrlParts = (input) => {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  raw = raw.replace(/#.*$/, '');
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  let parsed;
  try {
    parsed = new URL(hasScheme ? raw : `http://${raw}`);
  } catch (e) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  let port = parsed.port;
  if ((parsed.protocol === 'http:' && port === '80') || (parsed.protocol === 'https:' && port === '443')) {
    port = '';
  }
  const host = port ? `${hostname}:${port}` : hostname;
  let path = parsed.pathname || '/';
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const pathWithQuery = `${path}${parsed.search || ''}`;
  const pathSegments = path === '/' ? [] : path.split('/').filter(Boolean);
  return { host, hostname, port, pathSegments, path, pathWithQuery };
};

const getRootHostname = (hostname) => {
  if (!hostname) return hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  if (hostname.includes(':')) return hostname;
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
};

const lastSegment = (path) => {
  if (path == null) return '/';
  let cleaned = String(path);
  cleaned = cleaned.replace(/[?#].*$/, '');
  if (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
};

const truncateLabel = (label) => {
  if (!label) return label;
  return label.length > 24 ? `${label.slice(0, 24)}…` : label;
};

const looksLikeFile = (segment) => {
  const idx = segment.lastIndexOf('.');
  return idx > 0 && idx < segment.length - 1;
};

const normalizeStatusCode = (value) => {
  const raw = String(value ?? '').trim();
  const m = raw.match(/\d{3}/);
  return m ? m[0] : '';
};

const computeGraphStats = (nodes) => {
  const stats = {
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
  if (!Array.isArray(nodes) || !nodes.length) return stats;

  const statusCounts = new Map();
  const techCounts = new Map();
  let statusUnknown = 0;
  let techTotal = 0;

  nodes.forEach((n) => {
    if (!n || n.type === 'cluster') return;
    stats.total += 1;
    if (n.type === 'host') {
      if (n.role === 'root') stats.domain += 1;
      else stats.subdomain += 1;
    } else if (n.type === 'dir') {
      stats.directory += 1;
    } else if (n.type === 'path' || n.type === 'file') {
      stats.endpoint += 1;
    } else if (n.type === 'ip') {
      stats.ip += 1;
    }

    const code = normalizeStatusCode(n.status);
    if (code) statusCounts.set(code, (statusCounts.get(code) || 0) + 1);
    else statusUnknown += 1;

    const techs = (n.technologies || n.meta?.technologies || []).filter(Boolean);
    if (Array.isArray(techs) && techs.length) {
      techs.forEach((t) => {
        const key = String(t);
        if (!key) return;
        techTotal += 1;
        techCounts.set(key, (techCounts.get(key) || 0) + 1);
      });
    }
  });

  const topStatuses = Array.from(statusCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 7);

  const topTech = Array.from(techCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 7);

  stats.statusTop = topStatuses;
  stats.statusUnknown = statusUnknown;
  stats.techTop = topTech;
  stats.techUnique = techCounts.size;
  stats.techTotal = techTotal;
  return stats;
};

const buildGraph = (urls, { dirIds = new Set(), fileIds = new Set() } = {}) => {
  const nodeMap = new Map();
  const edgeMap = new Map();

  const dirHint = dirIds instanceof Set ? dirIds : new Set(Array.isArray(dirIds) ? dirIds : []);
  const fileHint = fileIds instanceof Set ? fileIds : new Set(Array.isArray(fileIds) ? fileIds : []);

  const nodeTypePriority = (type) => {
    const t = String(type || '');
    if (t === 'host') return 4;
    if (t === 'dir') return 3;
    if (t === 'file') return 2;
    if (t === 'path') return 1;
    return 0;
  };

  const mergeNodeType = (existingType, nextType) => {
    const a = String(existingType || '');
    const b = String(nextType || '');
    if (!a) return b || a;
    if (!b) return a;
    if (a === b) return a;
    return nodeTypePriority(b) > nodeTypePriority(a) ? b : a;
  };

  const addNode = (node) => {
    const id = String(node?.id || '');
    if (!id) return;

    const existing = nodeMap.get(id);
    if (!existing) {
      nodeMap.set(id, node);
      return;
    }

    const merged = { ...existing, ...node };
    merged.type = mergeNodeType(existing.type, node.type);

    // When multiple URLs map to the same node id (e.g. differing queries), keep the
    // most informative fullLabel (usually the longest).
    if (existing.fullLabel && node.fullLabel) {
      merged.fullLabel = String(node.fullLabel).length >= String(existing.fullLabel).length ? node.fullLabel : existing.fullLabel;
    }

    const existingLevel = Number.isFinite(existing.level) ? Number(existing.level) : null;
    const nextLevel = Number.isFinite(node.level) ? Number(node.level) : null;
    if (existingLevel == null && nextLevel != null) merged.level = nextLevel;
    else if (existingLevel != null && nextLevel != null) merged.level = Math.min(existingLevel, nextLevel);

    nodeMap.set(id, merged);
  };

  const addEdge = (source, target) => {
    const key = `${source}->${target}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { source, target, type: 'contains' });
  };

  urls.forEach((url) => {
    const parsed = normalizeUrlParts(url);
    if (!parsed) return;
    const { host, hostname, port, pathSegments, pathWithQuery } = parsed;
    if (!host) return;
    const rootHostname = getRootHostname(hostname);
    const rootHost = port ? `${rootHostname}:${port}` : rootHostname;
    const rootId = `host:${rootHost}`;
    addNode({
      id: rootId,
      type: 'host',
      role: 'root',
      label: truncateLabel(rootHostname),
      fullLabel: rootHost,
      hostname: rootHost,
      path: '/',
      level: 1
    });
    let parentId = rootId;
    const isSubdomain = rootHost !== host;
    if (isSubdomain) {
      const subdomainId = `host:${host}`;
      addNode({
        id: subdomainId,
        type: 'host',
        role: 'subdomain',
        label: truncateLabel(hostname),
        fullLabel: host,
        hostname: host,
        path: '/',
        level: 2
      });
      addEdge(rootId, subdomainId);
      parentId = subdomainId;
    }
    if (!pathSegments.length) {
      if (pathWithQuery && pathWithQuery !== '/') {
        const nodeId = `path:${host}:${pathWithQuery}`;
        addNode({
          id: nodeId,
          type: 'path',
          label: truncateLabel(pathWithQuery),
          fullLabel: pathWithQuery,
          hostname: host,
          path: pathWithQuery,
          level: isSubdomain ? 3 : 2
        });
        addEdge(parentId, nodeId);
      }
      return;
    }
    pathSegments.forEach((segment, index) => {
      const prefix = `/${pathSegments.slice(0, index + 1).join('/')}`;
      const nodeId = `path:${host}:${prefix}`;
      const isLast = index === pathSegments.length - 1;
      const hintedDir = dirHint.has(nodeId);
      const hintedFile = fileHint.has(nodeId);
      const nodeType = (isLast && (looksLikeFile(segment) || hintedFile)) ? 'file' : (isLast ? (hintedDir ? 'dir' : 'path') : 'dir');
      const baseLevel = isSubdomain ? 2 : 1;
      const shortLabel = lastSegment(prefix);
      const fullLabel = isLast && pathWithQuery ? pathWithQuery : prefix;
      addNode({
        id: nodeId,
        type: nodeType,
        label: truncateLabel(shortLabel),
        fullLabel,
        hostname: host,
        path: prefix,
        segment,
        level: baseLevel + index + 1
      });
      addEdge(parentId, nodeId);
      parentId = nodeId;
    });
  });

  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) };
};

export default function App() {
  const [target, setTarget] = useState('');
  const [theme, setTheme] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wrm:theme');
      return stored === 'light' ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  });
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState(null);
  const [lockedNodeIds, setLockedNodeIds] = useState(new Set()); // Track locked nodes to disable physics
  const [currentWebsiteId, setCurrentWebsiteId] = useState(null);
  const [lazyGraphData, setLazyGraphData] = useState({ nodes: [], links: [] });
  const [viewMode, setViewMode] = useState('graph');
  const [fullGraphLoaded, setFullGraphLoaded] = useState(false);
  const [clusteringEnabled, setClusteringEnabled] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wrm:clustering');
      if (stored === '0' || stored === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  });
  const [graphPerspective, setGraphPerspective] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wrm:graphPerspective');
      return stored === 'sitemap' ? 'sitemap' : 'attack';
    } catch (e) {
      return 'attack';
    }
  });
  const [dirClusterThreshold, setDirClusterThreshold] = useState(20);
  const [urlClusterThreshold, setUrlClusterThreshold] = useState(50);
  const [expandedClusters, setExpandedClusters] = useState(new Set());
  const [clusterReveal, setClusterReveal] = useState({});
  const [collapseStaticAssets, setCollapseStaticAssets] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wrm:collapseAssets');
      if (stored === '0' || stored === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  });
  const [collapseParamUrls, setCollapseParamUrls] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wrm:collapseParams');
      if (stored === '0' || stored === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  });
  const [lockLayout, setLockLayout] = useState(false);
  const [graphLayout, setGraphLayout] = useState('radial');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searchMatches, setSearchMatches] = useState([]); // [{id,label,type}]
  const [searchPick, setSearchPick] = useState(null); // node id
  const [highlightedNodes, setHighlightedNodes] = useState([]); // array of node ids
  const [highlightPath, setHighlightPath] = useState([]); // array of node ids that form the path
  const [loading, setLoading] = useState(false);
  const searchInputRef = useRef(null);
  const skipSearchClearRef = useRef(false);

  // Debounce search term
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 250); // 250ms debounce
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // find shortest path between two node ids using BFS on the graph links
  const findShortestPath = useCallback((startId, endId) => {
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) return [];
    const adj = new Map();
    for (const n of graphData.nodes) adj.set(n.id, new Set());
    for (const l of graphData.links) {
      const a = typeof l.source === 'object' ? l.source.id : l.source;
      const b = typeof l.target === 'object' ? l.target.id : l.target;
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    }
    const q = [startId];
    const prev = new Map();
    prev.set(startId, null);
    let found = false;
    for (let i = 0; i < q.length && !found; i++) {
      const cur = q[i];
      const nbrs = adj.get(cur) || new Set();
      for (const nb of nbrs) {
        if (!prev.has(nb)) {
          prev.set(nb, cur);
          q.push(nb);
          if (nb === endId) { found = true; break; }
        }
      }
    }
    if (!prev.has(endId)) return [];
    // reconstruct path
    const path = [];
    let cur = endId;
    while (cur !== null) { path.push(cur); cur = prev.get(cur); }
    return path.reverse();
  }, [graphData]);

  const revealGraphNodeInternal = useCallback((nodeId) => {
    const id = String(nodeId || '').trim();
    if (!id) return;
    const nodes = graphData?.nodes || [];
    const node = nodes.find((n) => String(n.id) === id);
    if (!node) return;

    const getNodeLevel = (n) => {
      const lvl = Number(n?.level);
      if (Number.isFinite(lvl)) return Math.max(1, Math.floor(lvl));
      const t = String(n?.type || '');
      if (t === 'host' && n?.role === 'root') return 1;
      if (t === 'host' && n?.role === 'subdomain') return 2;
      if (t === 'dir') return 2;
      if (t === 'path' || t === 'file') return 3;
      if (t === 'ip') return 3;
      return 3;
    };

    const requiredLevel = getNodeLevel(node);
    try {
      if (window?.graphInstance?.expandToLevel) {
        window.graphInstance.expandToLevel(requiredLevel);
      }
    } catch (e) {
      // ignore
    }

    setSelectedGraphNodeId(id);
    setHighlightedNodes([id]);
    const rootNode = nodes.find((n) => n.type === 'host' && n.role === 'root') || nodes.find((n) => n.type === 'host') || nodes[0];
    if (rootNode?.id) {
      const path = findShortestPath(rootNode.id, id);
      setHighlightPath(path);
    }
    try {
      setTimeout(() => {
        try {
          window?.graphInstance?.focusOn?.(id, { zoom: 2.05, duration: 520, delay: 80 });
        } catch (e) {}
      }, 220);
    } catch (e) {
      // ignore
    }
  }, [graphData, findShortestPath]);

  const revealGraphNode = useCallback((nodeId) => {
    const id = String(nodeId || '').trim();
    if (!id) return;
    if (viewMode === 'graph' && graphPerspective === 'attack') {
      setGraphPerspective('sitemap');
      setTimeout(() => revealGraphNodeInternal(id), 260);
      return;
    }
    revealGraphNodeInternal(id);
  }, [viewMode, graphPerspective, revealGraphNodeInternal]);

  const executeSearch = useCallback((value) => {
    const q = String(value || '').trim();
    if (!q) {
      if (skipSearchClearRef.current) {
        skipSearchClearRef.current = false;
        return;
      }
      setHighlightedNodes([]);
      setHighlightPath([]);
      setSearchMatches([]);
      setSearchPick(null);
      setActiveSearchIndex(-1);
      return;
    }

    // if user supplied two terms separated by comma or space, treat as two endpoints
    const parts = q.split(/[,\s]+/).filter(Boolean);
    const nodes = graphData.nodes || [];
    if (parts.length >= 2) {
      // produce candidate matches (exact first, then substring matches)
      const termMatches = (term) => {
        const t = term.toLowerCase();
        const exact = nodes.filter(n => n.id.toLowerCase() === t);
        if (exact.length) return exact;
        const subs = nodes.filter(n => n.id.toLowerCase().includes(t));
        return subs;
      };

      const candA = termMatches(parts[0]);
      const candB = termMatches(parts[1]);

      // set highlighted nodes to all candidates so user sees them
      const ids = Array.from(new Set([...(candA||[]).map(n=>n.id), ...(candB||[]).map(n=>n.id)]));
      setHighlightedNodes(ids);

      // try every pair of candidates to find the shortest connecting path
      let bestPath = null;
      if ((candA||[]).length && (candB||[]).length) {
        for (const aNode of candA) {
          for (const bNode of candB) {
            if (aNode.id === bNode.id) continue; // same node
            const p = findShortestPath(aNode.id, bNode.id);
            if (p && p.length) {
              if (!bestPath || p.length < bestPath.length) bestPath = p;
            }
          }
        }
      }

      if (bestPath) {
        setHighlightPath(bestPath);
      } else {
        setHighlightPath([]);
      }
      setSearchMatches([]);
      setSearchPick(null);
      return;
    }

    // otherwise find all nodes that contain the query text
    const qLower = q.toLowerCase();
    const matchNodes = nodes.filter(n => String(n.id).toLowerCase().includes(qLower));
    const matches = matchNodes.map(n => n.id);
    setHighlightedNodes(matches);
    const top = matchNodes
      .slice(0, 12)
      .map((n) => ({ id: n.id, label: n.label || n.id, type: n.type || '' }));
    setSearchMatches(top);
    setSearchPick(top[0]?.id || null);
    setActiveSearchIndex(top.length > 0 ? 0 : -1);

    // if exactly one match, compute path from root to it
    if (matches.length === 1) {
      const rootNode = (nodes.find(n => n.type === 'host' && n.role === 'root') || nodes.find(n => n.type === 'host') || nodes[0]);
      if (rootNode) {
        const path = findShortestPath(rootNode.id, matches[0]);
        setHighlightPath(path);
      } else setHighlightPath([]);
    } else {
      setHighlightPath([]);
    }
  }, [graphData, findShortestPath]);

  // Run search when debounced term changes
  useEffect(() => {
    executeSearch(debouncedSearchTerm);
  }, [debouncedSearchTerm, executeSearch]);

  const handleSearchInput = (e) => {
    setSearchTerm(e.target.value);
  };

  const clearSearch = () => {
    setSearchTerm('');
    setDebouncedSearchTerm('');
    setSearchMatches([]);
    setHighlightedNodes([]);
    setHighlightPath([]);
    setSearchPick(null);
    setActiveSearchIndex(-1);
    searchInputRef.current?.focus();
  };

  const handleSelectMatch = useCallback((matchId) => {
    skipSearchClearRef.current = true;
    setSearchTerm('');
    setDebouncedSearchTerm('');
    setSearchMatches([]);
    setActiveSearchIndex(-1);
    revealGraphNode(matchId);
  }, [revealGraphNode]);

  const handleSearchKeyDown = (e) => {
    if (!searchMatches.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSearchIndex((prev) => (prev + 1) % searchMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSearchIndex((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSearchIndex >= 0 && activeSearchIndex < searchMatches.length) {
        handleSelectMatch(searchMatches[activeSearchIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // If matches are shown, clear matches but keep text? Or clear everything?
      // Standard behavior: clear results first, then text.
      if (searchMatches.length) {
        setSearchMatches([]);
      } else {
        clearSearch();
      }
    }
  };

  // Sync active search pick with active index
  useEffect(() => {
    if (activeSearchIndex >= 0 && activeSearchIndex < searchMatches.length) {
      setSearchPick(searchMatches[activeSearchIndex].id);
    }
  }, [activeSearchIndex, searchMatches]);
  const [error, setError] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanStatus, setScanStatus] = useState({ status: 'idle', stage: '', stageLabel: '', currentTarget: '', message: '', logTail: [], updatedAt: '', startedAt: '', stageMeta: {}, rootNode: null });
  const [showScanBanner, setShowScanBanner] = useState(false);
  const [scanPanelOpen, setScanPanelOpen] = useState(true);
  const [scanPopoverOpen, setScanPopoverOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportWrapRef = useRef(null);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarksWrapRef = useRef(null);
  const [bookmarks, setBookmarks] = useState({});
  const [scanId, setScanId] = useState('');
  const [scanCancelling, setScanCancelling] = useState(false);
  const [scansOpen, setScansOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [graphPanelOpen, setGraphPanelOpen] = useState(false);
  const { scope, filters: graphFilters, layout: graphLayoutSettings, display: graphDisplay } = useGraphSettings();
  const [scansLoading, setScansLoading] = useState(false);
  const [scansError, setScansError] = useState('');
  const [scansList, setScansList] = useState([]);
  const [scansTotal, setScansTotal] = useState(0);
  const [scansOffset, setScansOffset] = useState(0);
  const [scansQuery, setScansQuery] = useState('');
  const [historyTab, setHistoryTab] = useState('domains');
  const [domainSummaries, setDomainSummaries] = useState([]);
  const [selectedDomain, setSelectedDomain] = useState('');
  const [domainScans, setDomainScans] = useState([]);
  const [domainOffset, setDomainOffset] = useState(0);

  useEffect(() => {
    try {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
      window.localStorage.setItem('wrm:theme', theme);
    } catch (e) {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem('wrm:clustering', clusteringEnabled ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }, [clusteringEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem('wrm:graphPerspective', graphPerspective);
    } catch (e) {
      // ignore
    }
  }, [graphPerspective]);

  useEffect(() => {
    try {
      window.localStorage.setItem('wrm:collapseAssets', collapseStaticAssets ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }, [collapseStaticAssets]);

  useEffect(() => {
    try {
      window.localStorage.setItem('wrm:collapseParams', collapseParamUrls ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }, [collapseParamUrls]);

  // When details panel is closed, ensure graph uses full width
  useEffect(() => {
    try {
      if (typeof document !== 'undefined') {
        const value = selectedNode ? (getComputedStyle(document.documentElement).getPropertyValue('--details-panel-width') || '0px') : '0px';
        document.documentElement.style.setProperty('--details-panel-width', value);
      }
    } catch (e) {
      // ignore
    }
  }, [selectedNode]);

  useEffect(() => {
    if (!scansOpen && !sidebarOpen) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (scansOpen) setScansOpen(false);
      if (sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [scansOpen, sidebarOpen]);

  useEffect(() => {
    if (!exportOpen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setExportOpen(false);
    };
    const onMouseDown = (e) => {
      const root = exportWrapRef.current;
      if (root && !root.contains(e.target)) setExportOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [exportOpen]);

  useEffect(() => {
    if (!bookmarksOpen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setBookmarksOpen(false);
    };
    const onMouseDown = (e) => {
      const root = bookmarksWrapRef.current;
      if (root && !root.contains(e.target)) setBookmarksOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [bookmarksOpen]);

  // Filter state
  const [statusFilters, setStatusFilters] = useState({ '200': true, '403': true, '500': true });
  const [techFilters, setTechFilters] = useState({ 'React': true, 'WordPress': true, 'Laravel': true });
  // Visualization filters
  const [typeFilters, setTypeFilters] = useState({ 
    host: true, 
    dir: true, 
    path: true, 
    file: true,
    ip: true
  });

  const statsNodes = useMemo(() => {
    const src = viewMode === 'tree' ? lazyGraphData : graphData;
    return Array.isArray(src?.nodes) ? src.nodes : [];
  }, [graphData, lazyGraphData, viewMode]);

  const stats = useMemo(() => computeGraphStats(statsNodes), [statsNodes]);

  const scanMeta = useMemo(() => {
    const status = String(scanStatus?.status || '').toLowerCase();
    const finished =
      status === 'completed' ||
      status === 'done' ||
      status === 'failed' ||
      status === 'cancelled';
    return {
      startedAt: scanStatus?.startedAt || '',
      finishedAt: finished ? (scanStatus?.updatedAt || '') : ''
    };
  }, [scanStatus?.startedAt, scanStatus?.status, scanStatus?.updatedAt]);

  const filterCounts = useMemo(() => {
    const counts = {
      type: { domain: 0, subdomain: 0, directory: 0, endpoint: 0, ip: 0 },
      status: {},
      tech: {}
    };
    if (!Array.isArray(statsNodes) || !statsNodes.length) return counts;

    statsNodes.forEach((n) => {
      if (!n || n.type === 'cluster') return;
      if (n.type === 'host') {
        if (n.role === 'root') counts.type.domain += 1;
        else counts.type.subdomain += 1;
      } else if (n.type === 'dir') counts.type.directory += 1;
      else if (n.type === 'path' || n.type === 'file') counts.type.endpoint += 1;
      else if (n.type === 'ip') counts.type.ip += 1;

      const code = normalizeStatusCode(n.status);
      if (code) counts.status[code] = (counts.status[code] || 0) + 1;

      const techs = n.technologies || n.meta?.technologies || [];
      if (Array.isArray(techs)) {
        techs.filter(Boolean).forEach((t) => {
          const key = String(t);
          if (!key) return;
          counts.tech[key] = (counts.tech[key] || 0) + 1;
        });
      }
    });

    return counts;
  }, [statsNodes]);

  const statusOptions = useMemo(() => {
    const keys = Object.keys(statusFilters || {});
    keys.sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    return keys;
  }, [statusFilters]);

  const techOptions = useMemo(() => {
    const keys = Object.keys(techFilters || {});
    keys.sort((a, b) => String(a).localeCompare(String(b)));
    return keys;
  }, [techFilters]);

  const activeFilterGroups = useMemo(() => {
    let active = 0;
    const typeAll =
      !!typeFilters.host &&
      !!typeFilters.dir &&
      !!typeFilters.path &&
      !!typeFilters.file &&
      !!typeFilters.ip;
    if (!typeAll) active += 1;
    const statusKeys = Object.keys(statusFilters || {});
    if (statusKeys.length) {
      const allOn = statusKeys.every((k) => !!statusFilters[k]);
      if (!allOn) active += 1;
    }
    const techKeys = Object.keys(techFilters || {});
    if (techKeys.length) {
      const allOn = techKeys.every((k) => !!techFilters[k]);
      if (!allOn) active += 1;
    }
    return active;
  }, [statusFilters, techFilters, typeFilters]);

  const setAllTypeFilters = (on) => {
    const value = !!on;
    setTypeFilters({ host: value, dir: value, path: value, file: value, ip: value });
  };

  const setAllStatusFilters = (on) => {
    const value = !!on;
    setStatusFilters((prev) => {
      const next = {};
      Object.keys(prev || {}).forEach((k) => {
        next[k] = value;
      });
      return next;
    });
  };

  const setAllTechFilters = (on) => {
    const value = !!on;
    setTechFilters((prev) => {
      const next = {};
      Object.keys(prev || {}).forEach((k) => {
        next[k] = value;
      });
      return next;
    });
  };

  const applyPreset = (presetKey) => {
    const key = String(presetKey || '').toLowerCase();
    if (key === 'all') {
      setAllTypeFilters(true);
      setAllStatusFilters(true);
      setAllTechFilters(true);
      return;
    }
    if (key === 'only_endpoints') {
      setTypeFilters({ host: false, dir: false, path: true, file: true, ip: false });
      return;
    }
    if (key === 'valid_endpoints') {
      setTypeFilters({ host: false, dir: false, path: true, file: true, ip: false });
      setStatusFilters((prev) => {
        const next = {};
        Object.keys(prev || {}).forEach((code) => {
          const first = String(code || '')[0];
          next[code] = first === '2' || first === '3';
        });
        return next;
      });
      return;
    }
    if (key === 'errors_only') {
      setStatusFilters((prev) => {
        const next = {};
        Object.keys(prev || {}).forEach((code) => {
          const first = String(code || '')[0];
          next[code] = first === '4' || first === '5';
        });
        return next;
      });
      return;
    }
  };

  const formatLocalTime = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  };

  const applyFiltersFromNodes = useCallback((nodes) => {
    const statuses = {};
    const techs = {};
    (nodes || []).forEach(n => {
      const code = String(n.status || '200').replace(/[^0-9]/g, '');
      if (code) statuses[code] = true;
      const tlist = n.technologies || n.meta?.technologies || [];
      if (Array.isArray(tlist)) {
        tlist.forEach(t => { if (t) techs[t] = true; });
      }
    });
    if (Object.keys(statuses).length) setStatusFilters(statuses);
    if (Object.keys(techs).length) setTechFilters(techs);
  }, []);

  const buildGraphFromNodes = useCallback((nodes, websiteId, relationships = [], scanTarget = '') => {
    const transformedNodes = nodes.map(node => ({
      ...node,
      id: String(node.id),
      group: node.type,
      type: node.type,
      value: node.value,
      status: node.status,
      size: node.size,
      label: node.value
    }));

    const typeByValue = new Map(
      transformedNodes
        .map((n) => [String(n.value || n.id || '').trim(), String(n.type || '').toLowerCase()])
        .filter(([k]) => k)
    );

    const parentsByChild = new Map();
    (Array.isArray(relationships) ? relationships : []).forEach((rel) => {
      if (!rel) return;
      if (String(rel.type || 'contains') !== 'contains') return;
      const src = String(rel.source || '').trim();
      const tgt = String(rel.target || '').trim();
      if (!src || !tgt) return;
      const list = parentsByChild.get(tgt) || [];
      list.push(src);
      parentsByChild.set(tgt, list);
    });

    const scanHost = (() => {
      const parsed = normalizeUrlParts(scanTarget || '');
      return parsed?.host || '';
    })();

    const hostCache = new Map();
    const inferHostForValue = (rawValue, seen = new Set()) => {
      const key = String(rawValue || '').trim();
      if (!key) return null;
      if (hostCache.has(key)) return hostCache.get(key);
      if (seen.has(key)) return null;
      seen.add(key);

      const nodeType = typeByValue.get(key) || '';
      const canParseHostFromSelf =
        /^https?:\/\//i.test(key) ||
        key.startsWith('//') ||
        key.includes('/') ||
        nodeType === 'domain' ||
        nodeType === 'subdomain';

      if (canParseHostFromSelf) {
        const parsed = normalizeUrlParts(key.startsWith('//') ? `http:${key}` : key);
        if (parsed?.host) {
          hostCache.set(key, parsed.host);
          return parsed.host;
        }
      }

      const parents = parentsByChild.get(key) || [];
      for (const parent of parents) {
        const resolved = inferHostForValue(parent, seen);
        if (resolved) {
          hostCache.set(key, resolved);
          return resolved;
        }
      }

      hostCache.set(key, null);
      return null;
    };

    const resolveNodeValue = (node) => {
      const raw = String(node?.value || node?.id || '').trim();
      if (!raw) return null;

      if (raw.startsWith('//')) return `http:${raw}`;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;

      const nodeType = String(node?.type || '').toLowerCase();
      if (nodeType === 'domain' || nodeType === 'subdomain') return raw.replace(/\/+$/, '');

      // If it's already host/path-ish (e.g. example.com/login), keep it.
      if (raw.includes('/') && (raw.includes('.') || raw.includes(':'))) return raw;

      // Otherwise treat it as a relative path under the best-known host.
      const hostHint = inferHostForValue(raw) || scanHost || null;
      if (!hostHint) return raw;

      if (raw.startsWith('/')) return `${hostHint}${raw}`;
      if (raw.startsWith('?')) return `${hostHint}/${raw}`;
      return `${hostHint}/${raw.replace(/^\/+/, '')}`;
    };

    const dirHintIds = new Set();
    const fileHintIds = new Set();
    const resolvedEntries = transformedNodes
      .map((n) => ({ node: n, resolved: resolveNodeValue(n) }))
      .filter((e) => e.resolved);

    resolvedEntries.forEach(({ node, resolved }) => {
      const parsed = normalizeUrlParts(resolved);
      if (!parsed?.host) return;
      const nodeType = String(node.type || '').toLowerCase();
      if (nodeType !== 'directory' && nodeType !== 'dir' && nodeType !== 'file') return;
      const prefix = parsed.pathSegments.length ? `/${parsed.pathSegments.join('/')}` : parsed.pathWithQuery;
      if (!prefix || prefix === '/') return;
      const pathId = `path:${parsed.host}:${prefix}`;
      if (nodeType === 'file') fileHintIds.add(pathId);
      else dirHintIds.add(pathId);
    });

    const urlCandidates = [];
    const seenCandidate = new Set();
    const pushCandidate = (candidate) => {
      const trimmed = String(candidate || '').trim();
      if (!trimmed) return;
      if (seenCandidate.has(trimmed)) return;
      seenCandidate.add(trimmed);
      urlCandidates.push(trimmed);
    };

    if (scanHost) pushCandidate(scanHost);
    transformedNodes
      .filter((n) => String(n.type || '').toLowerCase() === 'domain' || String(n.type || '').toLowerCase() === 'subdomain')
      .forEach((n) => {
        const resolved = resolveNodeValue(n);
        if (resolved) pushCandidate(resolved);
      });

    resolvedEntries.forEach(({ resolved }) => {
      if (!resolved) return;
      pushCandidate(resolved);
    });

    const { nodes: graphNodes, edges } = buildGraph(urlCandidates, { dirIds: dirHintIds, fileIds: fileHintIds });

    const metaByHostId = new Map();
    const metaByPathId = new Map();
    resolvedEntries.forEach(({ node: n, resolved }) => {
      const parsed = normalizeUrlParts(resolved);
      if (!parsed) return;
      const { host, pathSegments, pathWithQuery } = parsed;
      if (!host) return;
      if (!pathSegments.length) {
        if (n.type === 'domain' || n.type === 'subdomain') {
          const hostId = `host:${host}`;
          if (!metaByHostId.has(hostId)) metaByHostId.set(hostId, n);
        }
        if (pathWithQuery && pathWithQuery !== '/') {
          const pathId = `path:${host}:${pathWithQuery}`;
          if (!metaByPathId.has(pathId)) metaByPathId.set(pathId, n);
        }
        return;
      }
      const prefix = `/${pathSegments.join('/')}`;
      const pathId = `path:${host}:${prefix}`;
      if (!metaByPathId.has(pathId)) metaByPathId.set(pathId, n);
    });

    const enrichedNodes = graphNodes.map(n => {
      const meta = n.type === 'host' ? metaByHostId.get(n.id) : metaByPathId.get(n.id);
      if (!meta) return n;
      return {
        ...n,
        apiId: meta.id,
        status: meta.status,
        value: meta.value,
        fullLabel: meta.value || n.fullLabel,
        scan_started_at: meta.scan_started_at,
        scan_finished_at: meta.scan_finished_at,
        timestamp: meta.timestamp,
        meta: meta.meta,
        headers: meta.headers,
        technologies: meta.technologies,
        method: meta.method,
        file_type: meta.file_type,
        size: meta.size,
        vulns: meta.vulns
      };
    });

    const nodeById = new Map(enrichedNodes.map(n => [String(n.id), n]));
    const extraNodes = [];
    const extraLinks = [];
    const seen = new Set();

    enrichedNodes.forEach((n) => {
      if (n.type !== 'host') return;
      const rawIps = []
        .concat(n.ip || [])
        .concat(n.meta?.ip || [])
        .concat(n.meta?.ips || [])
        .concat(n.meta?.addr || []);

      rawIps
        .flat()
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .forEach((ip) => {
          const ipId = `ip:${ip}`;
          if (!nodeById.has(ipId) && !seen.has(ipId)) {
            seen.add(ipId);
            extraNodes.push({
              id: ipId,
              type: 'ip',
              label: ip,
              fullLabel: ip,
              ip
            });
          }
          const linkKey = `${n.id}->${ipId}`;
          if (!seen.has(linkKey)) {
            seen.add(linkKey);
            extraLinks.push({ source: n.id, target: ipId, type: 'contains' });
          }
        });
    });

    setGraphData({ nodes: enrichedNodes.concat(extraNodes), links: edges.concat(extraLinks) });
    setCurrentWebsiteId(websiteId);
    applyFiltersFromNodes(transformedNodes);
  }, [applyFiltersFromNodes]);

  // Advanced Graph Query Effect
  useEffect(() => {
    if (!graphPanelOpen) return;
    if (!currentWebsiteId) return;
    if (scope.mode === 'local' && !selectedGraphNodeId) return;

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const center = selectedGraphNodeId || (selectedNode ? selectedNode.id : null);
        const payload = {
          websiteId: currentWebsiteId,
          mode: scope.mode,
          centerId: scope.mode === 'local' ? center : undefined,
          hops: scope.localDepth,
          filters: {
            types: Object.keys(graphFilters.nodeTypes).filter(k => graphFilters.nodeTypes[k]),
            minRisk: graphFilters.minRiskScore
          }
        };

        const res = await axios.post('http://localhost:3001/api/graph/query', payload);
        const { nodes, links } = res.data;
        
        buildGraphFromNodes(nodes, currentWebsiteId, links, target);
      } catch (e) {
        console.error("Advanced graph query failed", e);
      } finally {
        setLoading(false);
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [graphPanelOpen, scope, graphFilters, currentWebsiteId, selectedGraphNodeId, buildGraphFromNodes, target, selectedNode]);

  const buildClusteredGraph = (data, pinnedIds = null) => {
    if (!data?.nodes?.length || !data?.links?.length) return data;

    const PAGE = 60;
    const STATIC_EXT = new Set([
      'js', 'css', 'map',
      'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',
      'woff', 'woff2', 'ttf', 'eot', 'otf',
      'mp4', 'mp3', 'wav', 'avi', 'mov', 'mkv',
      'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'
    ]);

    const nodeMap = new Map(data.nodes.map(n => [String(n.id), n]));
    const childrenByParent = new Map();
    const parentByChild = new Map();
    data.links.forEach(l => {
      if (l.type !== 'contains') return;
      const src = String(typeof l.source === 'object' ? l.source.id : l.source);
      const tgt = String(typeof l.target === 'object' ? l.target.id : l.target);
      if (!childrenByParent.has(src)) childrenByParent.set(src, []);
      childrenByParent.get(src).push(tgt);
      if (!parentByChild.has(tgt)) parentByChild.set(tgt, src);
    });

    const pinned = pinnedIds instanceof Set
      ? pinnedIds
      : new Set(Array.isArray(pinnedIds) ? pinnedIds.map((v) => String(v)) : []);

    const protectedIds = new Set();
    pinned.forEach((raw) => {
      const start = String(raw || '').trim();
      if (!start) return;
      let cur = start;
      let guard = 0;
      while (cur && guard++ < 96) {
        protectedIds.add(cur);
        cur = parentByChild.get(cur) || '';
      }
    });

    const rootNode = data.nodes.find((n) => n.type === 'host' && n.role === 'root') || data.nodes.find((n) => n.type === 'host');
    if (rootNode?.id) protectedIds.add(String(rootNode.id));

    const getText = (node) => {
      const raw = String(node?.fullLabel || node?.value || node?.label || node?.path || node?.hostname || node?.id || '').trim();
      return raw;
    };

    const normalizePathText = (raw) => {
      let v = String(raw || '').trim();
      if (!v) return '';
      v = v.replace(/#.*$/, '');
      return v;
    };

    const getExt = (raw) => {
      const t = normalizePathText(raw).split('?')[0];
      const last = t.split('/').filter(Boolean).pop() || '';
      const idx = last.lastIndexOf('.');
      if (idx <= 0 || idx === last.length - 1) return '';
      return last.slice(idx + 1).toLowerCase();
    };

    const isHashedAsset = (raw) => {
      const t = normalizePathText(raw).split('?')[0];
      return /\.[a-f0-9]{8,}\./i.test(t) || /-[a-f0-9]{8,}\./i.test(t);
    };

    const isHighValueFile = (raw) => {
      const t = normalizePathText(raw).toLowerCase();
      return (
        /\/robots\.txt(\?|$)/.test(t) ||
        /\/sitemap\.xml(\?|$)/.test(t) ||
        /\/security\.txt(\?|$)/.test(t) ||
        /\/\.well-known(\/|$)/.test(t) ||
        /\/swagger(\.json)?(\?|$)/.test(t) ||
        /\/openapi(\.json|\.yaml|\.yml)?(\?|$)/.test(t)
      );
    };

    const isStaticAsset = (node) => {
      const raw = getText(node);
      if (!raw) return false;
      if (isHighValueFile(raw)) return false;
      const ext = getExt(raw);
      if (!ext) return false;
      return STATIC_EXT.has(ext);
    };

    const hasQueryParams = (node) => {
      const raw = String(node?.fullLabel || node?.value || '').trim();
      return raw.includes('?') || raw.includes('&');
    };

    const scoreCache = new Map();
    const scoreNode = (id) => {
      const key = String(id);
      if (scoreCache.has(key)) return scoreCache.get(key);
      const node = nodeMap.get(key);
      if (!node) return -9999;
      const type = String(node.type || '');
      const textRaw = getText(node);
      const text = textRaw.toLowerCase();
      let score = 0;

      if (type === 'host') score += 80;
      if (type === 'dir') score += 36;
      if (type === 'path') score += 30;
      if (type === 'file') score += 26;
      if (type === 'ip') score += 12;

      const code = normalizeStatusCode(node.status);
      if (code === '200') score += 10;
      else if (code === '401' || code === '403') score += 12;
      else if (code && code.startsWith('3')) score += 6;
      else if (code && code.startsWith('5')) score += 10;
      else if (code === '404') score -= 10;

      if (isHighValueFile(textRaw)) score += 40;
      if (text.includes('/admin') || text.includes('wp-admin') || text.includes('administrator')) score += 34;
      if (text.includes('/login') || text.includes('signin') || text.includes('auth') || text.includes('oauth')) score += 28;
      if (text.includes('/api') || text.includes('graphql') || text.includes('swagger') || text.includes('openapi')) score += 24;
      if (text.includes('.git') || text.includes('/.env') || text.includes('backup') || text.includes('old') || text.includes('staging')) score += 18;

      if (hasQueryParams(node)) score -= 12;
      if (isStaticAsset(node)) score -= 38;
      if (isHashedAsset(textRaw)) score -= 18;

      scoreCache.set(key, score);
      return score;
    };

    const sortByScore = (ids) => {
      const arr = [...ids];
      arr.sort((a, b) => {
        const sa = scoreNode(a);
        const sb = scoreNode(b);
        if (sa !== sb) return sb - sa;
        const al = String(nodeMap.get(a)?.fullLabel || nodeMap.get(a)?.label || a);
        const bl = String(nodeMap.get(b)?.fullLabel || nodeMap.get(b)?.label || b);
        return al.localeCompare(bl);
      });
      return arr;
    };

    const hiddenNodes = new Set();
    const clusterNodes = [];
    const clusterLinks = [];

    const collectDescendants = (startId) => {
      const stack = [String(startId)];
      const seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        const kids = childrenByParent.get(cur) || [];
        kids.forEach((kid) => {
          const k = String(kid);
          if (!k || protectedIds.has(k)) return;
          if (!hiddenNodes.has(k)) {
            hiddenNodes.add(k);
            stack.push(k);
          }
        });
      }
    };

    const applyCluster = ({ parentId, kind, childIds, threshold, noun, clusterType }) => {
      const total = childIds.length;
      const limit = Math.max(0, Number(threshold) || 0);
      if (!total) return;
      if (total <= limit) return;

      const sorted = sortByScore(childIds);
      const clusterId = `cluster:${parentId}:${kind}`;
      const expanded = expandedClusters.has(clusterId);
      const baseShown = Math.min(limit, total);
      const requestedReveal = expanded ? Math.max(0, Number(clusterReveal?.[clusterId]) || PAGE) : 0;
      const desiredCount = expanded ? Math.min(total, baseShown + requestedReveal) : baseShown;

      const visibleSet = new Set();
      // Add the top-scored items first
      for (let i = 0; i < sorted.length && visibleSet.size < desiredCount; i++) {
        visibleSet.add(String(sorted[i]));
      }
      // Ensure pinned/path nodes are never clustered away
      sorted.forEach((id) => {
        const sid = String(id);
        if (protectedIds.has(sid)) visibleSet.add(sid);
      });

      const hidden = [];
      sorted.forEach((id) => {
        const sid = String(id);
        if (visibleSet.has(sid)) return;
        hidden.push(sid);
      });

      hidden.forEach((id) => {
        if (protectedIds.has(id)) return;
        if (!hiddenNodes.has(id)) hiddenNodes.add(id);
        collectDescendants(id);
      });

      const shownCount = total - hidden.length;
      const hiddenCount = hidden.length;

      const parentLevel = Number(nodeMap.get(parentId)?.level);
      const clusterLevel = Number.isFinite(parentLevel) ? Math.max(1, Math.floor(parentLevel) + 1) : undefined;
      const label = hiddenCount > 0
        ? `+ ${hiddenCount} more ${noun}`
        : `Collapse ${noun} (${total})`;

      clusterNodes.push({
        id: clusterId,
        label,
        type: 'cluster',
        clusterType,
        count: total,
        parentId,
        totalCount: total,
        baseShown,
        shownCount,
        hiddenCount,
        pageSize: PAGE,
        ...(clusterLevel ? { level: clusterLevel } : {})
      });
      clusterLinks.push({ source: parentId, target: clusterId, type: 'contains' });
    };

    childrenByParent.forEach((childIds, parentId) => {
      const pid = String(parentId);
      const nodes = (childIds || []).map((id) => nodeMap.get(String(id))).filter(Boolean);
      if (!nodes.length) return;

      const dirKids = [];
      const urlKids = [];
      nodes.forEach((n) => {
        const nid = String(n.id);
        if (String(n.type) === 'dir') dirKids.push(nid);
        else if (String(n.type) === 'path' || String(n.type) === 'file') urlKids.push(nid);
      });

      applyCluster({ parentId: pid, kind: 'dir', childIds: dirKids, threshold: dirClusterThreshold, noun: 'directories', clusterType: 'directory' });

      const normalUrls = [];
      const paramUrls = [];
      const assetUrls = [];
      urlKids.forEach((cid) => {
        const node = nodeMap.get(String(cid));
        if (!node) return;
        if (isStaticAsset(node)) assetUrls.push(String(cid));
        else if (hasQueryParams(node)) paramUrls.push(String(cid));
        else normalUrls.push(String(cid));
      });

      const minParamCluster = 10;
      const minAssetCluster = 16;
      if (collapseParamUrls && paramUrls.length > 0 && paramUrls.length < minParamCluster) {
        normalUrls.push(...paramUrls);
        paramUrls.length = 0;
      }
      if (collapseStaticAssets && assetUrls.length > 0 && assetUrls.length < minAssetCluster) {
        normalUrls.push(...assetUrls);
        assetUrls.length = 0;
      }

      const normalLimit = urlClusterThreshold;
      const paramLimit = collapseParamUrls ? 0 : Math.min(12, Number(urlClusterThreshold) || 0);
      const assetLimit = collapseStaticAssets ? 0 : Math.min(12, Number(urlClusterThreshold) || 0);

      applyCluster({ parentId: pid, kind: 'url', childIds: normalUrls, threshold: normalLimit, noun: 'URLs', clusterType: 'url' });
      applyCluster({ parentId: pid, kind: 'params', childIds: paramUrls, threshold: paramLimit, noun: 'parameter URLs', clusterType: 'params' });
      applyCluster({ parentId: pid, kind: 'assets', childIds: assetUrls, threshold: assetLimit, noun: 'static assets', clusterType: 'assets' });
    });

    // Filter out cluster nodes whose parent got hidden by another cluster decision.
    const visibleClusterNodes = clusterNodes.filter((n) => !hiddenNodes.has(String(n.parentId)));
    const visibleClusterIds = new Set(visibleClusterNodes.map((n) => String(n.id)));
    const visibleClusterLinks = clusterLinks.filter((l) => visibleClusterIds.has(String(l.target)));

    const nodes = data.nodes.filter((n) => !hiddenNodes.has(String(n.id))).concat(visibleClusterNodes);
    const nodeIds = new Set(nodes.map((n) => String(n.id)));
    const links = data.links.filter((l) => {
      const src = String(typeof l.source === 'object' ? l.source.id : l.source);
      const tgt = String(typeof l.target === 'object' ? l.target.id : l.target);
      if (!nodeIds.has(src) || !nodeIds.has(tgt)) return false;
      return true;
    }).concat(visibleClusterLinks);

    return { nodes, links };
  };

  const buildAttackSurfaceGraph = (data, pinnedIds = null) => {
    if (!data?.nodes?.length) return data;

    const PAGE = 60;
    const SUBDOMAIN_LIMIT = 24;
    const CATEGORY_LIMIT = 10;
    const STATIC_EXT = new Set([
      'js', 'css', 'map',
      'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',
      'woff', 'woff2', 'ttf', 'eot', 'otf',
      'mp4', 'mp3', 'wav', 'avi', 'mov', 'mkv',
      'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'
    ]);

    const pinned = pinnedIds instanceof Set
      ? pinnedIds
      : new Set(Array.isArray(pinnedIds) ? pinnedIds.map((v) => String(v)) : []);

    const nodeMap = new Map((data.nodes || []).map((n) => [String(n.id), n]));
    const rootNode =
      data.nodes.find((n) => n.type === 'host' && n.role === 'root') ||
      data.nodes.find((n) => n.type === 'host') ||
      null;
    if (!rootNode) return data;

    const getText = (node) => {
      const raw = String(node?.fullLabel || node?.value || node?.label || node?.path || node?.hostname || node?.id || '').trim();
      return raw;
    };

    const normalizePathText = (raw) => {
      let v = String(raw || '').trim();
      if (!v) return '';
      v = v.replace(/#.*$/, '');
      return v;
    };

    const getExt = (raw) => {
      const t = normalizePathText(raw).split('?')[0];
      const last = t.split('/').filter(Boolean).pop() || '';
      const idx = last.lastIndexOf('.');
      if (idx <= 0 || idx === last.length - 1) return '';
      return last.slice(idx + 1).toLowerCase();
    };

    const isHashedAsset = (raw) => {
      const t = normalizePathText(raw).split('?')[0];
      return /\.[a-f0-9]{8,}\./i.test(t) || /-[a-f0-9]{8,}\./i.test(t);
    };

    const isHighValueFile = (raw) => {
      const t = normalizePathText(raw).toLowerCase();
      return (
        /\/robots\.txt(\?|$)/.test(t) ||
        /\/sitemap\.xml(\?|$)/.test(t) ||
        /\/security\.txt(\?|$)/.test(t) ||
        /\/\.well-known(\/|$)/.test(t) ||
        /\/swagger(\.json)?(\?|$)/.test(t) ||
        /\/openapi(\.json|\.yaml|\.yml)?(\?|$)/.test(t)
      );
    };

    const isStaticAsset = (node) => {
      const raw = getText(node);
      if (!raw) return false;
      if (isHighValueFile(raw)) return false;
      const ext = getExt(raw);
      if (!ext) return false;
      return STATIC_EXT.has(ext);
    };

    const hasQueryParams = (node) => {
      const raw = String(node?.fullLabel || node?.value || '').trim();
      return raw.includes('?') || raw.includes('&');
    };

    const hasFindings = (node) => {
      const v = node?.meta?.vulns || node?.vulns || {};
      const nmap = Array.isArray(v?.nmap) ? v.nmap : [];
      const nuclei = Array.isArray(v?.nuclei) ? v.nuclei : [];
      return (nmap.length + nuclei.length) > 0;
    };

    const parseHostFromId = (id) => {
      const s = String(id || '');
      if (s.startsWith('host:')) return s.slice('host:'.length);
      if (s.startsWith('path:')) {
        // path:<host>:<path>
        const rest = s.slice('path:'.length);
        const idx = rest.indexOf(':');
        if (idx > 0) return rest.slice(0, idx);
        return rest;
      }
      if (s.includes('/') && (s.includes('.') || s.includes(':'))) {
        return s.split('/')[0];
      }
      return '';
    };

    const scoreCache = new Map();
    const scoreNode = (id) => {
      const key = String(id);
      if (scoreCache.has(key)) return scoreCache.get(key);
      const node = nodeMap.get(key);
      if (!node) return -9999;
      const type = String(node.type || '');
      const textRaw = getText(node);
      const text = textRaw.toLowerCase();
      let score = 0;

      if (type === 'host') score += 80;
      if (type === 'dir') score += 34;
      if (type === 'path') score += 30;
      if (type === 'file') score += 28;
      if (type === 'ip') score += 14;

      const code = normalizeStatusCode(node.status);
      if (code === '200') score += 10;
      else if (code === '401' || code === '403') score += 14;
      else if (code && code.startsWith('3')) score += 6;
      else if (code && code.startsWith('5')) score += 14;
      else if (code === '404') score -= 10;

      if (hasFindings(node)) score += 60;
      if (isHighValueFile(textRaw)) score += 45;
      if (text.includes('/admin') || text.includes('wp-admin') || text.includes('administrator')) score += 36;
      if (text.includes('/login') || text.includes('signin') || text.includes('auth') || text.includes('oauth') || text.includes('sso')) score += 30;
      if (text.includes('/api') || text.includes('graphql') || text.includes('swagger') || text.includes('openapi')) score += 26;
      if (text.includes('upload') || text.includes('/import') || text.includes('/export')) score += 18;
      if (text.includes('.git') || text.includes('/.env') || text.includes('backup') || text.includes('.bak') || text.includes('.zip') || text.includes('.sql') || text.includes('staging')) score += 22;
      if (text.includes('debug') || text.includes('trace') || text.includes('stacktrace') || text.includes('phpinfo')) score += 16;

      if (hasQueryParams(node)) score -= 12;
      if (isStaticAsset(node)) score -= 38;
      if (isHashedAsset(textRaw)) score -= 18;

      scoreCache.set(key, score);
      return score;
    };

    const sortByScore = (ids) => {
      const arr = [...ids];
      arr.sort((a, b) => {
        const sa = scoreNode(a);
        const sb = scoreNode(b);
        if (sa !== sb) return sb - sa;
        const al = String(nodeMap.get(a)?.fullLabel || nodeMap.get(a)?.label || a);
        const bl = String(nodeMap.get(b)?.fullLabel || nodeMap.get(b)?.label || b);
        return al.localeCompare(bl);
      });
      return arr;
    };

    const categorizeNode = (node) => {
      const textRaw = getText(node);
      const t = textRaw.toLowerCase();
      const code = normalizeStatusCode(node.status);
      if (hasFindings(node)) return 'findings';
      if (t.includes('/admin') || t.includes('wp-admin') || t.includes('administrator') || t.includes('/dashboard') || t.includes('/console') || t.includes('/internal') || t.includes('/staff') || t.includes('/panel')) return 'admin';
      if (t.includes('/login') || t.includes('signin') || t.includes('auth') || t.includes('oauth') || t.includes('sso') || t.includes('token') || t.includes('session')) return 'auth';
      if (t.includes('/api') || t.includes('graphql') || t.includes('swagger') || t.includes('openapi')) return 'api';
      if (t.includes('upload') || t.includes('/import') || t.includes('/export') || t.includes('/files') || t.includes('/file')) return 'upload';
      if (isHighValueFile(textRaw) || t.includes('.git') || t.includes('/.env') || t.includes('backup') || t.includes('.bak') || t.includes('.zip') || t.includes('.sql') || t.includes('staging')) return 'leaks';
      if (code === '401' || code === '403') return 'restricted';
      if (code && code.startsWith('5')) return 'errors';
      if (code && code.startsWith('3')) return 'redirects';
      return 'other';
    };

    const categories = [
      { key: 'findings', label: 'Findings', noun: 'findings', limit: Math.max(6, Math.floor(CATEGORY_LIMIT / 2)) },
      { key: 'auth', label: 'Auth & Login', noun: 'auth endpoints', limit: CATEGORY_LIMIT },
      { key: 'admin', label: 'Admin & Internal', noun: 'admin endpoints', limit: CATEGORY_LIMIT },
      { key: 'api', label: 'API & Docs', noun: 'api endpoints', limit: CATEGORY_LIMIT },
      { key: 'leaks', label: 'Leaks & Secrets', noun: 'leak paths', limit: CATEGORY_LIMIT },
      { key: 'restricted', label: 'Restricted (401/403)', noun: 'restricted endpoints', limit: Math.max(6, Math.floor(CATEGORY_LIMIT / 2)) },
      { key: 'errors', label: 'Errors (5xx)', noun: 'error endpoints', limit: Math.max(6, Math.floor(CATEGORY_LIMIT / 2)) },
      { key: 'other', label: 'Other URLs', noun: 'urls', limit: 0 }
    ];

    const endpointIds = [];
    (data.nodes || []).forEach((n) => {
      if (!n) return;
      const t = String(n.type || '');
      if (t !== 'dir' && t !== 'path' && t !== 'file') return;
      if (isStaticAsset(n)) return;
      endpointIds.push(String(n.id));
    });

    const categoryToIds = new Map(categories.map((c) => [c.key, []]));
    endpointIds.forEach((id) => {
      const node = nodeMap.get(id);
      if (!node) return;
      const key = categorizeNode(node);
      if (!categoryToIds.has(key)) categoryToIds.set(key, []);
      categoryToIds.get(key).push(id);
    });

    // Host scoring (to show the most interesting subdomains first).
    const hostScore = new Map();
    endpointIds.forEach((id) => {
      const host = parseHostFromId(id);
      if (!host) return;
      const hostId = `host:${host}`;
      const s = scoreNode(id);
      const prev = hostScore.get(hostId);
      if (prev == null || s > prev) hostScore.set(hostId, s);
    });

    const pinnedHostIds = new Set();
    pinned.forEach((id) => {
      const host = parseHostFromId(id);
      if (host) pinnedHostIds.add(`host:${host}`);
    });

    // Subdomains (collapse long tails behind a cluster node).
    const subdomains = (data.nodes || []).filter((n) => n.type === 'host' && n.role === 'subdomain').map((n) => String(n.id));
    const subdomainsSorted = [...subdomains].sort((a, b) => {
      const sa = hostScore.get(a) ?? -9999;
      const sb = hostScore.get(b) ?? -9999;
      if (sa !== sb) return sb - sa;
      return String(a).localeCompare(String(b));
    });

    const rootId = String(rootNode.id);
    const subdomainClusterId = `cluster:${rootId}:attack:subdomains`;
    const expandedSubdomains = expandedClusters.has(subdomainClusterId);
    const baseShownSub = Math.min(SUBDOMAIN_LIMIT, subdomainsSorted.length);
    const requestedSub = expandedSubdomains ? Math.max(0, Number(clusterReveal?.[subdomainClusterId]) || PAGE) : 0;
    const desiredSub = expandedSubdomains ? Math.min(subdomainsSorted.length, baseShownSub + requestedSub) : baseShownSub;

    const visibleSubdomainSet = new Set();
    for (let i = 0; i < subdomainsSorted.length && visibleSubdomainSet.size < desiredSub; i++) {
      visibleSubdomainSet.add(String(subdomainsSorted[i]));
    }
    pinnedHostIds.forEach((hid) => {
      if (hid !== rootId) visibleSubdomainSet.add(String(hid));
    });

    const visibleNodesById = new Map();
    const visibleLinks = [];

    const addNode = (node) => {
      if (!node) return;
      const id = String(node.id);
      if (!id) return;
      if (!visibleNodesById.has(id)) visibleNodesById.set(id, node);
    };

    const addLink = (source, target, type = 'contains') => {
      const s = String(source);
      const t = String(target);
      if (!s || !t) return;
      visibleLinks.push({ source: s, target: t, type });
    };

    // Root + visible subdomains.
    addNode({ ...rootNode, attackView: true, level: 1 });
    visibleSubdomainSet.forEach((hid) => {
      const n = nodeMap.get(hid);
      if (!n) return;
      addNode({ ...n, attackView: true, level: 2 });
      addLink(rootId, hid, 'contains');
    });

    const hiddenSubCount = Math.max(0, subdomainsSorted.length - visibleSubdomainSet.size);
    if (hiddenSubCount > 0) {
      addNode({
        id: subdomainClusterId,
        type: 'cluster',
        clusterType: 'attack_subdomains',
        label: `Subdomains (+${hiddenSubCount})`,
        count: subdomainsSorted.length,
        parentId: rootId,
        totalCount: subdomainsSorted.length,
        baseShown: baseShownSub,
        shownCount: visibleSubdomainSet.size,
        hiddenCount: hiddenSubCount,
        pageSize: PAGE,
        attackView: true,
        level: 2
      });
      addLink(rootId, subdomainClusterId, 'contains');
    }

    // IP nodes directly linked from visible hosts.
    const ipIds = new Set();
    (data.links || []).forEach((l) => {
      if (l.type !== 'contains') return;
      const src = String(typeof l.source === 'object' ? l.source.id : l.source);
      const tgt = String(typeof l.target === 'object' ? l.target.id : l.target);
      if (!src.startsWith('host:')) return;
      if (!tgt.startsWith('ip:')) return;
      if (!visibleNodesById.has(src)) return;
      ipIds.add(tgt);
      addLink(src, tgt, 'contains');
    });
    ipIds.forEach((ipId) => {
      const n = nodeMap.get(ipId);
      if (!n) return;
      addNode({ ...n, attackView: true, level: 2 });
    });

    // Category buckets (site-wide, attacker-centric).
    categories.forEach((cat) => {
      const allIds = (categoryToIds.get(cat.key) || []).map(String);
      const uniqueIds = Array.from(new Set(allIds));
      const total = uniqueIds.length;
      const clusterId = `cluster:${rootId}:attack:${cat.key}`;
      const expanded = expandedClusters.has(clusterId);
      const baseShown = Math.min(Math.max(0, Number(cat.limit) || 0), total);
      const requestedReveal = expanded ? Math.max(0, Number(clusterReveal?.[clusterId]) || PAGE) : 0;
      const desiredCount = expanded ? Math.min(total, baseShown + requestedReveal) : baseShown;

      const sorted = sortByScore(uniqueIds);
      const visibleSet = new Set();
      for (let i = 0; i < sorted.length && visibleSet.size < desiredCount; i++) visibleSet.add(String(sorted[i]));
      pinned.forEach((pid) => {
        const sid = String(pid);
        if (uniqueIds.includes(sid)) visibleSet.add(sid);
      });

      const shownIds = Array.from(visibleSet);
      const shownCount = shownIds.length;
      const hiddenCount = Math.max(0, total - shownCount);

      const label = hiddenCount > 0
        ? `${cat.label} (+${hiddenCount})`
        : `${cat.label} (${total})`;

      addNode({
        id: clusterId,
        type: 'cluster',
        clusterType: `attack_${cat.key}`,
        label,
        count: total,
        parentId: rootId,
        totalCount: total,
        baseShown,
        shownCount,
        hiddenCount,
        pageSize: PAGE,
        attackView: true,
        level: 2
      });
      addLink(rootId, clusterId, 'contains');

      shownIds.forEach((eid) => {
        const original = nodeMap.get(eid);
        if (!original) return;
        const host = parseHostFromId(eid);
        const short = String(original.fullLabel || original.label || original.id || '').trim();
        const display = host && short && !short.startsWith(host) ? `${host}${short.startsWith('/') ? '' : '/'}${short}` : (host ? `${host}${short}` : short);
        const label = truncateLabel(display);
        addNode({
          ...original,
          label,
          attackView: true,
          attackCategory: cat.key,
          attackScore: scoreNode(eid),
          level: 3
        });
        addLink(clusterId, eid, 'contains');
      });
    });

    // Keep the graph tidy: de-dup links by source+target.
    const linkDedup = new Map();
    visibleLinks.forEach((l) => {
      const key = `${l.source}->${l.target}:${l.type || 'contains'}`;
      if (!linkDedup.has(key)) linkDedup.set(key, l);
    });

    return { nodes: Array.from(visibleNodesById.values()), links: Array.from(linkDedup.values()) };
  };

  const fetchAllScans = async (offset = 0) => {
    setScansLoading(true);
    setScansError('');
    try {
      const params = new URLSearchParams({
        limit: '10',
        offset: String(offset)
      });
      const res = await axios.get(`http://localhost:3001/api/scans?${params.toString()}`);
      setScansList(res.data.scans || []);
      setScansTotal(res.data.total || 0);
      setScansOffset(offset);
    } catch (err) {
      setScansError('Failed to load scans');
    } finally {
      setScansLoading(false);
    }
  };

  const fetchDomainSummaries = async () => {
    setScansLoading(true);
    setScansError('');
    try {
      const res = await axios.get('http://localhost:3001/api/scans/domains');
      setDomainSummaries(res.data.domains || []);
    } catch (err) {
      setScansError('Failed to load domain history');
    } finally {
      setScansLoading(false);
    }
  };

  const fetchDomainScans = async (domain, offset = 0) => {
    setScansLoading(true);
    setScansError('');
    try {
      const params = new URLSearchParams({
        limit: '10',
        offset: String(offset)
      });
      const res = await axios.get(`http://localhost:3001/api/scans/domain/${encodeURIComponent(domain)}?${params.toString()}`);
      setDomainScans(res.data.scans || []);
      setDomainOffset(offset);
    } catch (err) {
      setScansError('Failed to load domain scans');
    } finally {
      setScansLoading(false);
    }
  };

  const loadScanById = useCallback(async (scanId, summaryOnly = true) => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`http://localhost:3001/api/scans/${encodeURIComponent(scanId)}${summaryOnly ? '?summary=1' : ''}`);
      const { scan, nodes, relationships, stages, logs } = res.data;
      if (scan?.target) setTarget(scan.target);
      setGraphData({ nodes: [], links: [] });
      setLazyGraphData({ nodes: [], links: [] });
      setExpandedClusters(new Set());
      setClusterReveal({});
      if (!summaryOnly) {
        buildGraphFromNodes(nodes || [], scan?.website_id, relationships || [], scan?.target || '');
        setFullGraphLoaded(true);
      } else {
        setFullGraphLoaded(false);
      }
      setCurrentWebsiteId(scan?.website_id || null);
      setScansOpen(false);
      setShowScanBanner(true);
      setScanPanelOpen(true);
      setScanId(scan?.scan_id || scanId);
      setScanCancelling(false);
      const stageList = Array.isArray(stages) ? stages : [];
      const normalizeStageKey = (key) => {
        if (key === 'html_links') return 'hyperhtml';
        if (key === 'dirs') return 'directories';
        return key;
      };
      const stageMeta = stageList.reduce((acc, s) => {
        const key = normalizeStageKey(s.key);
        acc[key] = {
          durationSeconds: s.durationSeconds,
          status: s.status,
          message: s.status === 'timed_out' ? 'Timed out • partial' : s.status === 'capped' ? 'Capped • partial' : (s.status === 'failed' || s.status === 'cancelled' ? s.label : '')
        };
        return acc;
      }, {});
      const runningStage = stageList.find(s => s.status === 'running');
      const lastStage = stageList.length ? stageList[stageList.length - 1] : null;
      const currentStage = runningStage?.key || lastStage?.key || 'done';
      setScanStatus({
        status: scan?.status || 'completed',
        stage: currentStage,
        stageLabel: scan?.status || 'Completed',
        currentTarget: '',
        message: scan?.status || 'Completed',
        logTail: Array.isArray(logs) ? logs : [],
        updatedAt: scan?.last_update_at || scan?.finished_at || scan?.started_at || '',
        startedAt: scan?.started_at || '',
        stageMeta,
        rootNode: res.data?.root_node || null
      });
    } catch (err) {
      setError('Failed to load scan');
    } finally {
      setLoading(false);
    }
  }, [buildGraphFromNodes]);

  const graphLabelForId = (id) => {
    const nodes = graphData?.nodes || [];
    const match = nodes.find((n) => String(n.id) === String(id));
    return match?.label || match?.fullLabel || match?.id || String(id);
  };

  const exportBaseName = useMemo(() => {
    const rawTarget = String(target || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const base = String(scanId || rawTarget || 'export').trim();
    return base
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+/, '')
      .slice(0, 80) || 'export';
  }, [scanId, target]);

  const bookmarkStorageKey = useMemo(() => {
    const rawTarget = String(target || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const base = String(scanId || rawTarget || '').trim();
    return base ? `wrm:bookmarks:${base}` : 'wrm:bookmarks:default';
  }, [scanId, target]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(bookmarkStorageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        setBookmarks(parsed);
      } else {
        setBookmarks({});
      }
    } catch (e) {
      setBookmarks({});
    }
  }, [bookmarkStorageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(bookmarkStorageKey, JSON.stringify(bookmarks || {}));
    } catch (e) {
      // ignore
    }
  }, [bookmarkStorageKey, bookmarks]);

  const bookmarkedNodeIds = useMemo(() => new Set(Object.keys(bookmarks || {})), [bookmarks]);

  const toggleBookmark = useCallback((nodeId, meta = {}) => {
    const id = String(nodeId || '').trim();
    if (!id) return;
    setBookmarks((prev) => {
      const next = { ...(prev || {}) };
      if (next[id]) {
        delete next[id];
        return next;
      }
      const label = String(meta.label || meta.fullLabel || meta.value || id);
      const type = String(meta.type || '');
      next[id] = {
        id,
        label,
        type,
        savedAt: new Date().toISOString()
      };
      return next;
    });
  }, []);

  const toggleLock = useCallback((nodeId) => {
    const id = String(nodeId || '').trim();
    if (!id) return;
    setLockedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const isBookmarked = (nodeId) => bookmarkedNodeIds.has(String(nodeId || '').trim());

  const isLocked = (nodeId) => lockedNodeIds.has(String(nodeId || '').trim());

  const bookmarkItems = useMemo(() => {
    const items = Object.values(bookmarks || {}).filter(Boolean);
    items.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    return items;
  }, [bookmarks]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (settingsOpen || scansOpen) return;
      const targetEl = e.target;
      const tag = String(targetEl?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || targetEl?.isContentEditable) return;

      if (e.key === 'b' || e.key === 'B') {
        const id = viewMode === 'graph' ? selectedGraphNodeId : selectedNode?.id;
        if (!id) return;
        const graphNode = (graphData?.nodes || []).find((n) => String(n.id) === String(id)) || null;
        const label = graphNode ? (graphNode.fullLabel || graphNode.label || graphNode.id) : (selectedNode?.value || selectedNode?.id || id);
        const type = graphNode ? (graphNode.type === 'host' ? (graphNode.role === 'subdomain' ? 'subdomain' : 'domain') : graphNode.type) : String(selectedNode?.type || '');
        toggleBookmark(id, { label, type });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [graphData, scansOpen, selectedGraphNodeId, selectedNode, settingsOpen, toggleBookmark, viewMode]);

  const downloadBlob = (blob, filename) => {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      // ignore
    }
  };

  const downloadText = (text, filename, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([text], { type: mime });
    downloadBlob(blob, filename);
  };

  const downloadDataUrl = (dataUrl, filename) => {
    try {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      // ignore
    }
  };

  const getVisibleExportData = () => {
    try {
      if (window?.graphInstance?.getVisibleGraphData) return window.graphInstance.getVisibleGraphData();
    } catch (e) {
      // ignore
    }
    const src = viewMode === 'tree' ? lazyGraphData : graphData;
    const nodes = Array.isArray(src?.nodes) ? src.nodes : [];
    const links = Array.isArray(src?.links) ? src.links : [];
    return {
      meta: { layout: graphLayout },
      nodes: nodes.map((n) => ({ id: String(n.id), type: n.type, role: n.role, label: n.label, fullLabel: n.fullLabel, hostname: n.hostname, path: n.path, level: n.level, status: n.status })),
      links: links.map((l) => ({
        source: String(typeof l.source === 'object' ? l.source.id : l.source),
        target: String(typeof l.target === 'object' ? l.target.id : l.target),
        type: l.type || 'contains'
      }))
    };
  };

const getFullExportData = () => {
  // Always use the RAW graph data, never the clustered version
  const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const links = Array.isArray(graphData?.links) ? graphData.links : [];
  
  return {
    meta: { 
      layout: graphLayout, 
      viewMode, 
      exportedAt: new Date().toISOString(),
      clustering: 'disabled',  // Mark that clustering is disabled
      totalNodes: nodes.length,
      totalLinks: links.length
    },
    nodes: nodes.map((n) => ({ 
      id: String(n.id), 
      type: n.type, 
      role: n.role, 
      label: n.label, 
      fullLabel: n.fullLabel, 
      hostname: n.hostname, 
      path: n.path, 
      level: n.level, 
      status: n.status,
      apiId: n.apiId,
      technologies: n.technologies,
      headers: n.headers,
      size: n.size
    })),
    links: links.map((l) => ({
      source: String(typeof l.source === 'object' ? l.source.id : l.source),
      target: String(typeof l.target === 'object' ? l.target.id : l.target),
      type: l.type || 'contains'
    }))
  };
};

  const exportPdf = () => {
    const rawTarget = String(target || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const exportId = String(scanId || rawTarget || '').trim();
    if (!exportId) return;
    const url = `/api/report/full.pdf?scanId=${encodeURIComponent(exportId)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };



const exportJson = () => {
  const snapshot = getFullExportData();
  const payload = {
    exportedAt: new Date().toISOString(),
    target: String(target || '').trim(),
    scanId: String(scanId || '').trim() || null,
    viewMode,
    graph: snapshot
  }; 
  downloadText(`${JSON.stringify(payload, null, 2)}\n`, `${exportBaseName}.json`, 'application/json;charset=utf-8');
};

const generateReportData = () => {
  const snapshot = getFullExportData();
  const payload = {
    exportedAt: new Date().toISOString(),
    target: String(target || '').trim(),
    scanId: String(scanId || '').trim() || null,
    viewMode,
    graph: snapshot
  };
  
  // Use localStorage instead of sessionStorage (shared across tabs)
  localStorage.setItem('reportData', JSON.stringify(payload));
  
  // Open the Full Report page in a new tab
  window.open('/Full Report.html', '_blank', 'noopener,noreferrer');
};

  const toCsvCell = (value) => {
    const s = String(value ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  
const exportCsv = () => {
  const snapshot = getFullExportData();
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  
  const header = [
    'id',
    'type',
    'role',
    'label',
    'fullLabel',
    'hostname',
    'path',
    'level',
    'status',
    'technologies'
  ];
  const lines = [header.join(',')];
  
  nodes.forEach((n) => {
    const techs = Array.isArray(n.technologies) ? n.technologies.join(';') : '';
    lines.push([
      toCsvCell(n.id),
      toCsvCell(n.type),
      toCsvCell(n.role),
      toCsvCell(n.label),
      toCsvCell(n.fullLabel),
      toCsvCell(n.hostname),
      toCsvCell(n.path),
      toCsvCell(n.level),
      toCsvCell(n.status),
      toCsvCell(techs)
    ].join(','));
  });
  
  downloadText(`${lines.join('\n')}\n`, `${exportBaseName}.csv`, 'text/csv;charset=utf-8');
};

  const exportPng = () => {
    try {
      const canvas = window?.graphInstance?.getCanvas?.();
      if (!canvas) return;
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0d1418';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(canvas, 0, 0);
      const dataUrl = out.toDataURL('image/png');
      downloadDataUrl(dataUrl, `${exportBaseName}.png`);
    } catch (e) {
      // ignore
    }
  };

  const exportSvg = () => {
    const snapshot = getVisibleExportData();
    const nodes = (snapshot?.nodes || []).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    const links = Array.isArray(snapshot?.links) ? snapshot.links : [];
    if (!nodes.length) return;
    const nodeById = new Map(nodes.map((n) => [String(n.id), n]));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    });
    const pad = 120;
    const vbX = Math.floor(minX - pad);
    const vbY = Math.floor(minY - pad);
    const vbW = Math.ceil((maxX - minX) + pad * 2);
    const vbH = Math.ceil((maxY - minY) + pad * 2);
    const width = 1600;
    const height = Math.max(600, Math.min(2400, Math.round(width * (vbH / Math.max(1, vbW)))));

    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    const parts = [];
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${width}" height="${height}">`);
    parts.push(`<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#0d1418" />`);

    links.forEach((l) => {
      const src = nodeById.get(String(l.source));
      const tgt = nodeById.get(String(l.target));
      if (!src || !tgt) return;
      parts.push(`<line x1="${src.x}" y1="${src.y}" x2="${tgt.x}" y2="${tgt.y}" stroke="rgba(96,165,250,0.55)" stroke-width="1.2" />`);
    });

    nodes.forEach((n) => {
      const r = Math.max(5, Math.min(22, Number(n.radius) || 8));
      const fill = esc(n.color || '#94A3B8');
      const stroke = n.bookmarked ? 'rgba(45,226,230,0.95)' : 'rgba(255,255,255,0.10)';
      const sw = n.bookmarked ? 2.2 : 1.1;
      parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`);
      if (n.type === 'host' || n.bookmarked) {
        const label = esc(String(n.fullLabel || n.label || n.id || '').slice(0, 80));
        if (label) {
          parts.push(`<text x="${n.x}" y="${n.y + r + 16}" text-anchor="middle" font-family="Inter,Arial" font-size="14" fill="rgba(226,239,243,0.92)">${label}</text>`);
        }
      }
    });

    parts.push(`</svg>`);
    downloadText(`${parts.join('')}\n`, `${exportBaseName}.svg`, 'image/svg+xml;charset=utf-8');
  };

  const handleScan = async () => {
    setLoading(true);
    setError(null);
    setScanProgress(null);
    setGraphData({ nodes: [], links: [] });
    setLazyGraphData({ nodes: [], links: [] });
    setFullGraphLoaded(false);
    setExpandedClusters(new Set());
    setClusterReveal({});
    setSelectedGraphNodeId(null);
    setHighlightedNodes([]);
    setHighlightPath([]);
    setShowScanBanner(true);
    setScanPanelOpen(true);
    setScanCancelling(false);
    setScanStatus({ status: 'queued', stage: 'start', stageLabel: 'Queued', currentTarget: '', message: 'Queued', logTail: [], updatedAt: '', stageMeta: {}, rootNode: null });
    try {
      const raw = String(target || '').trim();
      if (!raw) {
        setError('Target is required');
        setLoading(false);
        return;
      }
      const res = await axios.post('http://localhost:3001/api/scans', { target: raw });
      const scanId = res.data.scan_id;
      setScanId(scanId || '');
      if (!scanId) throw new Error('No scan_id returned');

      const poll = async () => {
        try {
          // Avoid non-simple CORS headers (e.g. Cache-Control) that trigger preflight failures.
          const statusRes = await axios.get(`http://localhost:3001/api/scans/${encodeURIComponent(scanId)}/status`, {
            params: { _: Date.now() }
          });
          const payload = statusRes.data || {};
          const status = payload.status || 'running';
          if (payload.progress) {
            setScanProgress(payload.progress);
          }
          setScanStatus((prev) => {
            const nextStageMeta = { ...(prev.stageMeta || {}) };
            const stageKey = payload.stage === 'html_links' ? 'hyperhtml' : payload.stage === 'dirs' ? 'directories' : payload.stage || '';
            if (payload.message && /timed out/i.test(payload.message) && stageKey) {
              nextStageMeta[stageKey] = { ...(nextStageMeta[stageKey] || {}), status: 'timed_out', message: 'Timed out • partial' };
            }
            if (payload.message && /capped/i.test(payload.message) && stageKey) {
              nextStageMeta[stageKey] = { ...(nextStageMeta[stageKey] || {}), status: 'capped', message: 'Capped • partial' };
            }
            return {
              status,
              stage: payload.stage || '',
              stageLabel: payload.stage_label || payload.message || 'Running',
              currentTarget: payload.current_target || '',
              message: payload.message || '',
              logTail: Array.isArray(payload.log_tail) ? payload.log_tail : (payload.log_tail ? [payload.log_tail] : []),
              updatedAt: payload.updated_at || '',
              startedAt: payload.started_at || '',
              stageMeta: nextStageMeta,
              rootNode: prev.rootNode || null
            };
          });
          if (status === 'completed') {
            const scanRes = await axios.get(`http://localhost:3001/api/scans/${encodeURIComponent(scanId)}?summary=1`);
            const { scan } = scanRes.data;
            if (scan?.target) setTarget(scan.target);
            setGraphData({ nodes: [], links: [] });
            setLazyGraphData({ nodes: [], links: [] });
            setCurrentWebsiteId(scan?.website_id || null);
            setScanProgress(null);
            setScanStatus({ status: 'completed', stage: 'done', stageLabel: 'Completed', currentTarget: '', message: 'Completed', logTail: [], updatedAt: '', stageMeta: scanStatus.stageMeta || {}, rootNode: scanRes.data?.root_node || null });
            setTimeout(() => setShowScanBanner(false), 3000);
            setTimeout(() => setScanPanelOpen(false), 3000);
            setLoading(false);
            setScanCancelling(false);
            return;
          }
          if (status === 'failed') {
            const failedStage = payload.stage || scanStatus.stage || 'start';
            setError(payload.message || 'Scan failed');
            setScanProgress(null);
            setScanStatus({ status: 'failed', stage: failedStage, stageLabel: 'Failed', currentTarget: '', message: payload.message || 'Failed', logTail: [], updatedAt: '', stageMeta: scanStatus.stageMeta || {}, rootNode: scanStatus.rootNode || null });
            setLoading(false);
            setScanCancelling(false);
            return;
          }
          if (status === 'cancelled') {
            const cancelledStage = payload.stage || scanStatus.stage || 'start';
            setScanProgress(null);
            setScanStatus({ status: 'cancelled', stage: cancelledStage, stageLabel: 'Cancelled', currentTarget: '', message: payload.message || 'Cancelled', logTail: Array.isArray(payload.log_tail) ? payload.log_tail : [], updatedAt: payload.updated_at || '', stageMeta: scanStatus.stageMeta || {}, rootNode: scanStatus.rootNode || null });
            setLoading(false);
            setScanCancelling(false);
            return;
          }
          setTimeout(poll, 1000);
        } catch (e) {
          setError('Failed to fetch scan status');
          setLoading(false);
          setTimeout(poll, 1500);
        }
      };
      poll();
    } catch (err) {
      console.error('Error starting scan:', err);
      setError('Failed to start scan');
      setScanProgress(null);
      setScanStatus({ status: 'failed', stage: 'start', stageLabel: 'Failed', currentTarget: '', message: 'Failed to start', logTail: [], updatedAt: '', stageMeta: {}, rootNode: scanStatus.rootNode || null });
      setLoading(false);
    }
  };

  const handleCancelScan = async () => {
    if (!scanId || scanCancelling) return;
    const confirm = window.confirm('Cancel this scan?');
    if (!confirm) return;
    setScanCancelling(true);
    setScanStatus((prev) => ({ ...prev, status: 'cancelling', stageLabel: 'Cancelling', message: 'Cancelling scan' }));
    try {
      // cancellation request: server stops the active scan
      await axios.post(`http://localhost:3001/api/scans/${encodeURIComponent(scanId)}/cancel`);
    } catch (e) {
      setScanCancelling(false);
      setError('Failed to cancel scan');
    }
  };

  // Load data from the database on first render
  React.useEffect(() => {
    // Auto-start disabled; scans start only from user action.
  }, []);

  const handleTreeSelect = async (node) => {
    try {
      if (!currentWebsiteId || !node?.id) {
        setSelectedNode(node || null);
        return;
      }
      const encodedNodeId = encodeURIComponent(node.id);
      const res = await axios.get(`http://localhost:3001/websites/${currentWebsiteId}/nodes/${encodedNodeId}`);
      setSelectedNode(res.data.node || node);
    } catch (e) {
      setSelectedNode(node || null);
    }
  };

  const handleTreeFocus = (node) => {
    if (!node?.id) return;
    try {
      if (window?.graphInstance?.focusOn) {
        window.graphInstance.focusOn(node.id, { zoom: 2, duration: 500 });
      }
    } catch (e) {
      console.debug('focusOn failed', e);
    }
  };

  useEffect(() => {
    if (viewMode !== 'graph') return;
    if (!scanId || fullGraphLoaded) return;
    const status = String(scanStatus?.status || '');
    if (status && status !== 'completed' && status !== 'done') return;
    loadScanById(scanId, false);
  }, [viewMode, scanId, fullGraphLoaded, scanStatus?.status, loadScanById]);

  useEffect(() => {
    const nodes = graphData?.nodes || [];
    if (nodes.length) return;
    setSearchMatches([]);
    setSearchPick(null);
    setHighlightedNodes([]);
    setHighlightPath([]);
  }, [graphData]);

  useEffect(() => {
    if (viewMode !== 'tree') return;
    setGraphData({ nodes: [], links: [] });
    setFullGraphLoaded(false);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'graph') return;
    if (selectedGraphNodeId) return;
    const nodes = graphData?.nodes || [];
    if (!nodes.length) return;
    const root = nodes.find((n) => n.type === 'host' && n.role === 'root') || nodes.find((n) => n.type === 'host') || nodes[0];
    if (root?.id) setSelectedGraphNodeId(root.id);
  }, [viewMode, graphData, selectedGraphNodeId]);

  return (
    <div className="app-shell">
      {sidebarOpen ? (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      ) : null}
      <header className="top-nav" role="banner">
        <button
          type="button"
          className="ui-btn icon ghost mobile-menu-btn"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open filters"
        >
          ☰
        </button>
        <div className="top-nav-title">WEB RECON MAP</div>
        <div className="top-nav-center">
          <div className="top-nav-field">
            <div className="top-nav-field-label">Target</div>
            <input
              type="text"
              list="target-options"
              placeholder="target.com"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="ui-input sm top-nav-input"
            />
            <datalist id="target-options">
              <option value="target.com" />
              {(domainSummaries || []).slice(0, 25).map((d) => (
                <option key={d.domain} value={d.domain} />
              ))}
            </datalist>
          </div>

          <button
            type="button"
            onClick={handleScan}
            disabled={loading || !String(target || '').trim()}
            className="ui-btn primary sm"
          >
            {loading ? 'Scanning…' : 'Start Scan'}
          </button>

          {(function() {
            const status = String(scanStatus?.status || (loading ? 'running' : 'idle'));
            const running = ['queued', 'running', 'cancelling'].includes(status);
            const tone =
              status === 'completed'
                ? 'good'
                : status === 'failed'
                  ? 'error'
                  : running
                    ? 'running'
                    : 'idle';

            const normalizeStageKey = (key) => {
              if (key === 'html_links') return 'hyperhtml';
              if (key === 'dirs') return 'directories';
              return key || 'start';
            };

            const stageOrder = ['start', 'subdomains', 'hyperhtml', 'js_routes', 'directories', 'fingerprint', 'build_graph', 'done'];
            const stageLabels = {
              start: 'Start',
              subdomains: 'Subdomains',
              hyperhtml: 'HyperHTML',
              js_routes: 'JS Route Discovery',
              directories: 'Directories',
              fingerprint: 'Fingerprint',
              build_graph: 'Build Graph',
              done: 'Done'
            };

            const stageKey = normalizeStageKey(scanStatus?.stage);
            const stageIndex = stageOrder.indexOf(stageKey);
            const totalSteps = stageOrder.length - 1;
            const completedSteps = stageIndex > 0 ? Math.min(totalSteps, stageIndex) : 0;
            const percent = stageIndex >= 0 ? Math.round((completedSteps / Math.max(1, totalSteps)) * 100) : null;

            const summary = (function() {
              if (status === 'completed' || status === 'done') return 'Scan complete';
              if (status === 'failed') return 'Scan failed';
              if (status === 'cancelled') return 'Scan cancelled';
              if (status === 'cancelling') return 'Cancelling…';
              if (status === 'queued') return 'Queued…';
              if (status === 'running') return `Scanning${Number.isFinite(percent) ? ` (${percent}%)` : '…'}`;
              return 'Idle';
            })();

            const sub = scanProgress?.subdomains?.done;
            const dir = scanProgress?.directories?.done;
            const end = scanProgress?.endpoints?.done;
            const hasCounts = [sub, dir, end].some((v) => v != null);

            const elapsed = (function() {
              if (!scanStatus?.startedAt) return '—';
              const started = new Date(scanStatus.startedAt).getTime();
              if (!Number.isFinite(started)) return '—';
              const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
              const minutes = Math.floor(seconds / 60);
              const rem = seconds % 60;
              return `${String(minutes).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
            })();

            const lastUpdate = (function() {
              if (!scanStatus?.updatedAt) return '—';
              const updated = new Date(scanStatus.updatedAt).getTime();
              if (!Number.isFinite(updated)) return '—';
              const seconds = Math.max(0, Math.floor((Date.now() - updated) / 1000));
              return `${seconds}s ago`;
            })();

            const openScanPanel = () => {
              if (status === 'idle') return;
              setShowScanBanner(true);
              setScanPanelOpen(true);
              setScanPopoverOpen(false);
            };

            const shouldShowPopover = scanPopoverOpen && status !== 'idle';

            return (
              <div
                className="scan-indicator-wrap"
                onMouseEnter={() => setScanPopoverOpen(true)}
                onMouseLeave={() => setScanPopoverOpen(false)}
                onFocusCapture={() => setScanPopoverOpen(true)}
                onBlurCapture={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) setScanPopoverOpen(false);
                }}
              >
                <button
                  type="button"
                  className={`scan-indicator scan-indicator-btn ${tone}`}
                  onClick={openScanPanel}
                  aria-haspopup="dialog"
                  aria-expanded={showScanBanner && scanPanelOpen ? 'true' : 'false'}
                >
                  <span className="scan-indicator-dot" aria-hidden="true" />
                  <span className="scan-indicator-text" aria-live="polite">
                    {summary}
                  </span>
                </button>

                {shouldShowPopover ? (
                  <div className="scan-popover" role="dialog" aria-label="Scan details">
                    <div className="scan-popover-header">
                      <div className="scan-popover-title">Scan details</div>
                      <span className={`scan-popover-chip ${tone}`}>{summary}</span>
                    </div>
                    <div className="scan-popover-grid">
                      <div className="scan-popover-k">Stage</div>
                      <div className="scan-popover-v">{stageLabels[stageKey] || '—'}</div>

                      <div className="scan-popover-k">Elapsed</div>
                      <div className="scan-popover-v">{elapsed}</div>

                      <div className="scan-popover-k">Updated</div>
                      <div className="scan-popover-v">{lastUpdate}</div>

                      {hasCounts ? (
                        <>
                          <div className="scan-popover-k">Found</div>
                          <div className="scan-popover-v">
                            {sub != null ? `${sub} subdomains` : null}
                            {dir != null ? `${sub != null ? ' • ' : ''}${dir} dirs` : null}
                            {end != null ? `${sub != null || dir != null ? ' • ' : ''}${end} endpoints` : null}
                          </div>
                        </>
                      ) : null}
                    </div>

                    {scanStatus?.message ? (
                      <div className="scan-popover-message" title={scanStatus.message}>
                        {scanStatus.message}
                      </div>
                    ) : null}

                    <div className="scan-popover-actions">
                      <button type="button" className="ui-btn secondary sm" onClick={openScanPanel}>
                        Open panel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })()}

          <div className="top-nav-field top-nav-search">
            <div className="top-nav-field-label">Search</div>
            <div className="top-nav-search-wrapper">
              <input
                ref={searchInputRef}
                value={searchTerm}
                onChange={handleSearchInput}
                onKeyDown={handleSearchKeyDown}
                type="text"
                placeholder="Search nodes, paths, IPs…"
                className="ui-input sm top-nav-input"
              />
              {searchTerm && (
                <button
                  type="button"
                  className="top-nav-search-clear"
                  onClick={clearSearch}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
            {(function() {
              const term = String(searchTerm || '').trim();
              const hasMatches = searchMatches.length > 0;
              if (!term && !hasMatches) return null;
              
              if (term && !hasMatches && debouncedSearchTerm === term && !highlightPath.length) {
                 return (
                   <div className="search-popover" role="listbox" aria-label="Search results">
                     <div className="search-popover-empty">No results found</div>
                   </div>
                 );
              }

              if (!hasMatches && !highlightPath.length) return null;

              return (
                <div className="search-popover" role="listbox" aria-label="Search results">
                  <div className="search-popover-header">
                    <div className="search-popover-count">{highlightedNodes.length} match{highlightedNodes.length === 1 ? '' : 'es'}</div>
                    <button
                      type="button"
                      className="ui-btn secondary xs"
                      disabled={!searchPick}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        searchPick && revealGraphNode(searchPick);
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      Reveal
                    </button>
                  </div>
                  <div className="search-popover-list">
                    {searchMatches.map((m, idx) => (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={String(searchPick) === String(m.id)}
                        className={`search-popover-item ${activeSearchIndex === idx ? 'active' : ''}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleSelectMatch(m.id);
                        }}
                        onMouseEnter={() => setActiveSearchIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        title={m.label}
                      >
                        <span className="search-popover-item-label">{m.label}</span>
                        <span className="search-popover-item-meta">{m.type}</span>
                      </button>
                    ))}
                  </div>
                  {highlightPath && highlightPath.length > 1 ? (
                    <div className="search-popover-path" aria-label="Reveal path">
                      <div className="search-popover-path-label">Path</div>
                      <div className="search-popover-path-items">
                        {highlightPath.slice(Math.max(0, highlightPath.length - 7)).map((id, idx, arr) => (
                          <span key={id} className="search-popover-path-item">
                            <button
                              type="button"
                              className="search-popover-path-btn"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                revealGraphNode(id);
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              {graphLabelForId(id)}
                            </button>
                            {idx < arr.length - 1 ? <span className="search-popover-path-sep">›</span> : null}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="top-nav-actions">
          <div className="export-wrap" ref={exportWrapRef}>
            <button
              type="button"
              className="ui-btn secondary sm"
              onClick={() => setExportOpen((v) => !v)}
              aria-expanded={exportOpen}
              aria-haspopup="menu"
              disabled={!String(target || '').trim()}
            >
              Export ▾
            </button>
            {exportOpen ? (
              <div className="export-popover" role="menu" aria-label="Export options">
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  onClick={() => { setExportOpen(false); generateReportData(); }}
                >
                  Full Report (HTML)
                </button>
                <button type="button" className="export-item" role="menuitem" onClick={() => { setExportOpen(false); exportPdf(); }}>
                  PDF report
                </button>
                <div className="export-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  disabled={!statsNodes.length}
                  onClick={() => { setExportOpen(false); exportJson(); }}
                >
                  JSON (graph)
                </button>
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  disabled={!statsNodes.length}
                  onClick={() => { setExportOpen(false); exportCsv(); }}
                >
                  CSV (nodes)
                </button>
                <div className="export-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  disabled={!statsNodes.length}
                  onClick={() => { setExportOpen(false); exportPng(); }}
                >
                  PNG (snapshot)
                </button>
                <button
                  type="button"
                  className="export-item"
                  role="menuitem"
                  disabled={!statsNodes.length}
                  onClick={() => { setExportOpen(false); exportSvg(); }}
                >
                  SVG (snapshot)
                </button>
              </div>
            ) : null}
          </div>
          <div className="bookmarks-wrap" ref={bookmarksWrapRef}>
            <button
              type="button"
              className="ui-btn secondary sm"
              onClick={() => setBookmarksOpen((v) => !v)}
              aria-expanded={bookmarksOpen}
              aria-haspopup="menu"
              disabled={!statsNodes.length}
              title="Bookmarks"
            >
              ★ {bookmarkItems.length || 0}
            </button>
            {bookmarksOpen ? (
              <div className="bookmarks-popover" role="menu" aria-label="Bookmarks">
                {!bookmarkItems.length ? (
                  <div className="bookmarks-empty">No bookmarks yet</div>
                ) : (
                  <div className="bookmarks-list">
                    {bookmarkItems.slice(0, 50).map((b) => (
                      <div key={b.id} className="bookmarks-item">
                        <button
                          type="button"
                          className="bookmarks-item-main"
                          onClick={() => {
                            setBookmarksOpen(false);
                            revealGraphNode(b.id);
                          }}
                          title={b.label || b.id}
                        >
                          <div className="bookmarks-item-label">{b.label || b.id}</div>
                          <div className="bookmarks-item-meta">{b.type || 'node'}</div>
                        </button>
                        <button
                          type="button"
                          className="bookmarks-item-remove"
                          aria-label="Remove bookmark"
                          title="Remove"
                          onClick={() => toggleBookmark(b.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`ui-btn icon ghost ${graphPanelOpen ? 'active' : ''}`}
            onClick={() => setGraphPanelOpen(!graphPanelOpen)}
            aria-label="Graph Controls"
            title="Graph Controls"
          >
            🎛
          </button>
          <button
            type="button"
            className="ui-btn icon ghost"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {graphPanelOpen && <GraphSettingsPanel onClose={() => setGraphPanelOpen(false)} />}

      <div className="app-body">
        <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
	        <div className="sidebar-header">
	          <div className="sidebar-title">
	            FILTERS
	            {activeFilterGroups ? (
	              <span className="sidebar-badge" aria-label="Active filters">
	                {activeFilterGroups}
	              </span>
	            ) : null}
	          </div>
	          <button type="button" className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close filters">
	            ×
	          </button>
	        </div>

        {error && (
          <div className="ui-alert error" role="status">
            {error}
          </div>
        )}

	        <div className="sidebar-section">
	          <StatsPanel stats={stats} scan={scanMeta} />
	        </div>

	        <div className="sidebar-section">
	          <div className="sidebar-subtitle-row">
	            <div className="sidebar-subtitle">Presets</div>
	          </div>
	          <div className="sidebar-sub-actions" style={{ flexWrap: 'wrap' }}>
	            <button type="button" className="ui-btn xs secondary" onClick={() => applyPreset('all')}>All</button>
	            <button type="button" className="ui-btn xs secondary" onClick={() => applyPreset('only_endpoints')}>Only endpoints</button>
	            <button type="button" className="ui-btn xs secondary" onClick={() => applyPreset('valid_endpoints')}>Valid endpoints</button>
	            <button type="button" className="ui-btn xs secondary" onClick={() => applyPreset('errors_only')}>Errors only</button>
	          </div>
	        </div>

	        <div className="sidebar-section">
	          <div className="sidebar-subtitle-row">
	            <div className="sidebar-subtitle">Node Type</div>
	            <div className="sidebar-sub-actions">
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllTypeFilters(true)}>All</button>
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllTypeFilters(false)}>None</button>
	            </div>
	          </div>
	          <div className="sidebar-options">
	            <label className="ui-check">
	              <input
	                type="checkbox"
	                checked={!!typeFilters.host}
	                onChange={(e) => setTypeFilters((f) => ({ ...f, host: e.target.checked }))}
	              />
	              <span>Subdomain</span>
	              <span className="filter-count">{filterCounts.type.subdomain}</span>
	            </label>
	            <label className="ui-check">
	              <input
	                type="checkbox"
	                checked={!!typeFilters.dir}
	                onChange={(e) => setTypeFilters((f) => ({ ...f, dir: e.target.checked }))}
	              />
	              <span>Directory</span>
	              <span className="filter-count">{filterCounts.type.directory}</span>
	            </label>
	            <label className="ui-check">
	              <input
	                type="checkbox"
	                checked={!!typeFilters.path && !!typeFilters.file}
	                onChange={(e) => setTypeFilters((f) => ({ ...f, path: e.target.checked, file: e.target.checked }))}
	              />
	              <span>Endpoint</span>
	              <span className="filter-count">{filterCounts.type.endpoint}</span>
	            </label>
	            <label className="ui-check">
	              <input
	                type="checkbox"
	                checked={!!typeFilters.ip}
	                onChange={(e) => setTypeFilters((f) => ({ ...f, ip: e.target.checked }))}
	              />
	              <span>IP</span>
	              <span className="filter-count">{filterCounts.type.ip}</span>
	            </label>
	          </div>
	        </div>

	        <div className="sidebar-section">
	          <div className="sidebar-subtitle-row">
	            <div className="sidebar-subtitle">HTTP Status</div>
	            <div className="sidebar-sub-actions">
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllStatusFilters(true)}>All</button>
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllStatusFilters(false)}>None</button>
	            </div>
	          </div>
	          <div className="sidebar-options">
	            {statusOptions.map((code) => (
	              <label key={code} className="ui-check">
	                <input
	                  type="checkbox"
	                  checked={!!statusFilters[code]}
	                  onChange={(e) => setStatusFilters((f) => ({ ...f, [code]: e.target.checked }))}
	                />
	                <span>{code}</span>
	                <span className="filter-count">{filterCounts.status[code] || 0}</span>
	              </label>
	            ))}
	          </div>
	        </div>

	        <div className="sidebar-section">
	          <div className="sidebar-subtitle-row">
	            <div className="sidebar-subtitle">Technology</div>
	            <div className="sidebar-sub-actions">
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllTechFilters(true)}>All</button>
	              <button type="button" className="ui-btn xs ghost" onClick={() => setAllTechFilters(false)}>None</button>
	            </div>
	          </div>
	          <div className="sidebar-options">
	            {techOptions.map((tech) => (
	              <label key={tech} className="ui-check">
	                <input
	                  type="checkbox"
	                  checked={!!techFilters[tech]}
	                  onChange={(e) => setTechFilters((f) => ({ ...f, [tech]: e.target.checked }))}
	                />
	                <span>{tech}</span>
	                <span className="filter-count">{filterCounts.tech[tech] || 0}</span>
	              </label>
	            ))}
	          </div>
	        </div>

        <div className="sidebar-footer">
          <button type="button" className="ui-btn dark block" onClick={() => setSettingsOpen(true)}>
            Advanced Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="modal settings-modal">
            <div className="modal-header">
              <div className="modal-title">Settings</div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ui-btn sm secondary"
                  onClick={() => {
                    setSettingsOpen(false);
                    setScansOpen(true);
                    setHistoryTab('domains');
                    setSelectedDomain('');
                    setScansQuery('');
                    fetchDomainSummaries();
                  }}
                >
                  Scan History
                </button>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="modal-close"
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="ui-stack">
                <div className="ui-card">
                  <div className="ui-label">View</div>
                  <div className="ui-seg">
                    <button
                      type="button"
                      onClick={() => setViewMode('graph')}
                      className={`ui-btn ${viewMode === 'graph' ? 'active' : ''}`}
                    >
                      Graph
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('tree')}
                      className={`ui-btn ${viewMode === 'tree' ? 'active' : ''}`}
                    >
                      Tree
                    </button>
                  </div>
                </div>

                <div className="ui-card">
                  <div className="ui-label">Appearance</div>
                  <div className="ui-row wrap" style={{ justifyContent: 'space-between' }}>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <span>Theme</span>
                      <select value={theme} onChange={(e) => setTheme(String(e.target.value))} className="ui-select sm">
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div className="ui-card">
                  <div className="ui-label">Graph</div>
                  <div className="ui-row wrap" style={{ justifyContent: 'space-between' }}>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <span>Perspective</span>
                      <select
                        value={graphPerspective}
                        onChange={(e) => {
                          const next = String(e.target.value) === 'sitemap' ? 'sitemap' : 'attack';
                          setGraphPerspective(next);
                          setExpandedClusters(new Set());
                          setClusterReveal({});
                        }}
                        className="ui-select sm"
                        disabled={viewMode !== 'graph'}
                      >
                        <option value="attack">Attack surface</option>
                        <option value="sitemap">Sitemap</option>
                      </select>
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <span>Layout</span>
                      <select value={graphLayout} onChange={(e) => setGraphLayout(String(e.target.value))} className="ui-select sm">
                        <option value="radial">Radial</option>
                        <option value="force">Force</option>
                        <option value="hierarchical">Hierarchical</option>
                      </select>
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <input type="checkbox" checked={lockLayout} onChange={(e) => setLockLayout(e.target.checked)} />
                      <span>Lock layout</span>
                    </label>
                  </div>
                </div>

                <div className="ui-card">
                  <div className="ui-label">Clustering</div>
                  <div className="ui-row wrap">
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <input type="checkbox" checked={clusteringEnabled} onChange={(e) => setClusteringEnabled(e.target.checked)} />
                      <span>Enable clustering</span>
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <input
                        type="checkbox"
                        checked={collapseStaticAssets}
                        onChange={(e) => setCollapseStaticAssets(e.target.checked)}
                        disabled={!clusteringEnabled}
                      />
                      <span>Collapse static assets</span>
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <input
                        type="checkbox"
                        checked={collapseParamUrls}
                        onChange={(e) => setCollapseParamUrls(e.target.checked)}
                        disabled={!clusteringEnabled}
                      />
                      <span>Collapse parameter URLs</span>
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <span>Directories</span>
                      <input
                        type="number"
                        min="5"
                        max="200"
                        value={dirClusterThreshold}
                        onChange={(e) => setDirClusterThreshold(Number(e.target.value))}
                        className="ui-number"
                        disabled={!clusteringEnabled}
                      />
                    </label>
                    <label className="ui-row" style={{ fontSize: 12, color: '#9aa6b0' }}>
                      <span>URLs</span>
                      <input
                        type="number"
                        min="10"
                        max="500"
                        value={urlClusterThreshold}
                        onChange={(e) => setUrlClusterThreshold(Number(e.target.value))}
                        className="ui-number"
                        disabled={!clusteringEnabled}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {scansOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Scan history"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setScansOpen(false);
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">Scan History</div>
              <div className="modal-actions">
                <button
                  onClick={() => {
                    setHistoryTab('domains');
                    setSelectedDomain('');
                    fetchDomainSummaries();
                  }}
                  className={`ui-btn sm ${historyTab === 'domains' ? 'primary' : 'secondary'}`}
                >
                  Domains
                </button>
                <button
                  onClick={() => {
                    setHistoryTab('all');
                    fetchAllScans(0);
                  }}
                  className={`ui-btn sm ${historyTab === 'all' ? 'primary' : 'secondary'}`}
                >
                  All Scans
                </button>
              </div>
              <input
                value={scansQuery}
                onChange={(e) => setScansQuery(e.target.value)}
                placeholder="Filter by domain"
                className="ui-input sm modal-search"
              />
              <button
                onClick={() => {
                  if (historyTab === 'all') fetchAllScans(0);
                  else fetchDomainSummaries();
                }}
                className="ui-btn sm secondary"
              >
                Search
              </button>
              <button
                onClick={() => setScansOpen(false)}
                className="modal-close"
                aria-label="Close scans modal"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {scansLoading && <div className="ui-muted">Loading scans…</div>}
              {scansError && <div style={{ color: '#ff6b6b', marginBottom: 8 }}>{scansError}</div>}
              {historyTab === 'domains' && !selectedDomain && (
                <>
                  {(domainSummaries || [])
                    .filter(d => String(d.domain || '').toLowerCase().includes(scansQuery.toLowerCase()))
                    .map((domain) => (
                      <div key={domain.domain} className="ui-card ui-row wrap" style={{ marginBottom: 10 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDomain(domain.domain);
                            setHistoryTab('domains');
                            fetchDomainScans(domain.domain, 0);
                          }}
                          className="ui-link-btn"
                          title="View domain history"
                        >
                          {domain.domain}
                        </button>
                        <span className="ui-badge">{domain.lastStatus}</span>
                        <span className="ui-meta">Scans: {domain.scanCount}</span>
                        <span className="ui-meta">Last: {formatLocalTime(domain.lastScanAt)}</span>
                      </div>
                    ))}
                  {!scansLoading && !domainSummaries.length && <div className="ui-muted">No scans found.</div>}
                </>
              )}
              {historyTab === 'domains' && selectedDomain && (
                <>
                  <div className="ui-row" style={{ marginBottom: 10 }}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedDomain('');
                        fetchDomainSummaries();
                      }}
                      className="ui-btn sm secondary"
                    >
                      Back
                    </button>
                    <div style={{ color: '#e5f4f6', fontWeight: 600 }}>History: {selectedDomain}</div>
                  </div>
                  {!scansLoading && !domainScans.length && <div className="ui-muted">No scans found.</div>}
                  {domainScans.map((scan) => (
                    <div key={scan.scan_id} className="ui-card ui-stack" style={{ marginBottom: 10, gap: 6 }}>
                      <div className="ui-row wrap">
                        <div style={{ fontWeight: 600, color: '#e5f4f6' }}>{scan.target}</div>
                        <span className="ui-badge">{scan.status}</span>
                        <button
                          onClick={() => loadScanById(scan.scan_id, viewMode !== 'graph')}
                          className="ui-btn sm primary ui-ml-auto"
                        >
                          View
                        </button>
                      </div>
                      <div className="ui-row wrap ui-meta">
                        <span>Started: {formatLocalTime(scan.started_at)}</span>
                        <span>Finished: {formatLocalTime(scan.finished_at)}</span>
                        {scan.elapsed_seconds != null && <span>Elapsed: {scan.elapsed_seconds}s</span>}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {historyTab === 'all' && (
                <>
                  {!scansLoading && !scansList.length && <div className="ui-muted">No scans found.</div>}
                  {scansList
                    .filter(scan => String(scan.target || '').toLowerCase().includes(scansQuery.toLowerCase()))
                    .map((scan) => (
                      <div key={scan.scan_id} className="ui-card ui-stack" style={{ marginBottom: 10, gap: 6 }}>
                        <div className="ui-row wrap">
                          <div style={{ fontWeight: 600, color: '#e5f4f6' }}>{scan.target}</div>
                          <span className="ui-badge">{scan.status}</span>
                          <button
                            onClick={() => loadScanById(scan.scan_id, viewMode !== 'graph')}
                            className="ui-btn sm primary ui-ml-auto"
                          >
                            View
                          </button>
                        </div>
                        <div className="ui-row wrap ui-meta">
                          <span>Started: {formatLocalTime(scan.started_at)}</span>
                          <span>Finished: {formatLocalTime(scan.finished_at)}</span>
                          {scan.elapsed_seconds != null && <span>Elapsed: {scan.elapsed_seconds}s</span>}
                        </div>
                      </div>
                    ))}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button
                onClick={() => {
                  if (historyTab === 'all') {
                    fetchAllScans(Math.max(0, scansOffset - 10));
                  } else if (selectedDomain) {
                    fetchDomainScans(selectedDomain, Math.max(0, domainOffset - 10));
                  }
                }}
                disabled={(historyTab === 'all' && scansOffset === 0) || (historyTab === 'domains' && selectedDomain && domainOffset === 0)}
                className="ui-btn sm secondary"
              >
                Prev
              </button>
              <div className="ui-meta">
                {historyTab === 'all' ? `${scansOffset + 1}-${Math.min(scansOffset + 10, scansTotal)} of ${scansTotal}` : selectedDomain ? `${domainOffset + 1}-${Math.min(domainOffset + 10, domainOffset + domainScans.length)}` : ''}
              </div>
              <button
                onClick={() => {
                  if (historyTab === 'all') {
                    fetchAllScans(scansOffset + 10);
                  } else if (selectedDomain) {
                    fetchDomainScans(selectedDomain, domainOffset + 10);
                  }
                }}
                disabled={historyTab === 'all' ? scansOffset + 10 >= scansTotal : !selectedDomain || domainScans.length < 10}
                className="ui-btn sm secondary"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="main-content">
        <div className="graph-area">
          <div className="graph-body">
            {viewMode === 'tree' && (
              <div className="tree-pane">
                <TreeExplorer
                  rootNode={scanStatus.rootNode || null}
                  websiteId={currentWebsiteId}
                  onSelect={handleTreeSelect}
                  onGraphUpdate={setLazyGraphData}
                  onFocus={handleTreeFocus}
                  selectedNodeId={selectedNode?.id || null}
                />
              </div>
            )}
            <div className="graph-pane">
              {(function() {
                const nodes = (viewMode === 'tree' ? lazyGraphData?.nodes : graphData?.nodes) || [];
                if (nodes.length) return null;
                return (
                  <div className="graph-empty">
                    Run a scan or select a node to begin exploration
                  </div>
                );
              })()}
              <HierarchicalGraph
                data={(function() {
                  const sourceData = viewMode === 'tree' ? lazyGraphData : graphData;
                  let prepared = sourceData;
                  if (viewMode === 'graph' && clusteringEnabled) {
                    const pinned = new Set();
                    if (selectedGraphNodeId) pinned.add(String(selectedGraphNodeId));
                    (highlightedNodes || []).forEach((id) => pinned.add(String(id)));
                    (highlightPath || []).forEach((id) => pinned.add(String(id)));
                    try {
                      if (bookmarkedNodeIds instanceof Set) {
                        bookmarkedNodeIds.forEach((id) => pinned.add(String(id)));
                      }
                    } catch (e) {}
                    if (graphPerspective === 'attack') {
                      prepared = buildAttackSurfaceGraph(sourceData, pinned);
                    } else {
                      prepared = buildClusteredGraph(prepared, pinned);
                    }
                  } else if (viewMode === 'graph' && graphPerspective === 'attack') {
                    const pinned = new Set();
                    if (selectedGraphNodeId) pinned.add(String(selectedGraphNodeId));
                    (highlightedNodes || []).forEach((id) => pinned.add(String(id)));
                    (highlightPath || []).forEach((id) => pinned.add(String(id)));
                    try {
                      if (bookmarkedNodeIds instanceof Set) {
                        bookmarkedNodeIds.forEach((id) => pinned.add(String(id)));
                      }
                    } catch (e) {}
                    prepared = buildAttackSurfaceGraph(sourceData, pinned);
                  }
                  // Filter nodes based on current filter settings
                  const enabledTechs = Object.keys(techFilters || {}).filter((k) => techFilters[k]);
                  const techFilterActive =
                    enabledTechs.length > 0 && enabledTechs.length < Object.keys(techFilters || {}).length;
                  const visibleNodes = (prepared.nodes || []).filter(n => {
                    if (n.type === 'cluster') return true;
                    if (n.type === 'host' && n.role === 'root') return true;
                    const status = String(n.status || '').replace(/[^0-9]/g, '');
                    if (status && Object.prototype.hasOwnProperty.call(statusFilters, status) && !statusFilters[status]) return false;
                    if (n.type === 'host') {
                      if (n.role !== 'root' && Object.prototype.hasOwnProperty.call(typeFilters, 'host') && !typeFilters.host) return false;
                    } else if (n.type && Object.prototype.hasOwnProperty.call(typeFilters, n.type) && !typeFilters[n.type]) {
                      return false;
                    }
                    if (techFilterActive) {
                      const tlist = n.technologies || n.meta?.technologies || [];
                      if (Array.isArray(tlist) && tlist.length) {
                        const hasMatch = tlist.some((t) => enabledTechs.includes(String(t)));
                        if (!hasMatch) return false;
                      }
                    }
                    return true;
                  });
                  const visibleIds = new Set(visibleNodes.map(n => n.id));
                  const visibleLinks = (prepared.links || []).filter(l => {
                    const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
                    const targetId = typeof l.target === 'object' ? l.target.id : l.target;
                    return visibleIds.has(sourceId) && visibleIds.has(targetId);
                  });
                  return { nodes: visibleNodes, links: visibleLinks };
                })()}
                highlightedNodes={highlightedNodes}
                highlightPath={highlightPath}
                disableLevelSystem={viewMode === 'tree'}
                selectedNodeId={(viewMode === 'graph' ? selectedGraphNodeId : selectedNode?.id) || null}
                bookmarkedNodeIds={bookmarkedNodeIds}
                lockedNodeIds={lockedNodeIds}
                lockLayout={lockLayout}
                onToggleLock={setLockLayout}
                layoutPreset={graphLayout}
                onLayoutChange={setGraphLayout}
                onNodeClick={async (node, highlightIds) => {
                  try {
                    if (node?.type === 'cluster') {
                      if (node.clusterType === 'deeper' && node.parentId) {
                        const nextId = String(node.parentId);
                        setSelectedGraphNodeId(nextId);
                        setHighlightedNodes([nextId]);
                        try {
                          window?.graphInstance?.focusOn?.(nextId, { zoom: 2.0, duration: 520, delay: 160 });
                        } catch (e) {}
                        return;
                      }
                      const clusterId = String(node.id || '');
                      if (!clusterId) return;
                      const pageSize = Number(node.pageSize) || 60;
                      const baseShown = Math.max(0, Number(node.baseShown) || 0);
                      const shown = Math.max(baseShown, Number(node.shownCount) || 0);
                      const hidden = Math.max(0, Number(node.hiddenCount) || 0);

                      const isExpanded = expandedClusters.has(clusterId);
                      if (!isExpanded) {
                        setExpandedClusters((prev) => new Set([...prev, clusterId]));
                        setClusterReveal((prev) => ({ ...(prev || {}), [clusterId]: pageSize }));
                        return;
                      }
                      if (hidden > 0) {
                        const currentReveal = Math.max(0, shown - baseShown);
                        setClusterReveal((prev) => ({ ...(prev || {}), [clusterId]: currentReveal + pageSize }));
                        return;
                      }

                      setExpandedClusters((prev) => {
                        const next = new Set(prev);
                        next.delete(clusterId);
                        return next;
                      });
                      setClusterReveal((prev) => {
                        const next = { ...(prev || {}) };
                        delete next[clusterId];
                        return next;
                      });
                      return;
                    }
                    setSelectedGraphNodeId(node?.id || null);

                    // Update highlight path to clicked node
                    const rootNode = (graphData?.nodes || []).find((n) => n.type === 'host' && n.role === 'root') || graphData?.nodes?.[0];
                    if (rootNode?.id && node?.id) {
                       const path = findShortestPath(rootNode.id, node.id);
                       setHighlightPath(path);
                    } else {
                       setHighlightPath([]);
                    }

                    const apiId = node.apiId || node.id;
                    if (currentWebsiteId && apiId !== undefined && apiId !== null) {
                      const encodedNodeId = encodeURIComponent(apiId);
                      const res = await axios.get(`http://localhost:3001/websites/${currentWebsiteId}/nodes/${encodedNodeId}`);
                      setSelectedNode(res.data.node || node);
                    } else {
                      setSelectedNode(node);
                    }
                  } catch (e) {
                    console.error('Failed to fetch node details', e);
                    setSelectedNode(node);
                  }

                  setHighlightedNodes(highlightIds || [node.id]);
                }}
              />
              <LegendPanel perspective={graphPerspective} />
            </div>
          </div>
        </div>
        {/* Details panel rendered alongside graph */}
      {(selectedNode || (showScanBanner && scanPanelOpen)) && (
          <DetailsPanel
            node={selectedNode}
            bookmarked={(function() {
              if (!selectedNode) return false;
              const id = viewMode === 'graph' ? (selectedGraphNodeId || '') : String(selectedNode.id || '');
              return id ? isBookmarked(id) : false;
            })()}
            onToggleBookmark={(function() {
              if (!selectedNode) return null;
              return () => {
                const id = viewMode === 'graph' ? (selectedGraphNodeId || '') : String(selectedNode.id || '');
                if (!id) return;
                const graphNode = (graphData?.nodes || []).find((n) => String(n.id) === String(id)) || null;
                const label = graphNode ? (graphNode.fullLabel || graphNode.label || graphNode.id) : (selectedNode.value || selectedNode.id);
                const type = graphNode ? (graphNode.type === 'host' ? (graphNode.role === 'subdomain' ? 'subdomain' : 'domain') : graphNode.type) : String(selectedNode.type || '');
                toggleBookmark(id, { label, type });
              };
            })()}
            locked={(function() {
              if (!selectedNode) return false;
              const id = viewMode === 'graph' ? (selectedGraphNodeId || '') : String(selectedNode.id || '');
              return id ? isLocked(id) : false;
            })()}
            onToggleLock={(function() {
              if (!selectedNode) return null;
              return () => {
                const id = viewMode === 'graph' ? (selectedGraphNodeId || '') : String(selectedNode.id || '');
                if (!id) return;
                toggleLock(id);
              };
            })()}
            relations={(function() {
              const startId = viewMode === 'graph' ? selectedGraphNodeId : null;
              if (!startId) return [];
              const nodes = graphData?.nodes || [];
              const links = graphData?.links || [];
              const nodeMap = new Map(nodes.map((n) => [String(n.id), n]));
              const neighborIds = new Set();
              links.forEach((l) => {
                const src = String(typeof l.source === 'object' ? l.source.id : l.source);
                const tgt = String(typeof l.target === 'object' ? l.target.id : l.target);
                if (src === String(startId)) neighborIds.add(tgt);
                if (tgt === String(startId)) neighborIds.add(src);
              });
              const rank = (n) => {
                const t = String(n?.type || '');
                if (t === 'path' || t === 'file') return 1;
                if (t === 'dir') return 2;
                if (t === 'ip') return 3;
                if (t === 'host') return 4;
                return 9;
              };
              return Array.from(neighborIds)
                .map((id) => nodeMap.get(String(id)))
                .filter(Boolean)
                .sort((a, b) => {
                  const ra = rank(a);
                  const rb = rank(b);
                  if (ra !== rb) return ra - rb;
                  const al = String(a.fullLabel || a.label || a.id || '');
                  const bl = String(b.fullLabel || b.label || b.id || '');
                  return al.localeCompare(bl);
                })
                .map((n) => ({
                  id: n.id,
                  type: n.type === 'host' ? (n.role === 'subdomain' ? 'subdomain' : 'host') : n.type,
                  label: n.fullLabel || n.label || n.id,
                  fullLabel: n.fullLabel || n.label || n.id
                }));
            })()}
            scan={showScanBanner && scanPanelOpen ? {
              scanId,
              target,
              status: scanStatus.status || 'running',
              startedAt: scanStatus.startedAt,
              lastUpdateAt: scanStatus.updatedAt,
              currentStage: scanStatus.stage || 'start',
              stageLabel: scanStatus.stageLabel,
              message: scanStatus.message,
              currentTarget: scanStatus.currentTarget,
            logLines: scanStatus.logTail,
            stageMeta: {
              ...(scanProgress?.subdomains?.done != null ? { subdomains: { count: scanProgress.subdomains.done } } : {}),
              ...(scanProgress?.directories?.done != null ? { directories: { count: scanProgress.directories.done } } : {}),
              ...(scanProgress?.endpoints?.done != null ? { hyperhtml: { count: scanProgress.endpoints.done } } : {}),
              ...(scanStatus.stage === 'build_graph' && scanStatus.message ? { build_graph: { message: scanStatus.message } } : {}),
              ...(scanStatus.stageLabel === 'Failed' ? {
                [scanStatus.stage === 'html_links' ? 'hyperhtml' : scanStatus.stage === 'dirs' ? 'directories' : scanStatus.stage]: { message: scanStatus.message }
              } : {}),
              ...(scanStatus.stageMeta || {})
            },
            onClose: () => setScanPanelOpen(false),
            onCancel: handleCancelScan,
            canCancel: scanStatus.status === 'running' || scanStatus.status === 'cancelling',
            cancelling: scanCancelling
          } : null}
            onClose={() => {
              setSelectedNode(null);
              setSelectedGraphNodeId(null);
              setTimeout(() => {
                try {
                  if (window?.graphInstance?.manualFit) {
                    window.graphInstance.manualFit(400, 100, 80);
                  }
                } catch (e) {
                  console.debug('manualFit on close failed', e);
                }
              }, 1000);
            }}
          />
        )}
      </div>
      </div>
    </div>
  );
}