CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  street TEXT NOT NULL,
  suburb TEXT NOT NULL,
  postcode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'VIC',
  elec_distributor_id TEXT NOT NULL,
  elec_distributor_label TEXT NOT NULL,
  elec_match TEXT NOT NULL,
  gas_distributor_id TEXT NOT NULL,
  gas_distributor_label TEXT NOT NULL,
  gas_match TEXT NOT NULL DEFAULT '',
  gas_zone TEXT NOT NULL DEFAULT '',
  elec_kwh INTEGER NOT NULL,
  gas_mj INTEGER NOT NULL,
  elec_peak_kwh INTEGER NOT NULL DEFAULT 1160,
  elec_flat_kwh INTEGER NOT NULL DEFAULT 2120,
  elec_shoulder_kwh INTEGER NOT NULL DEFAULT 720,
  solar_export_kwh INTEGER NOT NULL DEFAULT 0,
  current_elec_net_annual INTEGER,
  current_gas_annual INTEGER,
  current_elec_note TEXT NOT NULL DEFAULT '',
  current_gas_note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE `snapshots` ADD COLUMN `address_id` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `active_address_id` integer;
