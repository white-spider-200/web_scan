import React, { useRef, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceManyBody, forceCollide, forceLink, forceCenter, forceRadial } from 'd3-force';
import './Graph.css';

export const Graph = ({ data, onNodeClick, highlightedNodes = [], similarNodes = [] }) => {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [isPhysicsLocked, setIsPhysicsLocked] = useState(false);
  const didAutoFitRef = useRef(false);
  const nodesAddedAt = useRef(new Map());

  // Build lookup sets for highlights
  const highlightedSet = new Set(highlightedNodes.map(String));
  const similarNodesSet = new Set(similarNodes.map(String));

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
    const rootNode = data.nodes.find(n => n.type === 'host' && n.role === 'root') || data.nodes.find(n => n.type === 'host');
    if (!rootNode) return;

    // If physics is locked, disable all forces and stop simulation
    if (isPhysicsLocked) {
      // Remove all forces
      fg.d3Force('center', null);
      fg.d3Force('charge', null);
      fg.d3Force('link', null);
      fg.d3Force('radial', null);
      fg.d3Force('collision', null);
      
      // Access and stop the simulation
      try {
        const sim = fg.d3Simulation();
        if (sim) {
          sim.stop();
          sim.alpha(0);
        }
      } catch (e) {
        // Simulation might not be ready yet
      }
      
      return;
    }

    // When unlocked, restart simulation with forces
    try {
      const sim = fg.d3Simulation();
      if (sim) {
        sim.restart();
        sim.alpha(0.3);
      }
    } catch (e) {
      // Simulation might not be ready yet
    }

    // Center force
    fg.d3Force('center', forceCenter(size.width / 2, size.height / 2).strength(0.05));

    // Charge force
    fg.d3Force('charge', forceManyBody().strength(node => 
      node.id === rootNode.id ? -1000 : -500
    ));

    // Link force
    fg.d3Force('link', forceLink()
      .id(d => d.id)
      .distance(link => {
        const isRootLink = link.source.id === rootNode.id || link.target.id === rootNode.id;
        return isRootLink ? 150 : 80;
      })
      .strength(0.2));

    // Radial force
    fg.d3Force('radial', forceRadial(
      node => node.id === rootNode.id ? 0 : 200,
      size.width / 2,
      size.height / 2
    ).strength(node => node.id === rootNode.id ? 0.8 : 0.1));

    // Collision force
    fg.d3Force('collision', forceCollide(20));

    // Pin root node only if physics is on
    rootNode.fx = size.width / 2;
    rootNode.fy = size.height / 2;

    if (!didAutoFitRef.current) {
      const timeout = setTimeout(() => {
        if (fg.zoomToFit) {
          fg.zoomToFit(800, 100);
          didAutoFitRef.current = true;
        }
      }, 300);
      return () => clearTimeout(timeout);
    }
  }, [data, size.width, size.height, isPhysicsLocked]);

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

  // Handle node drag - only allow dragging on click, not on hover
  const handleNodeDrag = (node, translate) => {
    if (!node) return;
    // This is called during drag - update node position
    node.fx = translate.x;
    node.fy = translate.y;
  };

  const handleNodeDragEnd = (node) => {
    if (!node) return;
    // If physics is locked, keep node fixed. Otherwise release it.
    if (isPhysicsLocked) {
      // Keep the node pinned at its current position
      node.fx = node.x;
      node.fy = node.y;
    } else {
      // Release the node so physics can take over
      node.fx = undefined;
      node.fy = undefined;
    }
  };

  // Toggle physics lock
  const togglePhysicsLock = () => {
    setIsPhysicsLocked(!isPhysicsLocked);
  };

  // Get node color based on type
  const getNodeColor = (node) => {
    if (!node?.type) return '#bbb';
    switch(node.type) {
      case 'host': return node.role === 'root' ? 'rgba(255,255,255,0.95)' : 'rgba(45,226,230,0.95)';
      case 'dir': return 'rgba(59,130,246,0.95)';
      case 'path':
      case 'file': return 'rgba(251,146,60,0.95)';
      default: return '#bbb';
    }
  };

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
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        dagMode="radialout"
        dagLevelDistance={100}
        nodeLabel={node => node.fullLabel || node.label || node.id}
        nodeRelSize={6}
        linkColor={link => {
          const sourceId = String(typeof link.source === 'object' ? link.source.id : link.source);
          const targetId = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightedSet.has(sourceId) || highlightedSet.has(targetId);
          const isSimilar = similarNodesSet.has(sourceId) || similarNodesSet.has(targetId);
          
          if (isHighlighted) return 'rgba(45,226,230,0.6)';
          if (isSimilar) return 'rgba(251,146,60,0.6)';
          return 'rgba(255,255,255,0.2)';
        }}
        linkWidth={link => {
          const sourceId = String(typeof link.source === 'object' ? link.source.id : link.source);
          const targetId = String(typeof link.target === 'object' ? link.target.id : link.target);
          const isHighlighted = highlightedSet.has(sourceId) || highlightedSet.has(targetId);
          const isSimilar = similarNodesSet.has(sourceId) || similarNodesSet.has(targetId);
          
          return isHighlighted || isSimilar ? 2 : 1;
        }}
        onNodeClick={handleNodeClick}
        onNodeDrag={handleNodeDrag}
        onNodeDragEnd={handleNodeDragEnd}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        width={size.width}
        height={size.height}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const label = node.label || node.id;
          const fontSize = node.type === 'host' && node.role === 'root' ? 14 : 12;
          ctx.font = `${fontSize}px Arial`;
          const nodeColor = getNodeColor(node);
          const isHighlighted = highlightedSet.has(String(node.id));
          const isSimilar = similarNodesSet.has(String(node.id));
          const radius = 6;

          // Draw glow effect for highlighted nodes
          if (isHighlighted) {
            const glowSize = 15;
            // Skip if node positions are not yet finite
            if (!isFinite(node.x) || !isFinite(node.y)) return;
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

          // Draw the node
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = nodeColor;
          ctx.fill();
          
          // Add a subtle ring for highlighted nodes
          if (isHighlighted) {
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 2;
            ctx.stroke();
          }

          // Draw text
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.fillText(label, node.x, node.y + 8 + fontSize/2);
        }}
      />
    </div>
  );
};
