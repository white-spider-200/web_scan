const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('./config');

const dbPath = path.resolve(__dirname, config.database.path);
const db = new sqlite3.Database(dbPath);

// Clear existing data
function clearTables() {
    const tables = [
        'node_relationships',
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

// Seed data
async function seedData() {
    clearTables();
    
    // Add example website
    db.run(`INSERT INTO websites (id, url, name) VALUES (?, ?, ?)`,
        [1, 'example.com', 'Example Corp'],
        function(err) {
            if (err) {
                console.error('Error adding website:', err.message);
                return;
            }
            
            const nodes = [
                // Main domain and subdomains
                [1, 'example.com', 'domain', 200, 1024],
                [1, 'api.example.com', 'subdomain', 200, 512],
                [1, 'admin.example.com', 'subdomain', 401, 256],
                [1, 'dev.example.com', 'subdomain', 403, 256],
                
                // Directories
                [1, '/admin', 'directory', 302, 512],
                [1, '/api/v1', 'directory', 200, 1024],
                [1, '/uploads', 'directory', 403, 256],
                [1, '/backup', 'directory', 403, 128],
                
                // Files
                [1, '/robots.txt', 'file', 200, 128],
                [1, '/sitemap.xml', 'file', 200, 2048],
                [1, '/.env.backup', 'file', 403, 0],
                [1, '/package.json', 'file', 403, 0],
                
                // Endpoints
                [1, '/api/v1/users', 'endpoint', 200, 2048],
                [1, '/api/v1/login', 'endpoint', 200, 512],
                [1, '/api/v1/admin/users', 'endpoint', 401, 0]
            ];

            db.serialize(() => {
                const stmt = db.prepare(`
                    INSERT INTO nodes (website_id, value, type, status, size) 
                    VALUES (?, ?, ?, ?, ?)
                `);

                nodes.forEach(node => stmt.run(node));
                stmt.finalize();
            });

            // After nodes are inserted, create relationships
            setTimeout(() => {
                const relationships = [
                    // Domain relationships
                    [1, 2],  // example.com -> api.example.com
                    [1, 3],  // example.com -> admin.example.com
                    [1, 4],  // example.com -> dev.example.com
                    
                    // Directory relationships
                    [1, 5],  // example.com -> /admin
                    [1, 6],  // example.com -> /api/v1
                    [1, 7],  // example.com -> /uploads
                    [1, 8],  // example.com -> /backup
                    
                    // File relationships
                    [1, 9],  // example.com -> robots.txt
                    [1, 10], // example.com -> sitemap.xml
                    [1, 11], // example.com -> .env.backup
                    [1, 12], // example.com -> package.json
                    
                    // API endpoint relationships
                    [2, 13], // api.example.com -> /api/v1/users
                    [2, 14], // api.example.com -> /api/v1/login
                    [2, 15], // api.example.com -> /api/v1/admin/users
                    
                    // Directory to endpoint relationships
                    [6, 13], // /api/v1 -> /api/v1/users
                    [6, 14], // /api/v1 -> /api/v1/login
                    [6, 15]  // /api/v1 -> /api/v1/admin/users
                ];

                const relStmt = db.prepare(`
                    INSERT INTO node_relationships (source_node_id, target_node_id)
                    VALUES (?, ?)
                `);

                relationships.forEach(rel => relStmt.run(rel));
                relStmt.finalize();

                console.log('Database seeded successfully!');
            }, 1000); // Wait 1 second for nodes to be inserted
        }
    );
}

// Run the seed
seedData().catch(err => {
    console.error('Error seeding database:', err);
});
