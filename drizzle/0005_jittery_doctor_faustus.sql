CREATE TABLE `compliance_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` integer NOT NULL,
	`notice_body` text NOT NULL,
	`notice_type` text NOT NULL,
	`issued_at` text,
	`withdrawn_at` text,
	`expires_at` text,
	`severity` integer DEFAULT 50 NOT NULL,
	`subject` text NOT NULL,
	`details` text,
	`source_url` text NOT NULL,
	`source_title` text,
	`raw_payload` text,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_compliance_event` ON `compliance_notices` (`institution_id`,`notice_body`,`notice_type`,`issued_at`);--> statement-breakpoint
CREATE INDEX `idx_compliance_institution` ON `compliance_notices` (`institution_id`,`severity`);--> statement-breakpoint
CREATE INDEX `idx_compliance_body_type` ON `compliance_notices` (`notice_body`,`notice_type`);--> statement-breakpoint
CREATE INDEX `idx_compliance_issued` ON `compliance_notices` (`issued_at`);--> statement-breakpoint
CREATE INDEX `idx_compliance_active` ON `compliance_notices` (`withdrawn_at`,`severity`);--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` integer NOT NULL,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text,
	`body` text,
	`published_at` text,
	`relevance` integer DEFAULT 50 NOT NULL,
	`trigger_severity` integer DEFAULT 0 NOT NULL,
	`curricula_tagged` text,
	`angle` text,
	`content_hash` text,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_news_url_inst` ON `news_items` (`url`,`institution_id`);--> statement-breakpoint
CREATE INDEX `idx_news_institution` ON `news_items` (`institution_id`,`trigger_severity`);--> statement-breakpoint
CREATE INDEX `idx_news_source` ON `news_items` (`source`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_news_published` ON `news_items` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_news_relevance` ON `news_items` (`relevance`);