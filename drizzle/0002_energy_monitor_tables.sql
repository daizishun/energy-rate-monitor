DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  elec_plans TEXT NOT NULL DEFAULT '[]',
  gas_plans TEXT NOT NULL DEFAULT '[]',
  elec_basis_kwh INTEGER NOT NULL,
  gas_basis_mj INTEGER NOT NULL,
  brands_ok INTEGER NOT NULL DEFAULT 0,
  brands_failed INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
--> statement-breakpoint
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  elec_kwh INTEGER NOT NULL,
  gas_mj INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE retailers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  offers TEXT NOT NULL,
  website TEXT,
  sort_order INTEGER NOT NULL
);
