ALTER TABLE `settings` ADD COLUMN `has_solar` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `has_battery` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `has_ev` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `elec_daily_kwh` real NOT NULL DEFAULT 11;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `self_gen_daily_kwh` real NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `gas_daily_mj` real NOT NULL DEFAULT 139;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `has_solar` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `has_battery` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `has_ev` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `elec_daily_kwh` real NOT NULL DEFAULT 11;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `self_gen_daily_kwh` real NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `gas_daily_mj` real NOT NULL DEFAULT 139;
