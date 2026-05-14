CREATE TABLE IF NOT EXISTS runtime_locks (
  key TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
