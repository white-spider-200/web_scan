# Document Graph Integration Guide

## Quick Integration (5 minutes)

### Step 1: Import Component
Add this to your React app's main view:

```jsx
import { DocumentGraph } from './components/DocumentGraph';
```

### Step 2: Add to Render
```jsx
<div style={{ width: '100%', height: '100vh' }}>
  <DocumentGraph />
</div>
```

### Step 3: Ensure JSON is Available
The component automatically loads from `/document_graph.json`. The file is already generated at:
```
/server/document_graph.json
```

If serving from Node/Express:
```javascript
// In server/index.js
app.use(express.static('public'));
app.get('/document_graph.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'document_graph.json'));
});
```

---

## What Was Built

### 1. **Python Extraction Script** (`scripts/extract_graph.py`)
- Scans entire repository
- Extracts Markdown headings, wikilinks, and links
- Parses Python and JavaScript functions/classes
- Builds graph with 389 nodes and 308 edges
- Exports to JSON format
- Calculates initial node positions

**Key Capabilities**:
```python
DocumentExtractor(root_path)
  .scan_directory()              # Find all source files
  .extract_markdown_metadata()   # Get headings and links
  .extract_code_metadata()       # Get functions/classes
  .resolve_links()               # Connect wikilinks
  .calculate_positions()         # Initial layout
  .export_json(output_path)      # Save JSON
```

### 2. **React Component** (`src/components/DocumentGraph.jsx`)
Full-featured visualization with:

**Features**:
- ✅ Force-directed graph layout
- ✅ Real-time physics simulation
- ✅ **Lock/Unlock physics** (🔒/🔓)
- ✅ Node search and filtering
- ✅ Zoom and pan controls
- ✅ Node details panel
- ✅ Responsive resizing

**Node Types**:
```
File (White)           - Source documents
├─ Heading (Cyan)      - Markdown sections
├─ Function (Orange)   - Code functions
└─ Class (Indigo)      - Code classes
```

**Edge Types**:
```
Contains (Cyan)        - File contains heading
Defines (Orange)       - File defines function/class
References (Purple)    - Wikilink references
```

### 3. **Styling** (`src/components/DocumentGraph.css`)
Professional dark theme with:
- Modern UI controls
- Smooth animations
- Color-coded nodes and edges
- Responsive details panel
- Custom scrollbars

### 4. **Specifications** (`docs/`)
Complete documentation:
- `VISUALIZATION_SPEC.md` - Technical reference
- `DOCUMENT_GRAPH.md` - User guide
- `GRAPH_IMPLEMENTATION.md` - Implementation summary

---

## Physics Lock Feature

### Unlocked Mode 🔓 (Default)
```
✓ Forces active
✓ Nodes auto-arrange
✓ Physics simulation running
✓ Drag node → returns to computed position
```

**Configuration**:
```javascript
// All forces enabled
fg.d3Force('charge', forceManyBody().strength(-1000));
fg.d3Force('link', forceLink().distance(80));
fg.d3Force('center', forceCenter());
fg.d3Force('collision', forceCollide(20));

// Simulation running
sim.restart();
sim.alpha(0.3);
```

### Locked Mode 🔒
```
✓ Forces disabled
✓ Nodes stay in place
✓ Simulation stopped
✓ Drag node → node stays at new position
✓ Perfect for manual layout arrangement
```

**Configuration**:
```javascript
// All forces disabled
fg.d3Force('charge', null);
fg.d3Force('link', null);
fg.d3Force('center', null);
fg.d3Force('collision', null);

// Simulation stopped
sim.stop();
sim.alpha(0);
```

---

## Data Structure

### Graph JSON Format
```json
{
  "nodes": [
    {
      "id": "f1a97ccd",
      "type": "file|heading|function|class",
      "path": "relative/path/to/file.md",
      "title": "Display Name",
      "file_type": "markdown|python|javascript",
      "tags": ["category1", "category2"],
      "first_para": "First line of content...",
      "x": 100.5,
      "y": 50.2
    },
    ...
  ],
  "edges": [
    {
      "source": "node_id_1",
      "target": "node_id_2",
      "type": "contains|defines|references"
    },
    ...
  ],
  "metadata": {
    "total_nodes": 389,
    "total_edges": 308,
    "node_types": ["file", "heading", "function", "class"],
    "file_types": ["markdown", "python", "javascript"]
  }
}
```

### Current Project Graph
```
389 Total Nodes
├─ Files:     80
├─ Headings: 155
├─ Functions: 145
├─ Classes:    9

308 Total Edges
├─ Contains:   198
├─ Defines:    108
├─ References:   2
```

---

## Regenerate Graph

When you add/modify files, regenerate the graph:

```bash
# From project root
python3 scripts/extract_graph.py

# Custom paths
python3 scripts/extract_graph.py /custom/root /custom/output.json
```

The script:
1. Scans all `.md`, `.py`, `.js`, `.jsx` files
2. Skips `node_modules`, `__pycache__`, `build`, `results`
3. Extracts documents and code structure
4. Resolves cross-references
5. Calculates optimal positions
6. Exports to JSON

---

## Customization Examples

### Change Node Colors
```jsx
// In DocumentGraph.jsx, modify getNodeColor()
const getNodeColor = (node) => {
  switch (node.type) {
    case 'file': return 'rgba(59,130,246,1)';      // Blue
    case 'heading': return 'rgba(168,85,247,1)';   // Purple
    case 'function': return 'rgba(34,197,94,1)';   // Green
    case 'class': return 'rgba(239,68,68,1)';      // Red
    default: return '#bbb';
  }
};
```

### Adjust Force Strengths
```jsx
// Stronger repulsion between files
fg.d3Force('charge',
  forceManyBody().strength(node => {
    if (node.type === 'file') return -2000;  // Increase from -1000
    return -500;
  })
);

// Tighter links
fg.d3Force('link',
  forceLink()
    .distance(link => {
      if (link.type === 'contains') return 50;  // Decrease from 80
      return 100;
    })
);
```

### Filter Specific File Types
```jsx
// Only show Python and JavaScript files
const filteredData = useMemo(() => {
  if (!data) return null;
  
  const nodeIds = new Set(
    data.nodes
      .filter(n => n.file_type === 'python' || n.file_type === 'javascript')
      .map(n => n.id)
  );
  
  return {
    nodes: data.nodes.filter(n => nodeIds.has(n.id)),
    edges: data.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
  };
}, [data]);
```

---

## Performance Tips

### Large Graphs (>500 nodes)
1. **Filter by type**: Show only specific node types
2. **Search for subset**: Use search to find relevant nodes
3. **Zoom to area**: Focus on specific regions
4. **Lock physics**: Reduce computation when exploring

### Memory Optimization
```javascript
// Remove unused node properties
const cleanGraph = {
  nodes: data.nodes.map(n => ({
    id: n.id,
    type: n.type,
    x: n.x,
    y: n.y,
    // Only keep essential properties
  })),
  edges: data.edges
};
```

### Rendering Performance
```css
/* Simplify node rendering */
canvas {
  image-rendering: pixelated;  /* Faster on low-end devices */
}
```

---

## Browser DevTools

### Inspect Graph State
```javascript
// In browser console
const fgRef = window._fgRef;  // Set in component
const nodes = fgRef._nodes;   // All nodes
const links = fgRef._links;   // All links

// Check node positions
nodes.forEach(n => console.log(n.id, {x: n.x, y: n.y}));

// Export current state
copy(JSON.stringify(nodes));
```

### Performance Profiling
```javascript
// Measure simulation speed
console.time('simulation');
// ... let it run ...
console.timeEnd('simulation');

// Check frame rate
let frames = 0;
setInterval(() => {
  console.log('FPS:', frames);
  frames = 0;
}, 1000);
requestAnimationFrame(() => frames++);
```

---

## Troubleshooting

### Component doesn't load
```bash
# Check file exists
ls -la server/document_graph.json

# Check permissions
chmod 644 server/document_graph.json

# Regenerate if missing
python3 scripts/extract_graph.py
```

### Physics lock doesn't work
```javascript
// Check component state
console.log('isPhysicsLocked:', isPhysicsLocked);

// Verify forces are disabled
console.log('chargeForce:', fg.d3Force('charge'));  // Should be null when locked
```

### Nodes not rendering
```javascript
// Check data loaded
console.log('graphData:', graphData);

// Verify node positions
console.log('nodes:', filteredData?.nodes.slice(0, 5));

// Check canvas size
console.log('size:', size);
```

---

## Files Summary

| File | Purpose | Status |
|------|---------|--------|
| `scripts/extract_graph.py` | Graph extraction | ✅ Created |
| `server/document_graph.json` | Graph data (389 nodes, 308 edges) | ✅ Generated |
| `src/components/DocumentGraph.jsx` | React component | ✅ Created |
| `src/components/DocumentGraph.css` | Styling | ✅ Created |
| `docs/VISUALIZATION_SPEC.md` | Technical spec | ✅ Created |
| `docs/DOCUMENT_GRAPH.md` | User guide | ✅ Created |
| `docs/GRAPH_IMPLEMENTATION.md` | Implementation docs | ✅ Created |

---

## Next Steps

1. ✅ **Review** the documentation in `docs/`
2. ✅ **Test** the component by adding it to your app
3. ✅ **Customize** colors and forces to match your design
4. ✅ **Deploy** with pre-generated graph.json
5. ✅ **Monitor** performance in production
6. ✅ **Regenerate** graph when code structure changes

---

**Ready to use!** The document graph is fully implemented and tested.
All components are in place, documentation is complete, and the physics lock feature is working.
