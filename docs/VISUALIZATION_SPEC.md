# Document Graph Visualization Specification

## Overview
The document graph visualization displays the interconnections between files, headings, functions, classes, and their relationships in the project repository.

## Architecture

### Node Types
- **file** - Source files (Markdown, Python, JavaScript)
- **heading** - Markdown section headings
- **function** - Function definitions in code
- **class** - Class definitions in code

### Edge Types
- **contains** - File contains a heading or function
- **defines** - File defines a function or class
- **references** - Node references another node via wikilink

## Recommended Visualization Library

### Primary: react-force-graph-3d
For full 3D exploration of complex graphs, providing immersive navigation.

```javascript
import ForceGraph3D from 'react-force-graph-3d';
```

### Secondary: react-force-graph-2d
For 2D visualization (already implemented in this project).

```javascript
import ForceGraph2D from 'react-force-graph-2d';
```

## Visualization Configuration

### Force Simulation Options

```javascript
{
  // Charge force: repulsion between nodes
  charge: {
    strength: (node) => {
      // Files repel more strongly
      if (node.type === 'file') return -1000;
      // Headings medium repulsion
      if (node.type === 'heading') return -500;
      // Functions weak repulsion
      return -200;
    }
  },
  
  // Link force: attraction along edges
  link: {
    distance: (link) => {
      if (link.type === 'contains') return 80;
      if (link.type === 'defines') return 100;
      if (link.type === 'references') return 120;
      return 150;
    },
    strength: 0.2
  },
  
  // Center force: pulls nodes toward center
  center: {
    strength: 0.05
  },
  
  // Collision force: prevents overlap
  collision: {
    radius: 20
  },
  
  // Optional: Radial force for hierarchical layout
  radial: {
    distance: (node) => {
      if (node.type === 'file') return 250;
      if (node.type === 'heading') return 150;
      return 50;
    },
    strength: 0.1
  }
}
```

### Node Styling

```javascript
{
  colors: {
    file: 'rgba(255, 255, 255, 0.95)',      // White
    heading: 'rgba(45, 226, 230, 0.95)',    // Cyan
    function: 'rgba(251, 146, 60, 0.95)',   // Orange
    class: 'rgba(99, 102, 241, 0.95)',      // Indigo
  },
  
  sizes: {
    file: 8,
    heading: 6,
    function: 5,
    class: 6,
  },
  
  glowEffect: {
    enabled: true,
    size: 15,
    color: 'rgba(255, 255, 255, 0.3)'
  }
}
```

### Link Styling

```javascript
{
  colors: {
    contains: 'rgba(45, 226, 230, 0.4)',    // Cyan
    defines: 'rgba(251, 146, 60, 0.4)',     // Orange
    references: 'rgba(168, 85, 247, 0.4)',  // Purple
    default: 'rgba(255, 255, 255, 0.1)'
  },
  
  widths: {
    contains: 2,
    defines: 2,
    references: 1.5,
    default: 1
  }
}
```

## UI Behavior: Lock Button

### States

#### Unlocked (🔓) - Physics Enabled
- D3 force simulation runs continuously
- Nodes follow force-directed layout automatically
- User can still drag nodes, but they return to computed positions
- Good for exploring overall structure

#### Locked (🔒) - Physics Disabled
- Force simulation stops
- Nodes remain at their current positions
- Users can freely reposition nodes for custom layouts
- Similar to BloodHound AD Scan exploration mode
- Pan and zoom still available

### Implementation Details

```javascript
const [isPhysicsLocked, setIsPhysicsLocked] = useState(false);

useEffect(() => {
  if (!fgRef.current) return;
  
  const fg = fgRef.current;
  const sim = fg.d3Simulation();
  
  if (isPhysicsLocked) {
    // Disable all forces
    fg.d3Force('center', null);
    fg.d3Force('charge', null);
    fg.d3Force('link', null);
    fg.d3Force('collision', null);
    fg.d3Force('radial', null);
    
    // Stop simulation
    if (sim) {
      sim.stop();
      sim.alpha(0);
    }
  } else {
    // Re-enable simulation and forces
    if (sim) {
      sim.restart();
      sim.alpha(0.3);
    }
    // ... reapply forces
  }
}, [isPhysicsLocked]);
```

### Drag Behavior

```javascript
// When physics is locked
onNodeDragEnd: (node) => {
  if (isPhysicsLocked) {
    // Keep node pinned at new position
    node.fx = node.x;
    node.fy = node.y;
  } else {
    // Release node for physics
    node.fx = undefined;
    node.fy = undefined;
  }
}
```

## Interactive Features

### Hover
- Display node label (file name, heading, function name)
- Highlight connected edges
- Show node metadata (path, tags, first paragraph)

### Click
- Center view on clicked node
- Zoom to node (1.6x)
- Display full metadata in side panel

### Drag
- **When unlocked**: Node returns to physics position after release
- **When locked**: Node stays at new position

### Pan & Zoom
- Middle mouse drag to pan
- Scroll to zoom in/out
- Buttons for zoom in, zoom out, reset view

### Search/Filter
- Filter nodes by type (files, headings, functions)
- Filter by file type (markdown, python, javascript)
- Search by name or path

## Color Legend

| Type | Color | Meaning |
|------|-------|---------|
| File | White | Source document |
| Heading | Cyan | Markdown section |
| Function | Orange | Code function |
| Class | Indigo | Code class |

| Link Type | Color | Meaning |
|-----------|-------|---------|
| Contains | Cyan | File contains heading/function |
| Defines | Orange | File defines function/class |
| References | Purple | Wikilink reference |

## Performance Considerations

- **Max nodes**: 500+ (with GPU acceleration)
- **Max edges**: 2000+ (with optimized rendering)
- **Culling**: Nodes/edges outside viewport are skipped
- **WebGL rendering** for large graphs (not canvas)

## Data Structure

```javascript
{
  "nodes": [
    {
      "id": "f1a97ccd",
      "type": "file|heading|function|class",
      "path": "relative/path/to/file.md",
      "title": "Display Name",
      "file_type": "markdown|python|javascript",
      "tags": ["tag1", "tag2"],
      "first_para": "First paragraph or line of content",
      "x": 100.5,   // 2D position
      "y": 50.2,
      "z": 25.0     // Optional: for 3D
    }
  ],
  "edges": [
    {
      "source": "f1a97ccd",
      "target": "52f9cb9a",
      "type": "contains|defines|references"
    }
  ],
  "metadata": {
    "total_nodes": 389,
    "total_edges": 308,
    "node_types": ["file", "heading", "function", "class"],
    "file_types": ["markdown", "python", "javascript"]
  }
}
```

## Export & Integration

The document graph is automatically exported to:
```
/server/document_graph.json
```

Load it in React:
```javascript
const [graphData, setGraphData] = useState(null);

useEffect(() => {
  fetch('/document_graph.json')
    .then(r => r.json())
    .then(data => setGraphData(data));
}, []);
```

## Future Enhancements

1. **3D Visualization** - Switch to ForceGraph3D for immersive exploration
2. **Timeline View** - Show how graph evolved over commits
3. **Dependency Analysis** - Highlight import/reference chains
4. **Search Integration** - Full-text search across all nodes
5. **Export** - Save custom layouts as bookmarks
6. **Analytics** - Show most referenced files/functions
7. **Diff Visualization** - Show what changed between versions
