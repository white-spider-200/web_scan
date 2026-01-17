import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './TreeExplorer.css';
import axios from 'axios';

const API_BASE = 'http://localhost:3001';

const typeLabel = (type) => {
  if (!type) return 'url';
  if (type === 'domain') return 'domain';
  if (type === 'subdomain') return 'subdomain';
  if (type === 'directory' || type === 'dir') return 'directory';
  if (type === 'endpoint' || type === 'path' || type === 'file') return 'url';
  return type;
};

const normalizeGroupType = (nodeType) => {
  if (nodeType === 'subdomain') return 'subdomain';
  if (nodeType === 'directory' || nodeType === 'dir') return 'directory';
  return 'url';
};

const getNodeIcon = (node) => {
  if (!node) return '📄';
  if (node.type === 'domain') return '🛰';
  if (node.type === 'subdomain') return '🖥';
  if (node.type === 'directory' || node.type === 'dir') return '📁';
  return '📄';
};

const getOpenUrl = (node) => {
  if (!node?.value) return null;
  const raw = String(node.value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return null;
  return `http://${raw}`;
};

const isExpandableNode = (node) => {
  if (!node?.has_children) return false;
  const t = String(node.type || '').toLowerCase();
  return t === 'domain' || t === 'subdomain' || t === 'directory' || t === 'dir';
};

const getDefaultAutoGroups = (node) => {
  const t = String(node?.type || '').toLowerCase();
  if (t === 'domain') return ['subdomain', 'directory'];
  if (t === 'subdomain' || t === 'directory' || t === 'dir') return ['directory'];
  return [];
};

const buildStatusSummary = (statusCounts) => {
  const entries = Object.entries(statusCounts || {}).filter(([, v]) => v > 0);
  if (!entries.length) return '';
  return entries.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' • ');
};

export const TreeExplorer = ({ rootNode, websiteId, onSelect, onGraphUpdate, onFocus, selectedNodeId }) => {
  const [rootId, setRootId] = useState(null);
  const [nodesById, setNodesById] = useState(new Map());
  const [childrenByGroup, setChildrenByGroup] = useState(new Map());
  const [countsByParent, setCountsByParent] = useState(new Map());
  const [nextCursorByGroup, setNextCursorByGroup] = useState(new Map());
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [loading, setLoading] = useState(new Set());
  const [errors, setErrors] = useState(new Map());
  const [selectedId, setSelectedId] = useState(null);
  const [showEmptyGroups, setShowEmptyGroups] = useState(false);
  const [autoCollapseSiblings, setAutoCollapseSiblings] = useState(false);
  const [compactFolders, setCompactFolders] = useState(false);
  const [autoOpenGroups, setAutoOpenGroups] = useState(true);
  const [branchQuery, setBranchQuery] = useState('');
  const [breadcrumb, setBreadcrumb] = useState([]);
  const nodeRefs = useRef(new Map());

  const DEFAULT_LIMIT = 120;

  const fetchSummary = useCallback(async (parentId) => {
    if (!websiteId || !parentId) return;
    if (countsByParent.has(parentId)) return;
    setLoading(prev => new Set(prev).add(`summary:${parentId}`));
    try {
      const params = new URLSearchParams({ parent_id: String(parentId) });
      const res = await axios.get(`${API_BASE}/api/nodes/summary?${params.toString()}`);
      const counts = res.data?.counts || { subdomains: 0, directories: 0, urls: 0 };
      const statusCounts = res.data?.status_counts || { urls: {} };
      setCountsByParent(prev => {
        const next = new Map(prev);
        next.set(parentId, { ...counts, statusCounts });
        return next;
      });
    } catch (e) {
      setErrors(prev => {
        const next = new Map(prev);
        next.set(`summary:${parentId}`, 'Failed to load');
        return next;
      });
    } finally {
      setLoading(prev => {
        const next = new Set(prev);
        next.delete(`summary:${parentId}`);
        return next;
      });
    }
  }, [websiteId, countsByParent]);

  const fetchChildren = useCallback(async (parentId, type, options = {}) => {
    if (!websiteId || !parentId || !type) return;
    const { append = false, cursor = 0 } = options;
    const key = `${parentId}:${type}`;
    if (!append && childrenByGroup.has(key)) return;
    setErrors(prev => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setLoading(prev => new Set(prev).add(key));
    try {
      const params = new URLSearchParams({
        parent_id: String(parentId),
        type,
        limit: String(DEFAULT_LIMIT),
        cursor: String(append ? cursor : 0)
      });
      const res = await axios.get(`${API_BASE}/api/nodes?${params.toString()}`);
      const nodes = Array.isArray(res.data?.nodes) ? res.data.nodes : [];
      const nextCursor = res.data?.next_cursor ?? null;
      setNodesById(prev => {
        const next = new Map(prev);
        nodes.forEach(n => next.set(n.id, n));
        return next;
      });
      setChildrenByGroup(prev => {
        const next = new Map(prev);
        if (append) {
          const existing = next.get(key) || [];
          const merged = [...existing, ...nodes.map(n => n.id)];
          next.set(key, Array.from(new Set(merged)));
        } else {
          next.set(key, nodes.map(n => n.id));
        }
        return next;
      });
      setNextCursorByGroup(prev => {
        const next = new Map(prev);
        next.set(key, nextCursor);
        return next;
      });
    } catch (e) {
      setErrors(prev => {
        const next = new Map(prev);
        next.set(key, 'Failed to load');
        return next;
      });
    } finally {
      setLoading(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [websiteId, childrenByGroup, DEFAULT_LIMIT]);

  useEffect(() => {
    const normalizedRoot = rootNode ? { ...rootNode, id: String(rootNode.id) } : null;
    setRootId(normalizedRoot?.id || null);
    setNodesById(new Map(normalizedRoot ? [[normalizedRoot.id, normalizedRoot]] : []));
    setChildrenByGroup(new Map());
    setCountsByParent(new Map());
    setNextCursorByGroup(new Map());
    setExpandedNodes(new Set());
    setExpandedGroups(new Set());
    setSelectedId(null);
    setBreadcrumb([]);
    setBranchQuery('');
  }, [rootNode]);

  useEffect(() => {
    if (selectedNodeId == null) return;
    const nextId = String(selectedNodeId);
    if (nextId !== selectedId) setSelectedId(nextId);
  }, [selectedNodeId, selectedId]);

  const getGroupChildren = useCallback((parentId, type) => {
    const key = `${parentId}:${type}`;
    const childIds = childrenByGroup.get(key) || [];
    return childIds.map(id => nodesById.get(id)).filter(Boolean);
  }, [childrenByGroup, nodesById]);

  const getCounts = useCallback((parentId) => countsByParent.get(parentId) || { subdomains: 0, directories: 0, urls: 0, statusCounts: { urls: {} } }, [countsByParent]);

  const collapseBranch = useCallback((parentId) => {
    const nextExpandedNodes = new Set(expandedNodes);
    const nextExpandedGroups = new Set(expandedGroups);
    const toVisit = [parentId];
    while (toVisit.length) {
      const cur = toVisit.pop();
      nextExpandedNodes.delete(cur);
      nextExpandedGroups.delete(`group:${cur}:subdomain`);
      nextExpandedGroups.delete(`group:${cur}:directory`);
      nextExpandedGroups.delete(`group:${cur}:url`);
      ['subdomain', 'directory', 'url'].forEach(type => {
        const key = `${cur}:${type}`;
        const childIds = childrenByGroup.get(key) || [];
        childIds.forEach(childId => toVisit.push(childId));
      });
    }
    setExpandedNodes(nextExpandedNodes);
    setExpandedGroups(nextExpandedGroups);
  }, [expandedNodes, expandedGroups, childrenByGroup]);

  const collapseSiblings = useCallback((parentId, excludeId) => {
    if (!parentId) return;
    ['subdomain', 'directory', 'url'].forEach(type => {
      const children = getGroupChildren(parentId, type);
      children.forEach(child => {
        if (child.id !== excludeId) collapseBranch(child.id);
      });
    });
  }, [getGroupChildren, collapseBranch]);

  const toggleNode = useCallback((node) => {
    if (!isExpandableNode(node)) return;
    const isExpanded = expandedNodes.has(node.id);
    if (isExpanded) {
      collapseBranch(node.id);
      return;
    }
    if (autoCollapseSiblings && node.parent_id) {
      collapseSiblings(node.parent_id, node.id);
    }
    setExpandedNodes(prev => new Set(prev).add(node.id));
    if (!countsByParent.has(node.id)) fetchSummary(node.id);
    if (autoOpenGroups) {
      const groups = getDefaultAutoGroups(node);
      if (groups.length) {
        setExpandedGroups(prev => {
          const next = new Set(prev);
          groups.forEach(type => next.add(`group:${node.id}:${type}`));
          return next;
        });
        groups.forEach(type => fetchChildren(node.id, type));
      }
    }
  }, [expandedNodes, autoCollapseSiblings, countsByParent, autoOpenGroups, collapseBranch, collapseSiblings, fetchSummary, fetchChildren]);

  const toggleGroup = useCallback((groupId, parentId, type, count) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        if (autoCollapseSiblings) {
          ['subdomain', 'directory', 'url'].forEach(t => {
            if (t !== type) next.delete(`group:${parentId}:${t}`);
          });
        }
        next.add(groupId);
        if (count > 0) fetchChildren(parentId, type);
      }
      return next;
    });
  }, [autoCollapseSiblings, fetchChildren]);

  const selectNode = useCallback((node) => {
    setSelectedId(node?.id ?? null);
    if (onSelect) onSelect(node);
  }, [onSelect]);

  const fetchPath = useCallback(async (nodeId) => {
    if (!nodeId) return [];
    try {
      const params = new URLSearchParams({ node_id: String(nodeId) });
      const res = await axios.get(`${API_BASE}/api/nodes/path?${params.toString()}`);
      const path = Array.isArray(res.data?.path) ? res.data.path : [];
      setNodesById(prev => {
        const next = new Map(prev);
        path.forEach(n => {
          const existing = next.get(n.id);
          if (!existing) {
            next.set(n.id, n);
            return;
          }
          next.set(n.id, { ...existing, ...n });
        });
        return next;
      });
      return path;
    } catch (e) {
      return [];
    }
  }, []);

  const revealNode = useCallback(async (nodeId) => {
    const path = await fetchPath(nodeId);
    if (!path.length) return;
    setBreadcrumb(path);
    for (let i = 0; i < path.length - 1; i++) {
      const parent = path[i];
      const child = path[i + 1];
      if (!parent?.id || !child?.id) continue;
      if (!countsByParent.has(parent.id)) {
        await fetchSummary(parent.id);
      }
      setExpandedNodes(prev => new Set(prev).add(parent.id));
      const groupType = normalizeGroupType(child.type);
      setExpandedGroups(prev => new Set(prev).add(`group:${parent.id}:${groupType}`));
      await fetchChildren(parent.id, groupType);
    }
    const target = path[path.length - 1];
    if (target?.id) {
      setSelectedId(target.id);
      if (onSelect) onSelect(target);
      setTimeout(() => {
        const el = nodeRefs.current.get(target.id);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center' });
        }
      }, 150);
    }
  }, [fetchPath, countsByParent, fetchSummary, fetchChildren, onSelect]);

  useEffect(() => {
    if (!selectedId) {
      setBreadcrumb([]);
      return;
    }
    fetchPath(selectedId).then((path) => {
      if (path.length) setBreadcrumb(path);
    });
  }, [selectedId, fetchPath]);

  const renderGroupChips = useCallback((parentId, counts, depth) => {
    const items = [
      { label: 'Subdomains', type: 'subdomain', count: counts.subdomains, icon: '🛰' },
      { label: 'Directories', type: 'directory', count: counts.directories, icon: '📁' },
      { label: 'URLs', type: 'url', count: counts.urls, icon: '🔗', statusCounts: counts.statusCounts?.urls || {} }
    ].filter(item => showEmptyGroups || item.count > 0);

    if (!items.length) return null;

    return (
      <div className="tree-group-row" style={{ paddingLeft: (depth + 1) * 16 }}>
        {items.map(item => {
          const groupId = `group:${parentId}:${item.type}`;
          const isExpanded = expandedGroups.has(groupId);
          const isLoading = loading.has(`${parentId}:${item.type}`);
          const isEmpty = item.count === 0;
          const statusText = item.type === 'url' ? buildStatusSummary(item.statusCounts) : '';
          return (
            <button
              key={groupId}
              type="button"
              className={`tree-chip ${isExpanded ? 'active' : ''} ${isEmpty ? 'empty' : ''}`}
              onClick={() => toggleGroup(groupId, parentId, item.type, item.count)}
              title={item.label}
            >
              <span className="tree-chip-icon">{isLoading ? '⏳' : item.icon}</span>
              <span>{item.label} ({item.count})</span>
              {statusText ? <span className="tree-chip-meta">{statusText}</span> : null}
            </button>
          );
        })}
      </div>
    );
  }, [showEmptyGroups, expandedGroups, loading, toggleGroup]);

  const getMetaText = useCallback((node) => {
    const parts = [typeLabel(node.type)];
    if (node.status != null) parts.push(String(node.status));
    if (node.technologies && node.technologies.length) parts.push(node.technologies[0]);
    return parts.join(' • ');
  }, []);

  const shouldRenderNode = useCallback((nodeId, term, memo) => {
    if (!term) return true;
    if (!nodeId) return false;
    if (memo.has(nodeId)) return memo.get(nodeId);
    const node = nodesById.get(nodeId);
    const label = String(node?.label || '').toLowerCase();
    const matchesSelf = label.includes(term);
    const children = ['subdomain', 'directory', 'url']
      .flatMap(type => getGroupChildren(nodeId, type).map(child => child.id));
    const matchesChild = children.some(childId => shouldRenderNode(childId, term, memo));
    const match = matchesSelf || matchesChild;
    memo.set(nodeId, match);
    return match;
  }, [nodesById, getGroupChildren]);

  const getCompactLabel = useCallback((nodeId) => {
    if (!compactFolders) return { nodeId, label: nodesById.get(nodeId)?.label };
    let currentId = nodeId;
    let label = nodesById.get(currentId)?.label || '';
    while (true) {
      const current = nodesById.get(currentId);
      if (!current || !(current.type === 'directory' || current.type === 'dir')) break;
      const counts = countsByParent.get(currentId);
      if (!counts || counts.subdomains !== 0 || counts.urls !== 0 || counts.directories !== 1) break;
      const childList = getGroupChildren(currentId, 'directory');
      if (childList.length !== 1) break;
      const child = childList[0];
      if (!child) break;
      label = `${label}/${child.label}`;
      currentId = child.id;
    }
    return { nodeId: currentId, label };
  }, [compactFolders, nodesById, countsByParent, getGroupChildren]);

  const renderNode = useCallback((nodeId, depth, term, memo) => {
    const node = nodesById.get(nodeId);
    if (!node) return null;
    if (term && !shouldRenderNode(nodeId, term, memo)) {
      return null;
    }
    const compactInfo = getCompactLabel(nodeId);
    const displayNode = nodesById.get(compactInfo.nodeId) || node;
    const displayId = displayNode.id;
    const isExpanded = expandedNodes.has(displayId);
    const isLoading = loading.has(`summary:${displayId}`);
    const error = errors.get(`summary:${displayId}`);
    const toggleVisible = isExpandableNode(displayNode) || isLoading;
    const counts = getCounts(displayId);
    const hasCounts = countsByParent.has(displayId);
    return (
      <div key={nodeId}>
        <div
          className={`tree-node-row ${selectedId === displayId ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 16 }}
          onClick={() => selectNode(displayNode)}
          onDoubleClick={() => toggleNode(displayNode)}
          ref={(el) => {
            if (el) nodeRefs.current.set(displayId, el);
          }}
        >
          <button
            type="button"
            className={`tree-node-toggle ${!toggleVisible ? 'hidden' : ''} ${isLoading ? 'loading' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleNode(displayNode);
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isLoading ? '⏳' : (isExpanded ? '−' : '+')}
          </button>
          <div className="tree-node-icon">{getNodeIcon(displayNode)}</div>
          <div>
            <div className="tree-node-label">{compactInfo.label}</div>
            <div className="tree-node-meta">{getMetaText(displayNode)}</div>
          </div>
          <div className="tree-node-actions">
            {displayNode?.value && (
              <button
                type="button"
                className="tree-action"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard?.writeText(String(displayNode.value));
                }}
                title="Copy"
              >
                ⧉
              </button>
            )}
            {getOpenUrl(displayNode) && (
              <button
                type="button"
                className="tree-action"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(getOpenUrl(displayNode), '_blank');
                }}
                title="Open"
              >
                ↗
              </button>
            )}
            {onFocus && (
              <button
                type="button"
                className="tree-action"
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus(displayNode);
                }}
                title="Focus"
              >
                ◎
              </button>
            )}
          </div>
        </div>
        {isExpanded && error && (
          <div className="tree-error" style={{ paddingLeft: (depth + 1) * 16 }}>
            {error}
          </div>
        )}
        {isExpanded && !isLoading && !error && displayNode.has_children && hasCounts && (
          <div className="tree-node-indent">
            {renderGroupChips(displayId, counts, depth)}
            {!showEmptyGroups && counts.subdomains === 0 && counts.directories === 0 && counts.urls === 0 && (
              <div className="tree-empty" style={{ paddingLeft: (depth + 2) * 16 }}>
                No children found
              </div>
            )}
            {['subdomain', 'directory', 'url'].map(typeKey => {
              const groupId = `group:${displayId}:${typeKey}`;
              if (!expandedGroups.has(groupId)) return null;
              const groupChildren = getGroupChildren(displayId, typeKey);
              const key = `${displayId}:${typeKey}`;
              const isGroupLoading = loading.has(key);
              const groupError = errors.get(key);
              const count = typeKey === 'subdomain' ? counts.subdomains : typeKey === 'directory' ? counts.directories : counts.urls;
              const nextCursor = nextCursorByGroup.get(key);
              return (
                <div key={groupId}>
                  {groupError && (
                    <div className="tree-error" style={{ paddingLeft: (depth + 2) * 16 }}>
                      {groupError}
                    </div>
                  )}
                  {!groupError && count === 0 && (
                    <div className="tree-empty" style={{ paddingLeft: (depth + 2) * 16 }}>
                      No children found
                    </div>
                  )}
                  {!groupError && count > 0 && (
                    <div className="tree-node-indent">
                      {groupChildren.map(child => renderNode(child.id, depth + 2, term, memo))}
                      {isGroupLoading && (
                        <div className="tree-empty" style={{ paddingLeft: (depth + 2) * 16 }}>
                          Loading…
                        </div>
                      )}
                      {nextCursor != null && (
                        <button
                          type="button"
                          className="tree-load-more"
                          style={{ paddingLeft: (depth + 2) * 16 }}
                          onClick={() => fetchChildren(displayId, typeKey, { append: true, cursor: nextCursor })}
                        >
                          Load more…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {isExpanded && !isLoading && !error && displayNode.has_children && !hasCounts && (
          <div className="tree-empty" style={{ paddingLeft: (depth + 1) * 16 }}>
            Loading children…
          </div>
        )}
      </div>
    );
  }, [nodesById, shouldRenderNode, getCompactLabel, selectedId, loading, errors, getCounts, selectNode, toggleNode, renderGroupChips, showEmptyGroups, expandedGroups, expandedNodes, countsByParent, getGroupChildren, nextCursorByGroup, fetchChildren, onFocus, getMetaText]);

  const graphData = useMemo(() => {
    const nodes = [];
    const links = [];
    if (!rootId) return { nodes, links };
    const visible = new Set();

    const addNode = (nodeId) => {
      if (visible.has(nodeId)) return;
      const node = nodesById.get(nodeId);
      if (!node) return;
      visible.add(nodeId);
      const ntype = node.type === 'domain' || node.type === 'subdomain' ? 'host' : node.type === 'directory' ? 'dir' : 'path';
      const role = node.type === 'domain' ? 'root' : node.type === 'subdomain' ? 'subdomain' : undefined;
      nodes.push({
        id: node.id,
        label: node.label,
        type: ntype,
        role,
        status: node.status != null ? node.status : 200,
        apiId: node.id
      });
    };

    const walk = (parentId) => {
      addNode(parentId);
      if (!expandedNodes.has(parentId)) return;
      const groupMap = {
        subdomain: `group:${parentId}:subdomain`,
        directory: `group:${parentId}:directory`,
        url: `group:${parentId}:url`
      };
      ['subdomain', 'directory', 'url'].forEach((type) => {
        if (!expandedGroups.has(groupMap[type])) return;
        const list = getGroupChildren(parentId, type);
        list.forEach(child => {
          addNode(child.id);
          links.push({ source: parentId, target: child.id, type: 'contains' });
          walk(child.id);
        });
      });
    };

    walk(rootId);
    return { nodes, links };
  }, [rootId, nodesById, getGroupChildren, expandedNodes, expandedGroups]);

  useEffect(() => {
    if (onGraphUpdate) onGraphUpdate(graphData);
  }, [graphData, onGraphUpdate]);

  const content = useMemo(() => {
    if (!rootId) return <div className="tree-empty">Root not available.</div>;
    const term = branchQuery.trim().toLowerCase();
    const memo = new Map();
    const renderRoot = term && selectedId ? selectedId : rootId;
    const node = renderNode(renderRoot, 0, term, memo);
    if (!node) return <div className="tree-empty">No matches.</div>;
    return node;
  }, [rootId, selectedId, branchQuery, renderNode]);

  return (
    <div className="tree-explorer">
      <div className="tree-explorer-header">
        <div className="tree-explorer-title">Scan Tree</div>
      </div>
      <div className="tree-toolbar">
        <input
          type="text"
          className="tree-search"
          placeholder={selectedId ? 'Filter selected branch' : 'Filter tree'}
          value={branchQuery}
          onChange={(e) => setBranchQuery(e.target.value)}
        />
        <div className="tree-toggles">
          <label>
            <input
              type="checkbox"
              checked={showEmptyGroups}
              onChange={(e) => setShowEmptyGroups(e.target.checked)}
            />
            Show empty
          </label>
          <label>
            <input
              type="checkbox"
              checked={autoOpenGroups}
              onChange={(e) => setAutoOpenGroups(e.target.checked)}
            />
            Auto-open
          </label>
          <label>
            <input
              type="checkbox"
              checked={autoCollapseSiblings}
              onChange={(e) => setAutoCollapseSiblings(e.target.checked)}
            />
            Auto-collapse
          </label>
          <label>
            <input
              type="checkbox"
              checked={compactFolders}
              onChange={(e) => setCompactFolders(e.target.checked)}
            />
            Compact
          </label>
        </div>
      </div>
      <div className="tree-breadcrumb">
        {breadcrumb.length ? (
          <>
            <div className="tree-breadcrumb-path">
              {breadcrumb.map((node, idx) => (
                <span key={node.id}>
                  {node.label}
                  {idx < breadcrumb.length - 1 ? ' > ' : ''}
                </span>
              ))}
            </div>
            <button type="button" className="tree-reveal" onClick={() => selectedId && revealNode(selectedId)}>
              Reveal in tree
            </button>
          </>
        ) : (
          <div className="tree-empty">Select a node to see its path.</div>
        )}
      </div>
      {content}
    </div>
  );
};