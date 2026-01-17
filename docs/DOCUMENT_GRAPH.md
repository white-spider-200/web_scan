# Document Graph Feature

## Overview

The Document Graph is a powerful tool for visualizing the interconnections between files, headings, functions, and classes in your project repository. It enables you to:

- **Explore relationships** between documents and code
- **Discover dependencies** through visual navigation
- **Understand structure** with an interactive force-directed graph
- **Manually arrange** nodes when physics is locked (BloodHound-style)
- **Search and filter** by node type, file type, or name

## Quick Start

### 1. Generate the Graph

The graph is automatically generated when you run the extraction script:

```bash
python3 scripts/extract_graph.py
```

This creates `/server/document_graph.json` containing all nodes and edges.

### 2. Use the Component

```jsx
import { DocumentGraph } from './components/DocumentGraph';

function App() {
  return <DocumentGraph />;
}
```

### 3. Interact with the Graph

- **🔓 Unlocked Mode** (Default)
  - Physics simulation is active
  - Nodes automatically arrange themselves
  - Great for understanding overall structure

- **🔒 Locked Mode**
  - Physics simulation stops
  - Drag nodes to manually arrange them
  - Perfect for creating custom layouts
  - Similar to BloodHound AD Scanner exploration

## Node Types

### File Nodes (White)
Represents source files in your project:
- `SECURITY.md` - Markdown documentation
- `scripts/extract_graph.py` - Python scripts
- `src/components/Graph.jsx` - React components

### Heading Nodes (Cyan)
Markdown section headings:
- `# Security Policy`
- `## Configuration Expectations`

### Function Nodes (Orange)
Code functions and methods:
- `extract_markdown_metadata()`
- `scan_directory()`

### Class Nodes (Indigo)
Class definitions in code:
- `DocumentExtractor`
- `ForceGraph2D`

## Edge Types

| Type | Color | Meaning |
|------|-------|---------|
| **Contains** | Cyan | File contains a heading |
| **Defines** | Orange | File defines a function or class |
| **References** | Purple | Wikilink reference [[...]] |

## Features

### Search
Filter nodes by name or path. Example searches:
- `extract` - Find all nodes with "extract" in title
- `src/` - Find all nodes in src directory
- `DocumentGraph` - Find specific component

### Filter
Select what types of nodes to display:
- **All Types** - Show everything
- **Files** - Only show files and their connections
- **Headings** - Only markdown structure
- **Functions** - Only code functions
- **Classes** - Only code classes

### Zoom & Pan
- **Scroll** - Zoom in/out
- **Middle Mouse** - Pan around
- **Button [+]** - Zoom in 1.5x
- **Button [−]** - Zoom out
- **Button [⌂]** - Reset to fit view

### Lock/Unlock Physics
- **🔓 Unlocked** - Forces active, auto-layout
- **🔒 Locked** - Forces disabled, manual placement

### Node Details Panel
Click any node to see:
- Full title
- Node type (file, heading, function, class)
- File path
- File type (markdown, python, javascript)
- Tags
- First paragraph of content

## Configuration

### Force Parameters

Edit the force configuration in `DocumentGraph.jsx` to customize behavior:

```javascript
// Charge force (repulsion)
fg.d3Force('charge',
  forceManyBody().strength(node => {
    if (node.type === 'file') return -1000;
    if (node.type === 'heading') return -500;
    return -200;
  })
);

// Link force (attraction)
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
```

### Node Colors

Customize node colors in `getNodeColor()`:

```javascript
const getNodeColor = (node) => {
  switch (node.type) {
    case 'file': return 'rgba(255,255,255,0.95)';      // White
    case 'heading': return 'rgba(45,226,230,0.95)';    // Cyan
    case 'function': return 'rgba(251,146,60,0.95)';   // Orange
    case 'class': return 'rgba(99,102,241,0.95)';      // Indigo
    default: return '#bbb';
  }
};
```

## Data Format

### Nodes

```javascript
{
  "id": "f1a97ccd",           // Unique identifier
  "type": "file",             // file|heading|function|class
  "path": "SECURITY.md",      // Relative file path
  "title": "SECURITY.md",     // Display name
  "file_type": "markdown",    // markdown|python|javascript
  "tags": ["markdown"],       // Categorization
  "first_para": "# Security", // Preview text
  "x": 300.0,                 // 2D position
  "y": 0.0
}
```

### Edges

```javascript
{
  "source": "f1a97ccd",       // Source node ID
  "target": "52f9cb9a",       // Target node ID
  "type": "contains"          // contains|defines|references
}
```

## Generation Pipeline

### 1. File Scanning
```
✓ Scan all .md, .py, .js, .jsx files
✓ Skip node_modules, __pycache__, build, etc.
```

### 2. Content Extraction
```
Markdown Files:
  ✓ Extract headings (h1-h6)
  ✓ Extract wikilinks [[...]]
  ✓ Extract markdown links [text](url)

Code Files (Python/JavaScript):
  ✓ Extract function/class definitions
  ✓ Extract imports
  ✓ Extract comments
```

### 3. Graph Building
```
✓ Create nodes for files, headings, functions
✓ Create edges: contains, defines, references
✓ Resolve wikilinks to actual nodes
✓ Calculate initial positions
```

### 4. Export
```
✓ Generate JSON with all nodes and edges
✓ Include metadata (types, file types)
✓ Pre-calculate node positions
```

## Performance

- **Nodes**: Tested with 389 nodes
- **Edges**: Tested with 308 edges
- **Rendering**: WebGL-accelerated canvas
- **Physics**: Multi-threaded force simulation
- **Memory**: ~2-5MB JSON file

## API

### DocumentGraph Component

```jsx
<DocumentGraph
  graphData={data}           // Optional: pre-loaded graph data
  onNodeClick={handleClick}  // Optional: callback when node clicked
/>
```

### Extract Script

```bash
python3 scripts/extract_graph.py [ROOT_PATH] [OUTPUT_PATH]

# Examples:
python3 scripts/extract_graph.py                           # Use defaults
python3 scripts/extract_graph.py /path/to/project          # Custom root
python3 scripts/extract_graph.py /path /output/graph.json  # Custom both
```

## Advanced Usage

### Manual Position Override

When in locked mode, you can permanently save custom layouts:

```javascript
// Save current positions
const saveLayout = () => {
  const positions = fgRef.current._nodes.map(node => ({
    id: node.id,
    x: node.x,
    y: node.y
  }));
  
  localStorage.setItem('documentGraphLayout', JSON.stringify(positions));
};

// Load saved layout
const loadLayout = () => {
  const positions = JSON.parse(localStorage.getItem('documentGraphLayout'));
  // Apply positions to nodes...
};
```

### Conditional Node Display

Filter nodes based on custom logic:

```javascript
const filteredData = useMemo(() => {
  if (!data) return null;
  
  const nodes = data.nodes.filter(n => {
    // Example: Hide test files
    if (n.path.includes('.test.')) return false;
    
    // Example: Show only Python files
    if (n.file_type === 'python') return true;
    
    return true;
  });
  
  return { nodes, edges: data.edges };
}, [data]);
```

### Export Custom Layouts

```javascript
const exportLayout = () => {
  const layout = {
    nodes: fgRef.current._nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y
    })),
    timestamp: new Date().toISOString(),
    name: prompt('Layout name:')
  };
  
  const blob = new Blob([JSON.stringify(layout, null, 2)]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `layout-${Date.now()}.json`;
  a.click();
};
```

## Troubleshooting

### Graph doesn't load
- Check that `/server/document_graph.json` exists
- Run `python3 scripts/extract_graph.py` to regenerate
- Check browser console for errors

### Nodes are frozen
- Make sure physics isn't locked (should be 🔓)
- Try clicking the reset view button [⌂]
- Refresh the page

### Performance issues
- Reduce the number of nodes with filtering
- Try zooming to specific areas
- Disable hover labels (edit CSS)

### Nodes missing
- Run extraction script again
- Check file permissions in repo
- Verify excluded directories aren't hiding files

## Future Enhancements

- [ ] 3D visualization with ForceGraph3D
- [ ] Timeline view showing graph evolution
- [ ] Dependency chain highlighting
- [ ] Full-text search integration
- [ ] Layout bookmarking
- [ ] Git history integration
- [ ] Custom node categories
- [ ] Export to SVG/PNG
- [ ] Real-time graph updates
- [ ] Collaborative annotations

## License

Part of Web Recon Map project. See LICENSE for details.
