ALTER TABLE settings ADD COLUMN elec_peak_kwh INTEGER NOT NULL DEFAULT 1160;
--> statement-breakpoint
ALTER TABLE settings ADD COLUMN elec_flat_kwh INTEGER NOT NULL DEFAULT 2120;
--> statement-breakpoint
ALTER TABLE settings ADD COLUMN elec_shoulder_kwh INTEGER NOT NULL DEFAULT 720;
--> statement-breakpoint
ALTER TABLE settings ADD COLUMN solar_export_kwh INTEGER NOT NULL DEFAULT 0;
