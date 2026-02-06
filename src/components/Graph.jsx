import React, { useRef, useEffect, useState, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceManyBody, forceCollide, forceLink, forceCenter, forceRadial } from 'd3-force';
import './Graph.css';

export const Graph = ({ data, onNodeClick, highlightedNodes = [], similarNodes = [] }) => {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [isPhysicsLocked, setIsPhysicsLocked] = useState(false);
  const didAutoFitRef = useRef(false);

  // Build lookup sets for highlights
  const highlightedSet = new Set(highlightedNodes.map(String));
  const similarNodesSet = new Set(similarNodes.map(String));

  // Normalize and filter the graph data to ensure all nodes are valid
  const normalizedData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };

    // Handle different data structures (direct or nested under 'graph')
    let rawNodes = data.nodes || data.graph?.nodes || [];
    let rawLinks = data.links || data.graph?.links || [];

    // Filter out invalid/incomplete nodes (must have at least an 'id')
    const validNodes = rawNodes.filter(node => {
      if (!node || typeof node !== 'object') return false;
      // Node must have an id to be valid
      return node.id !== undefined && node.id !== null;
    });

    // Create a set of valid node IDs for link filtering
    const validNodeIds = new Set(validNodes.map(n => String(n.id)));

    // Filter links to only include those connecting valid nodes
    const validLinks = rawLinks.filter(link => {
      if (!link || typeof link !== 'object') return false;
      const sourceId = String(typeof link.source === 'object' ? link.source.id : link.source);
      const targetId = String(typeof link.target === 'object' ? link.target.id : link.target);
      return validNodeIds.has(sourceId) && validNodeIds.has(targetId);
    }).map(link => ({
      ...link,
      source: typeof link.source === 'object' ? link.source.id : link.source,
      target: typeof link.target === 'object' ? link.target.id : link.target
    }));

    console.log(`[Graph] Loaded ${validNodes.length} valid nodes and ${validLinks.length} valid links`);

    return {
      nodes: validNodes,
      links: validLinks
    };
  }, [data]);

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


  // Configure forces - use weaker values
  useEffect(() => {
    if (!fgRef.current || !normalizedData?.nodes?.length) return;

    const fg = fgRef.current;
    // ...existing code...

    // Charge force - REDUCE strength
    fg.d3Force('charge', forceManyBody()
      .strength(node => node.id === rootNode.id ? -200 : -80)
      .distanceMin(20)
      .distanceMax(300)
    );

    // Center force - VERY weak
    fg.d3Force('center', forceCenter(size.width / 2, size.height / 2).strength(0.01));

    // Link force - weaker
    fg.d3Force('link', forceLink(normalizedData.links)
      .id(d => d.id)
      .distance(100)
      .strength(0.1)
    );

    // Radial force - weaker
    fg.d3Force('radial', forceRadial(
      node => {
        if (node.id === rootNode.id) return 0;
        const level = node.level || 2;
        return (level - 1) * 120;
      },
      size.width / 2,
      size.height / 2
    ).strength(0.1));

    // ...existing code...
  }, [normalizedData, size.width, size.height, isPhysicsLocked]);


  // Zoom controls
  const handleZoom = (type) => {
    if (!fgRef.current) return;
    
    const fg = fgRef.current;
    const currentZoom = fg.zoom();
    
    switch(type) {
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

  // Handle node clicks
  const handleNodeClick = (node) => {
    if (!node || !fgRef.current?.centerAt) return;
    fgRef.current.centerAt(node.x, node.y, 400);
    fgRef.current.zoom(1.6, 400);
    onNodeClick?.(node, [node.id]);
  };

  const handleNodeDragEnd = (node) => {
    if (!node) return;
    if (isPhysicsLocked) {
      node.fx = node.x;
      node.fy = node.y;
    } else {
      node.fx = undefined;
      node.fy = undefined;
    }
  };

  // Toggle physics lock
  const togglePhysicsLock = () => {
    setIsPhysicsLocked(prev => {
      const newState = !prev;
      // If locking, pin all nodes at current positions
      if (newState && normalizedData.nodes) {
        normalizedData.nodes.forEach(node => {
          if (isFinite(node.x) && isFinite(node.y)) {
            node.fx = node.x;
            node.fy = node.y;
          }
        });
      } else if (!newState && normalizedData.nodes) {
        // If unlocking, release all non-root nodes
        const rootNode = normalizedData.nodes.find(n => n.type === 'host' && n.role === 'root');
        normalizedData.nodes.forEach(node => {
          if (node.id !== rootNode?.id) {
            node.fx = undefined;
            node.fy = undefined;
          }
        });
      }
      return newState;
    });
  };

  // Get node color based on type
  const getNodeColor = (node) => {
    if (!node?.type) return '#9CA3AF';
    
    switch(node.type) {
      case 'host': 
        return node.role === 'root' ? '#2DE2E6' : '#3B82F6';
      case 'dir': 
        return '#FBBF24';
      case 'path':
      case 'file': 
        return '#EF4444';
      case 'ip':
        return '#FB923C';
      default: 
        return '#9CA3AF';
    }
  };

  // Get node size based on type
  const getNodeSize = (node) => {
    if (!node?.type) return 6;
    
    switch(node.type) {
      case 'host': 
        return node.role === 'root' ? 12 : 8;
      case 'dir': 
        return 7;
      case 'path':
      case 'file': 
        return 5;
      default: 
        return 5;
    }
  };

  // Don't render if no valid data
  if (!normalizedData.nodes.length) {
    return (
      <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94A3B8' }}>
        <p>No graph data to display</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div className="graph-controls">
        <button onClick={() => handleZoom('in')} title="Zoom In">+</button>
        <button onClick={() => handleZoom('out')} title="Zoom Out">−</button>
        <button onClick={() => handleZoom('home')} title="Reset View" className="home-button">⌂</button>
        <button 
          onClick={togglePhysicsLock} 
          title={isPhysicsLocked ? "Unlock Physics" : "Lock Physics"}
          className={`lock-button ${isPhysicsLocked ? 'locked' : 'unlocked'}`}
        >
          {isPhysicsLocked ? '🔒' : '🔓'}
        </button>
      </div>
      
      {/* Node count indicator */}
      <div style={{ 
        position: 'absolute', 
        bottom: 10, 
        left: 10, 
        color: '#94A3B8', 
        fontSize: 11,
        background: 'rgba(0,0,0,0.5)',
        padding: '4px 8px',
        borderRadius: 4
      }}>
        {normalizedData.nodes.length} nodes • {normalizedData.links.length} links
      </div>
      
      <ForceGraph2D
        ref={fgRef}
        graphData={normalizedData}
        nodeLabel={node => {
          const label = node.fullLabel || node.label || node.id;
          const type = node.type || 'unknown';
          const status = node.status ? ` [${node.status}]` : '';
          return `${label}${status} (${type})`;
        }}
        nodeRelSize={6}
        linkColor={link => {
          const sourceId = String(typeof link.source === 'object' ? link.source.id : link.source);
          const targetId = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightedSet.has(sourceId) || highlightedSet.has(targetId);
          const isSimilar = similarNodesSet.has(sourceId) || similarNodesSet.has(targetId);
          
          if (isHighlighted) return 'rgba(45,226,230,0.6)';
          if (isSimilar) return 'rgba(251,146,60,0.6)';
          return 'rgba(148,163,184,0.25)';
        }}
        linkWidth={link => {
          const sourceId = String(typeof link.source === 'object' ? link.source.id : link.source);
          const targetId = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightedSet.has(sourceId) || highlightedSet.has(targetId);
          const isSimilar = similarNodesSet.has(sourceId) || similarNodesSet.has(targetId);
          
          return isHighlighted || isSimilar ? 2 : 1;
        }}
        onNodeClick={handleNodeClick}
        onNodeDragEnd={handleNodeDragEnd}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={150}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(node, ctx, globalScale) => {
          // Skip invalid nodes
          if (!isFinite(node.x) || !isFinite(node.y)) return;
          
          const nodeColor = getNodeColor(node);
          const radius = getNodeSize(node);
          const isHighlighted = highlightedSet.has(String(node.id));
          const isSimilar = similarNodesSet.has(String(node.id));
          const isRoot = node.type === 'host' && node.role === 'root';

          // Draw glow effect for highlighted/similar nodes
          if (isHighlighted || isSimilar || isRoot) {
            const glowSize = radius * 2.5;
            const gradient = ctx.createRadialGradient(
              node.x, node.y, radius,
              node.x, node.y, glowSize
            );
            const glowColor = isHighlighted ? 'rgba(45,226,230,0.4)' : 
                              isSimilar ? 'rgba(251,146,60,0.4)' : 
                              'rgba(45,226,230,0.2)';
            gradient.addColorStop(0, glowColor);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            
            ctx.beginPath();
            ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI, false);
            ctx.fillStyle = gradient;
            ctx.fill();
          }

          // Draw the node circle
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = nodeColor;
          ctx.fill();
          
          // Add ring for highlighted nodes
          if (isHighlighted || isRoot) {
            ctx.strokeStyle = isRoot ? 'rgba(255,255,255,0.8)' : 'rgba(45,226,230,0.8)';
            ctx.lineWidth = 2 / globalScale;
            ctx.stroke();
          }

          // Draw label for important nodes or when zoomed in
          const shouldShowLabel = isRoot || isHighlighted || isSimilar || 
            node.type === 'host' || globalScale > 0.8;
          
          if (shouldShowLabel) {
            const label = node.label || String(node.id).split(':').pop() || '';
            const truncatedLabel = label.length > 20 ? label.slice(0, 18) + '…' : label;
            
            const fontSize = Math.max(10, 12 / globalScale);
            ctx.font = `${isRoot ? 'bold ' : ''}${fontSize}px Inter, Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            
            // Text shadow
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillText(truncatedLabel, node.x + 0.5, node.y + radius + 3 + 0.5);
            
            // Actual text
            ctx.fillStyle = isRoot ? '#ffffff' : 'rgba(255,255,255,0.85)';
            ctx.fillText(truncatedLabel, node.x, node.y + radius + 3);
          }
        }}
      />
    </div>
  );
};