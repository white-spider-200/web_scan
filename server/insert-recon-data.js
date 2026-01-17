const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('./config');

const dbPath = path.resolve(__dirname, config.database.path);
const db = new sqlite3.Database(dbPath);

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Clear existing data
function clearTables() {
    const tables = [
        'node_relationships',
        'node_headers',
        'node_technologies',
        'node_vulnerabilities',
        'nodes',
        'websites'
    ];
    
    db.serialize(() => {
        db.run('PRAGMA foreign_keys = OFF');
        tables.forEach(table => {
            db.run(`DELETE FROM ${table}`);
            db.run(`DELETE FROM sqlite_sequence WHERE name='${table}'`);
        });
        db.run('PRAGMA foreign_keys = ON');
    });
}

// Insert a website and get its ID
function insertWebsite(url, name) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT INTO websites (url, name) VALUES (?, ?)');
        stmt.run([url, name], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

// Insert a node and get its ID
function insertNode(websiteId, nodeData) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO nodes (
                website_id, value, type, status, size
            ) VALUES (?, ?, ?, ?, ?)
        `);
        
        stmt.run([
            websiteId,
            nodeData.value,
            nodeData.type,
            parseInt(nodeData.status) || 0,
            parseInt(nodeData.size) || 0
        ], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

// Insert headers for a node
function insertHeaders(nodeId, headers) {
    const stmt = db.prepare('INSERT INTO node_headers (node_id, header_key, header_value) VALUES (?, ?, ?)');
    headers.forEach(header => {
        stmt.run([nodeId, header.key, header.value]);
    });
    stmt.finalize();
}

// Insert technologies for a node
function insertTechnologies(nodeId, technologies) {
    const stmt = db.prepare('INSERT INTO node_technologies (node_id, technology) VALUES (?, ?)');
    technologies.forEach(tech => {
        stmt.run([nodeId, tech]);
    });
    stmt.finalize();
}

// Insert vulnerabilities for a node
function insertVulnerabilities(nodeId, vulnerabilities) {
    const stmt = db.prepare('INSERT INTO node_vulnerabilities (node_id, vulnerability) VALUES (?, ?)');
    vulnerabilities.forEach(vuln => {
        stmt.run([nodeId, vuln]);
    });
    stmt.finalize();
}

// Insert relationship between nodes
function insertRelationship(sourceId, targetId, type) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)');
        stmt.run([sourceId, targetId, type], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

// Main function to insert sample recon data
async function insertReconData() {
    try {
        // Clear existing data
        clearTables();

        // Insert a target website
        const websiteId = await insertWebsite('example-corp.com', 'Example Corporation');
        console.log('Website inserted with ID:', websiteId);

        // Sample reconnaissance data
        const reconData = {
            domains: [
                {
                    value: 'example-corp.com',
                    type: 'domain',
                    status: 200,
                    size: 1024,
                    headers: [
                        { key: 'Server', value: 'nginx/1.18.0' },
                        { key: 'X-Powered-By', value: 'PHP/7.4.3' }
                    ],
                    technologies: ['Nginx', 'PHP', 'jQuery'],
                    vulnerabilities: []
                },
                {
                    value: 'api.example-corp.com',
                    type: 'subdomain',
                    status: 200,
                    size: 512,
                    headers: [
                        { key: 'Server', value: 'Apache/2.4.41' }
                    ],
                    technologies: ['Apache', 'GraphQL'],
                    vulnerabilities: ['Exposed GraphQL Playground']
                }
            ],
            directories: [
                {
                    value: '/admin',
                    type: 'directory',
                    status: 403,
                    size: 256,
                    headers: [],
                    technologies: [],
                    vulnerabilities: ['Directory listing enabled']
                },
                {
                    value: '/api/v1',
                    type: 'directory',
                    status: 200,
                    size: 1024,
                    headers: [],
                    technologies: ['REST API'],
                    vulnerabilities: []
                }
            ],
            files: [
                {
                    value: '/robots.txt',
                    type: 'file',
                    status: 200,
                    size: 128,
                    headers: [],
                    technologies: [],
                    vulnerabilities: ['Sensitive paths disclosed']
                },
                {
                    value: '/.env.backup',
                    type: 'file',
                    status: 200,
                    size: 2048,
                    headers: [],
                    technologies: [],
                    vulnerabilities: ['Exposed configuration file']
                }
            ]
        };

        // Insert all nodes and store their IDs
        const nodeIds = {};

        // Insert domains
        for (const domain of reconData.domains) {
            const nodeId = await insertNode(websiteId, domain);
            nodeIds[domain.value] = nodeId;
            insertHeaders(nodeId, domain.headers);
            insertTechnologies(nodeId, domain.technologies);
            insertVulnerabilities(nodeId, domain.vulnerabilities);
        }

        // Insert directories
        for (const dir of reconData.directories) {
            const nodeId = await insertNode(websiteId, dir);
            nodeIds[dir.value] = nodeId;
            insertHeaders(nodeId, dir.headers);
            insertTechnologies(nodeId, dir.technologies);
            insertVulnerabilities(nodeId, dir.vulnerabilities);
        }

        // Insert files
        for (const file of reconData.files) {
            const nodeId = await insertNode(websiteId, file);
            nodeIds[file.value] = nodeId;
            insertHeaders(nodeId, file.headers);
            insertTechnologies(nodeId, file.technologies);
            insertVulnerabilities(nodeId, file.vulnerabilities);
        }

        // Create relationships
        const relationships = [
            { source: 'example-corp.com', target: 'api.example-corp.com', type: 'contains' },
            { source: 'example-corp.com', target: '/admin', type: 'contains' },
            { source: 'example-corp.com', target: '/robots.txt', type: 'contains' },
            { source: 'api.example-corp.com', target: '/api/v1', type: 'serves' },
            { source: '/api/v1', target: '/.env.backup', type: 'contains' }
        ];

        // Insert relationships
        for (const rel of relationships) {
            await insertRelationship(
                nodeIds[rel.source],
                nodeIds[rel.target],
                rel.type
            );
        }

        console.log('Sample reconnaissance data inserted successfully!');
    } catch (error) {
        console.error('Error inserting data:', error);
    } finally {
        db.close();
    }
}

// Run the insertion
insertReconData();
