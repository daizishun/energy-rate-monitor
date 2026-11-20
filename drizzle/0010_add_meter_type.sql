ALTER TABLE `settings` ADD COLUMN `meter_type` text DEFAULT 'single' NOT NULL;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `meter_type` text DEFAULT 'single' NOT NULL;
