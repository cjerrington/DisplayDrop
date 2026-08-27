// Drop-in for `node:sqlite`'s DatabaseSync so the app runs both under Node
// and under a Bun-compiled standalone binary. Bun ships a synchronous SQLite
// engine (bun:sqlite) but no node:sqlite implementation, so route to it here.
let DatabaseSync;

if (typeof Bun !== 'undefined') {
  const { Database } = await import('bun:sqlite');
  // node:sqlite enables foreign-key constraints by default; bun:sqlite does
  // not. The schema relies on ON DELETE CASCADE, so mirror node:sqlite.
  class BunDatabaseSync extends Database {
    constructor(path, options) {
      super(path, options);
      this.exec('PRAGMA foreign_keys = ON');
    }
  }
  DatabaseSync = BunDatabaseSync;
} else {
  const nodeSqlite = 'node:sqlite';
  DatabaseSync = (await import(nodeSqlite)).DatabaseSync;
}

export { DatabaseSync };
