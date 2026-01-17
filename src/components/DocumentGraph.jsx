import React, { useRef, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceManyBody, forceCollide, forceLink, forceCenter } from 'd3-force';
import './DocumentGraph.css';

export const DocumentGraph = ({ graphData = null, onNodeClick = null }) => {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [isPhysicsLocked, setIsPhysicsLocked] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const didAutoFitRef = useRef(false);

  // Load graph data from JSON
  const [data, setData] = useState(graphData);

  useEffect(() => {
    if (!graphData) {
      // Try to fetch from server
      fetch('/document_graph.json')
        .then(r => r.json())
        .then(d => setData(d))
        .catch(e => console.warn('Could not load document graph:', e));
    }
  }, [graphData]);

  // Handle resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resize = () => {
      const r = el.getBoundingClientRect();
      setSize({
        width: Math.max(200, Math.floor(r.width)),
        height: Math.max(200, Math.floor(r.height))
      });
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Configure forces
  useEffect(() => {
    if (!fgRef.current || !data?.nodes?.length) return;

    const fg = fgRef.current;

    if (isPhysicsLocked) {
      // Disable all forces
      fg.d3Force('center', null);
      fg.d3Force('charge', null);
      fg.d3Force('link', null);
      fg.d3Force('collision', null);

      // Stop simulation
      try {
        const sim = fg.d3Simulation();
        if (sim) {
          sim.stop();
          sim.alpha(0);
        }
      } catch (e) {
        // Simulation might not be ready
      }
      return;
    }

    // Enable forces
    try {
      const sim = fg.d3Simulation();
      if (sim) {
        sim.restart();
        sim.alpha(0.3);
      }
    } catch (e) {
      // Simulation might not be ready
    }

    // Charge force - repulsion by node type
    fg.d3Force('charge',
      forceManyBody().strength(node => {
        if (node.type === 'file') return -1000;
        if (node.type === 'heading') return -500;
        if (node.type === 'function') return -300;
        return -200;
      })
    );

    // Link force - attraction
    fg.d3Force('link',
      forceLink()
        .id(d => d.id)
        .distance(link => {
          if (link.type === 'contains') return 80;
          if (link.type === 'defines') return 100;
          return 120;
        })
        .strength(0.2)
    );

    // Center force
    fg.d3Force('center',
      forceCenter(size.width / 2, size.height / 2).strength(0.05)
    );

    // Collision force
    fg.d3Force('collision', forceCollide(20));

    // Auto-fit on first load
    if (!didAutoFitRef.current) {
      const timeout = setTimeout(() => {
        if (fg.zoomToFit) {
          fg.zoomToFit(400, 50);
          didAutoFitRef.current = true;
        }
      }, 300);
      return () => clearTimeout(timeout);
    }
  }, [data, size.width, size.height, isPhysicsLocked]);

  // Filter data based on search and type
  const filteredData = React.useMemo(() => {
    if (!data) return null;

    let nodes = data.nodes;
    let edges = data.edges;

    // Filter by type
    if (filterType !== 'all') {
      const nodeIds = new Set(
        nodes
          .filter(n => filterType === 'files' ? n.type === 'file' : n.type === filterType)
          .map(n => n.id)
      );

      nodes = nodes.filter(n =>
        nodeIds.has(n.id) ||
        edges.some(e => nodeIds.has(e.source) || nodeIds.has(e.target))
      );
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const nodeIds = new Set(
        nodes
          .filter(n =>
            n.title.toLowerCase().includes(query) ||
            n.path.toLowerCase().includes(query) ||
            (n.tags && n.tags.some(t => t.toLowerCase().includes(query)))
          )
          .map(n => n.id)
      );

      nodes = nodes.filter(n => nodeIds.has(n.id));
    }

    edges = edges.filter(e =>
      nodes.some(n => n.id === e.source) &&
      nodes.some(n => n.id === e.target)
    );

    return { nodes, edges };
  }, [data, filterType, searchQuery]);

  // Handle node click
  const handleNodeClick = (node) => {
    if (!node) return;
    setSelectedNode(node);

    if (!fgRef.current) return;
    if (fgRef.current.centerAt && fgRef.current.zoom) {
      fgRef.current.centerAt(node.x, node.y, 400);
      fgRef.current.zoom(1.6, 400);
    }

    if (onNodeClick) {
      onNodeClick(node);
    }
  };

  // Handle node drag
  const handleNodeDrag = (node, translate) => {
    if (!node) return;
    node.fx = translate.x;
    node.fy = translate.y;
  };

  const handleNodeDragEnd = (node) => {
    if (!node) return;
    if (isPhysicsLocked) {
      // Keep node pinned
      node.fx = node.x;
      node.fy = node.y;
    } else {
      // Release for physics
      node.fx = undefined;
      node.fy = undefined;
    }
  };

  // Zoom controls
  const handleZoom = (type) => {
    if (!fgRef.current) return;

    const fg = fgRef.current;
    const currentZoom = fg.zoom();

    switch (type) {
      case 'in':
        fg.zoom(currentZoom * 1.5, 400);
        break;
      case 'out':
        fg.zoom(currentZoom / 1.5, 400);
        break;
      case 'home':
        fg.zoomToFit(400, 50);
        break;
      default:
        break;
    }
  };

  // Get node color
  const getNodeColor = (node) => {
    switch (node.type) {
      case 'file': return 'rgba(255,255,255,0.95)';
      case 'heading': return 'rgba(45,226,230,0.95)';
      case 'function': return 'rgba(251,146,60,0.95)';
      case 'class': return 'rgba(99,102,241,0.95)';
      default: return '#bbb';
    }
  };

  // Get link color
  const getLinkColor = (link) => {
    switch (link.type) {
      case 'contains': return 'rgba(45,226,230,0.4)';
      case 'defines': return 'rgba(251,146,60,0.4)';
      case 'references': return 'rgba(168,85,247,0.4)';
      default: return 'rgba(255,255,255,0.1)';
    }
  };

  const getLinkWidth = (link) => {
    switch (link.type) {
      case 'contains':
      case 'defines':
        return 2;
      case 'references':
        return 1.5;
      default:
        return 1;
    }
  };

  if (!filteredData) {
    return (
      <div ref={containerRef} className="document-graph-container">
        <div className="loading">Loading document graph...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="document-graph-container">
      <div className="graph-toolbar">
        <div className="controls">
          <button onClick={() => handleZoom('in')} title="Zoom In">+</button>
          <button onClick={() => handleZoom('out')} title="Zoom Out">−</button>
          <button onClick={() => handleZoom('home')} title="Reset View" className="home-button">⌂</button>
          <button
            onClick={() => setIsPhysicsLocked(!isPhysicsLocked)}
            title={isPhysicsLocked ? "Unlock Physics" : "Lock Physics"}
            className={`lock-button ${isPhysicsLocked ? 'locked' : 'unlocked'}`}
          >
            {isPhysicsLocked ? '🔒' : '🔓'}
          </button>
        </div>

        <div className="search-panel">
          <input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Types</option>
            <option value="file">Files</option>
            <option value="heading">Headings</option>
            <option value="function">Functions</option>
            <option value="class">Classes</option>
          </select>
        </div>

        <div className="stats">
          Nodes: {filteredData.nodes.length} | Edges: {filteredData.edges.length}
        </div>
      </div>

      <ForceGraph2D
        ref={fgRef}
        graphData={filteredData}
        nodeLabel={node => node.title}
        nodeRelSize={6}
        nodeColor={getNodeColor}
        linkColor={getLinkColor}
        linkWidth={getLinkWidth}
        onNodeClick={handleNodeClick}
        onNodeDrag={handleNodeDrag}
        onNodeDragEnd={handleNodeDragEnd}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        width={size.width}
        height={size.height}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const label = node.title;
          const fontSize = node.type === 'file' ? 11 : 9;
          ctx.font = `${fontSize}px Arial`;
          const nodeColor = getNodeColor(node);
          const radius = node.type === 'file' ? 7 : 5;

          // Draw glow for selected
          if (selectedNode?.id === node.id) {
            const glowSize = 15;
            if (isFinite(node.x) && isFinite(node.y)) {
              const gradient = ctx.createRadialGradient(
                node.x, node.y, radius,
                node.x, node.y, glowSize
              );
              gradient.addColorStop(0, nodeColor);
              gradient.addColorStop(1, 'rgba(255,255,255,0)');

              ctx.beginPath();
              ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI, false);
              ctx.fillStyle = gradient;
              ctx.fill();
            }
          }

          // Draw node
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = nodeColor;
          ctx.fill();

          // Highlight ring for selected
          if (selectedNode?.id === node.id) {
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 2;
            ctx.stroke();
          }

          // Draw label
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.fillText(label, node.x, node.y + radius + fontSize / 2);
        }}
      />

      {selectedNode && (
        <div className="node-details">
          <button className="close-btn" onClick={() => setSelectedNode(null)}>×</button>
          <h3>{selectedNode.title}</h3>
          <div className="detail-row">
            <label>Type:</label>
            <span className="tag">{selectedNode.type}</span>
          </div>
          <div className="detail-row">
            <label>Path:</label>
            <span className="code">{selectedNode.path}</span>
          </div>
          {selectedNode.file_type && (
            <div className="detail-row">
              <label>File Type:</label>
              <span className="tag">{selectedNode.file_type}</span>
            </div>
          )}
          {selectedNode.tags && selectedNode.tags.length > 0 && (
            <div className="detail-row">
              <label>Tags:</label>
              <div className="tags">
                {selectedNode.tags.map(tag => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            </div>
          )}
          {selectedNode.first_para && (
            <div className="detail-row">
              <label>Content:</label>
              <p className="para">{selectedNode.first_para}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
