// One-time operator bootstrap. This is not an HTTP endpoint or a user login.
// The caller must already have filesystem access to the team's database.
import { readFile } from 'node:fs/promises';
import { createStore } from '../team-web/server/store.mjs';

const [database, input] = process.argv.slice(2);
if (!database || !input) throw new Error('Usage: node scripts/team-import-inventory.mjs DATABASE INVENTORY_JSON');
const text = await readFile(input, 'utf8');
if (text.length > 512 * 1024) throw new Error('Inventory is too large');
const inventory = JSON.parse(text);
if (!Array.isArray(inventory.resources) || inventory.resources.length > 32 || typeof inventory.sourceId !== 'string') throw new Error('Invalid inventory');
const store = createStore({ dbPath: database });
try {
  const bindings = {};
  for (const resource of inventory.resources) {
    const result = store.syncResource({ ...resource, sourceId: inventory.sourceId }, { id: 'operator-initialization', name: '资源初始化', role: 'admin' });
    if (!result.binding?.authoritative) throw new Error('Resource is already managed by another source; do not overwrite it');
    bindings[resource.serverId] = result.id;
  }
  console.log(JSON.stringify({ sourceId: inventory.sourceId, bindings }));
} finally { store.close(); }
