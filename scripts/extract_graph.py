#!/usr/bin/env python3
"""
Extract documents, headings, wikilinks, inline links, and references
to build a comprehensive node graph for visualization.
"""

import os
import re
import json
from pathlib import Path
from typing import Dict, List, Set, Tuple
import hashlib

class DocumentExtractor:
    def __init__(self, root_path: str):
        self.root = Path(root_path)
        self.nodes: Dict[str, Dict] = {}
        self.edges: List[Dict] = []
        self.file_index: Dict[str, str] = {}  # Map normalized paths to node IDs
        
    def generate_node_id(self, text: str) -> str:
        """Generate a unique node ID from text."""
        return hashlib.md5(text.encode()).hexdigest()[:8]
    
    def get_relative_path(self, path: Path) -> str:
        """Get path relative to root."""
        try:
            return str(path.relative_to(self.root))
        except ValueError:
            return str(path)
    
    def normalize_path(self, path_str: str) -> str:
        """Normalize path for matching."""
        return path_str.lower().replace('\\', '/').strip()
    
    def extract_markdown_metadata(self, content: str, file_path: Path) -> Tuple[List[Dict], List[str]]:
        """Extract headings and links from Markdown."""
        headings = []
        links = set()
        
        lines = content.split('\n')
        
        # Extract headings
        for i, line in enumerate(lines):
            # Markdown headings
            match = re.match(r'^(#{1,6})\s+(.+)$', line)
            if match:
                level = len(match.group(1))
                title = match.group(2).strip()
                # Get first paragraph after heading
                first_para = ""
                for j in range(i + 1, min(i + 5, len(lines))):
                    if lines[j].strip() and not re.match(r'^#{1,6}\s+', lines[j]):
                        first_para = lines[j][:200].strip()
                        break
                
                heading_id = self.generate_node_id(str(file_path) + "#" + title)
                headings.append({
                    'id': heading_id,
                    'type': 'heading',
                    'path': self.get_relative_path(file_path),
                    'title': title,
                    'level': level,
                    'first_para': first_para,
                    'tags': ['markdown', f'h{level}']
                })
        
        # Extract wikilinks [[...]]
        wikilink_pattern = r'\[\[([^\]]+)\]\]'
        for match in re.finditer(wikilink_pattern, content):
            link_target = match.group(1).strip()
            links.add(('wikilink', link_target))
        
        # Extract markdown links [text](url)
        md_link_pattern = r'\[([^\]]+)\]\(([^)]+)\)'
        for match in re.finditer(md_link_pattern, content):
            link_text = match.group(1)
            link_url = match.group(2)
            links.add(('markdown_link', link_url))
        
        return headings, list(links)
    
    def extract_code_metadata(self, content: str, file_path: Path, lang: str) -> Tuple[List[Dict], List[str]]:
        """Extract functions, classes, and imports from code files."""
        functions = []
        imports = set()
        
        if lang == 'python':
            # Extract functions and classes
            func_pattern = r'^\s*(?:async\s+)?(?:def|class)\s+(\w+)\s*\('
            for i, line in enumerate(content.split('\n')):
                match = re.match(func_pattern, line)
                if match:
                    name = match.group(1)
                    func_id = self.generate_node_id(str(file_path) + "#" + name)
                    
                    # Determine if function or class
                    is_class = 'class' in line
                    
                    functions.append({
                        'id': func_id,
                        'type': 'class' if is_class else 'function',
                        'path': self.get_relative_path(file_path),
                        'title': name,
                        'tags': ['python', 'class' if is_class else 'function'],
                        'first_para': ''
                    })
            
            # Extract imports
            import_patterns = [
                r'^(?:from\s+(\S+)\s+)?import\s+(.+)$',
                r'^import\s+(.+)$'
            ]
            for line in content.split('\n'):
                for pattern in import_patterns:
                    match = re.match(pattern, line)
                    if match:
                        imports.add(('import', line.strip()))
        
        elif lang in ['javascript', 'jsx']:
            # Extract functions and classes
            func_patterns = [
                r'(?:async\s+)?(?:const|let|var|function)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*)?=>|\s*function\s+(\w+)',
                r'class\s+(\w+)'
            ]
            
            for i, line in enumerate(content.split('\n')):
                for pattern in func_patterns:
                    matches = re.findall(pattern, line)
                    if matches:
                        for match in matches:
                            name = match[0] if isinstance(match, tuple) else match
                            if name:
                                func_id = self.generate_node_id(str(file_path) + "#" + name)
                                is_class = 'class' in line
                                
                                functions.append({
                                    'id': func_id,
                                    'type': 'class' if is_class else 'function',
                                    'path': self.get_relative_path(file_path),
                                    'title': name,
                                    'tags': ['javascript' if lang == 'javascript' else 'jsx', 
                                           'class' if is_class else 'function'],
                                    'first_para': ''
                                })
            
            # Extract imports
            import_pattern = r"(?:import|require)\s+(?:{[^}]*}|'[^']*'|\"[^\"]*\"|\w+)"
            for line in content.split('\n'):
                if re.search(import_pattern, line):
                    imports.add(('import', line.strip()))
        
        return functions, list(imports)
    
    def process_file(self, file_path: Path) -> None:
        """Process a single file and extract nodes."""
        try:
            content = file_path.read_text(encoding='utf-8', errors='ignore')
            rel_path = self.get_relative_path(file_path)
            
            # Create file node
            file_id = self.generate_node_id(rel_path)
            self.file_index[self.normalize_path(rel_path)] = file_id
            
            first_para = content.split('\n')[0][:200].strip()
            
            suffix = file_path.suffix.lower()
            if suffix == '.md':
                file_type = 'markdown'
                tags = ['markdown', 'document']
            elif suffix in ['.py']:
                file_type = 'python'
                tags = ['python', 'script']
            elif suffix in ['.js', '.jsx']:
                file_type = 'javascript'
                tags = ['javascript', 'code']
            else:
                file_type = 'file'
                tags = ['file']
            
            self.nodes[file_id] = {
                'id': file_id,
                'type': 'file',
                'path': rel_path,
                'title': file_path.name,
                'file_type': file_type,
                'tags': tags,
                'first_para': first_para,
                'x': 0,
                'y': 0
            }
            
            # Extract content based on file type
            if suffix == '.md':
                headings, links = self.extract_markdown_metadata(content, file_path)
                for heading in headings:
                    self.nodes[heading['id']] = heading
                    # Create edge from file to heading
                    self.edges.append({
                        'source': file_id,
                        'target': heading['id'],
                        'type': 'contains'
                    })
            
            elif suffix == '.py':
                functions, imports = self.extract_code_metadata(content, file_path, 'python')
                for func in functions:
                    self.nodes[func['id']] = func
                    # Create edge from file to function
                    self.edges.append({
                        'source': file_id,
                        'target': func['id'],
                        'type': 'defines'
                    })
        
        except Exception as e:
            print(f"Error processing {file_path}: {e}")
    
    def scan_directory(self) -> None:
        """Scan directory for relevant files."""
        patterns = ['*.md', '*.py', '*.js', '*.jsx']
        exclude_dirs = {'node_modules', '__pycache__', 'build', 'results', '.git', '.venv'}
        
        for pattern in patterns:
            for file_path in self.root.rglob(pattern):
                # Skip excluded directories
                if any(exc in file_path.parts for exc in exclude_dirs):
                    continue
                
                self.process_file(file_path)
    
    def resolve_links(self) -> None:
        """Resolve wikilinks and markdown links to actual nodes."""
        wikilink_edges = []
        
        for node_id, node in self.nodes.items():
            if node['type'] not in ['heading']:
                continue
            
            # Try to find wikilink references in the file content
            file_path = self.root / node['path']
            if file_path.exists():
                content = file_path.read_text(encoding='utf-8', errors='ignore')
                
                # Find wikilinks
                for match in re.finditer(r'\[\[([^\]]+)\]\]', content):
                    target = match.group(1).strip()
                    
                    # Try to find matching node
                    for target_id, target_node in self.nodes.items():
                        if target.lower() in target_node.get('title', '').lower():
                            wikilink_edges.append({
                                'source': node_id,
                                'target': target_id,
                                'type': 'references'
                            })
                            break
        
        self.edges.extend(wikilink_edges)
    
    def calculate_positions(self) -> None:
        """Calculate node positions in 2D space."""
        import math
        
        # Group nodes by type and depth
        file_nodes = [n for n in self.nodes.values() if n['type'] == 'file']
        heading_nodes = [n for n in self.nodes.values() if n['type'] == 'heading']
        func_nodes = [n for n in self.nodes.values() if n['type'] in ['function', 'class']]
        
        # Arrange files in outer circle
        num_files = len(file_nodes)
        radius = 300
        
        for i, node in enumerate(file_nodes):
            angle = (2 * math.pi * i) / max(num_files, 1)
            node['x'] = radius * math.cos(angle)
            node['y'] = radius * math.sin(angle)
        
        # Arrange headings closer to center
        num_headings = len(heading_nodes)
        heading_radius = 150
        
        for i, node in enumerate(heading_nodes):
            angle = (2 * math.pi * i) / max(num_headings, 1)
            node['x'] = heading_radius * math.cos(angle)
            node['y'] = heading_radius * math.sin(angle)
        
        # Place functions even closer
        num_funcs = len(func_nodes)
        func_radius = 75
        
        for i, node in enumerate(func_nodes):
            angle = (2 * math.pi * i) / max(num_funcs, 1)
            node['x'] = func_radius * math.cos(angle)
            node['y'] = func_radius * math.sin(angle)
    
    def export_json(self, output_path: str) -> None:
        """Export graph to JSON format."""
        graph = {
            'nodes': list(self.nodes.values()),
            'edges': self.edges,
            'metadata': {
                'total_nodes': len(self.nodes),
                'total_edges': len(self.edges),
                'node_types': list(set(n['type'] for n in self.nodes.values())),
                'file_types': list(set(n.get('file_type', 'unknown') for n in self.nodes.values()))
            }
        }
        
        with open(output_path, 'w') as f:
            json.dump(graph, f, indent=2)
        
        print(f"Graph exported to {output_path}")
        print(f"Total nodes: {len(self.nodes)}")
        print(f"Total edges: {len(self.edges)}")
    
    def run(self, output_path: str = None) -> Dict:
        """Run the complete extraction pipeline."""
        print(f"Scanning directory: {self.root}")
        self.scan_directory()
        print(f"Found {len(self.nodes)} nodes")
        
        print("Resolving links...")
        self.resolve_links()
        print(f"Found {len(self.edges)} edges")
        
        print("Calculating positions...")
        self.calculate_positions()
        
        if output_path:
            self.export_json(output_path)
        
        return {
            'nodes': list(self.nodes.values()),
            'edges': self.edges
        }


if __name__ == '__main__':
    import sys
    
    root_path = sys.argv[1] if len(sys.argv) > 1 else '/home/whitespider/Desktop/web_recon'
    output_path = sys.argv[2] if len(sys.argv) > 2 else '/home/whitespider/Desktop/web_recon/server/document_graph.json'
    
    extractor = DocumentExtractor(root_path)
    extractor.run(output_path)
