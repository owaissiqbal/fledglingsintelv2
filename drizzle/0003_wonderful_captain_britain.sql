ALTER TABLE `opportunity_scores` ADD `pipeline_value_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `urgency_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `inspection_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `first_inspection_date` text;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `latest_inspection_date` text;