/**
 * DefaultSchema — Bootstrap SQL schema for SqlVec DB
 *
 * Defines the default tables, vector indexes, metadata tables,
 * and NOTIFY/LISTEN compatibility tables.
 */

import { getNotifyListenInitSql } from '../query/NotifyListenShim';

const notifyListenDdl = getNotifyListenInitSql();

export const BOOTSTRAP_SCHEMA = `
-- Metadata table for shard-level configuration
CREATE TABLE IF NOT EXISTS __sqlvec_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO __sqlvec_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO __sqlvec_meta (key, value) VALUES ('created_at', datetime('now'));

${notifyListenDdl[0]};

${notifyListenDdl[1]};
`;
