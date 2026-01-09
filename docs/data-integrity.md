# Data Integrity (Duplicates + Idempotent Imports)

## Why duplicates happened

1. **Race conditions during parallel imports**
   - Multiple Python import processes (dirsearch/fingerprint) run concurrently.
   - They used `SELECT ...; INSERT ...` without a DB-level unique constraint.
   - Two writers can both observe "missing" and both insert the same node → duplicate rows.

2. **Non-idempotent counters**
   - Some imports updated aggregate fields like `dirsearch_count` using `+=`, so re-importing the same file changed DB state.

## Stable node identity model

Node identity is **(website_id, value)**.

- `website_id` scopes nodes to a target website.
- `value` is the stable key used by the API/graph as `node.id`.

This is enforced by a UNIQUE index: `ux_nodes_website_value`.

## What enforces this in the app

- On server startup, `server/modules/dbIntegrity.js`:
  - deduplicates legacy duplicates (merge child rows and relationships)
  - creates `ux_nodes_website_value` if missing
  - writes a backup of the DB file before the migration

- Python importers use `INSERT OR IGNORE` + deterministic updates so they are safe to run repeatedly and safe under concurrency.

## Rollback

If the migration fails or the graph looks wrong:

1. Stop the API server.
2. Restore the latest `server/data.db.bak-<timestamp>` to `server/data.db`.
3. Start the server again.

