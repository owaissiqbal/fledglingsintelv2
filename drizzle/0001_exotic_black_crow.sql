CREATE TABLE `polished_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` integer NOT NULL,
	`top_finding_id` integer,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_polished_institution` ON `polished_emails` (`institution_id`);