ALTER TABLE `addresses` ADD COLUMN `elec_candidates` text;
--> statement-breakpoint
ALTER TABLE `addresses` ADD COLUMN `networks_confirmed` integer DEFAULT 1 NOT NULL;
