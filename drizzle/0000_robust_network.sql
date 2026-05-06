CREATE TABLE `curriculum_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`institution_id` integer NOT NULL,
	`curriculum` text NOT NULL,
	`weight` real NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_curriculum` ON `curriculum_matches` (`curriculum`,`weight`);--> statement-breakpoint
CREATE INDEX `idx_match_finding` ON `curriculum_matches` (`finding_id`);--> statement-breakpoint
CREATE INDEX `idx_match_institution` ON `curriculum_matches` (`institution_id`,`curriculum`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`inspection_id` integer NOT NULL,
	`institution_id` integer NOT NULL,
	`phrase_id` text NOT NULL,
	`phrase_pattern` text NOT NULL,
	`section_key` text NOT NULL,
	`source_quote` text NOT NULL,
	`quote_start` integer,
	`quote_end` integer,
	`base_severity` integer NOT NULL,
	`multiplier` real NOT NULL,
	`final_severity` real NOT NULL,
	`suppressed` integer DEFAULT false NOT NULL,
	`suppression_reason` text,
	`phrase_library_version_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`inspection_id`) REFERENCES `inspections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_finding_institution` ON `findings` (`institution_id`,`final_severity`);--> statement-breakpoint
CREATE INDEX `idx_finding_inspection` ON `findings` (`inspection_id`);--> statement-breakpoint
CREATE INDEX `idx_finding_phrase` ON `findings` (`phrase_id`);--> statement-breakpoint
CREATE INDEX `idx_finding_suppressed` ON `findings` (`suppressed`);--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`records_seen` integer DEFAULT 0 NOT NULL,
	`records_upserted` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`triggered_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_run_source` ON `ingestion_runs` (`source`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_run_status` ON `ingestion_runs` (`status`);--> statement-breakpoint
CREATE TABLE `inspections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` integer NOT NULL,
	`inspection_body` text NOT NULL,
	`framework` text,
	`inspection_type` text,
	`inspection_start_date` text NOT NULL,
	`inspection_end_date` text,
	`publication_date` text,
	`report_url` text NOT NULL,
	`report_pdf_path` text,
	`report_text` text,
	`report_text_hash` text,
	`overall_grade` text,
	`quality_of_education` text,
	`behaviour_attitudes` text,
	`personal_development` text,
	`leadership_management` text,
	`sixth_form_provision` text,
	`apprenticeships` text,
	`adult_learning_programmes` text,
	`safeguarding_effective` integer,
	`isi_overall` text,
	`previous_overall_grade` text,
	`previous_inspection_id` integer,
	`grade_dropped` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_event` ON `inspections` (`institution_id`,`inspection_start_date`,`inspection_body`);--> statement-breakpoint
CREATE INDEX `idx_insp_institution` ON `inspections` (`institution_id`,`inspection_start_date`);--> statement-breakpoint
CREATE INDEX `idx_insp_grade` ON `inspections` (`overall_grade`);--> statement-breakpoint
CREATE INDEX `idx_insp_grade_dropped` ON `inspections` (`grade_dropped`);--> statement-breakpoint
CREATE INDEX `idx_insp_publication` ON `inspections` (`publication_date`);--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`urn` text,
	`ukprn` text,
	`isi_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`phase` text,
	`region` text,
	`local_authority` text,
	`postcode` text,
	`address` text,
	`gender` text,
	`religious_character` text,
	`website` text,
	`phone` text,
	`general_email` text,
	`head_name` text,
	`head_email` text,
	`in_scope` integer DEFAULT true NOT NULL,
	`out_of_scope_reason` text,
	`source` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inst_urn` ON `institutions` (`urn`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inst_ukprn` ON `institutions` (`ukprn`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inst_isi_id` ON `institutions` (`isi_id`);--> statement-breakpoint
CREATE INDEX `idx_inst_postcode` ON `institutions` (`postcode`);--> statement-breakpoint
CREATE INDEX `idx_inst_region_type` ON `institutions` (`region`,`type`);--> statement-breakpoint
CREATE INDEX `idx_inst_in_scope` ON `institutions` (`in_scope`);--> statement-breakpoint
CREATE INDEX `idx_inst_name` ON `institutions` (`name`);--> statement-breakpoint
CREATE TABLE `opportunity_scores` (
	`institution_id` integer PRIMARY KEY NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`raw_score` real DEFAULT 0 NOT NULL,
	`top_curriculum` text,
	`top_curriculum_score` real,
	`top_finding_id` integer,
	`finding_count` integer DEFAULT 0 NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL,
	`last_inspection_id` integer,
	`last_calculated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_score_score` ON `opportunity_scores` (`score`);--> statement-breakpoint
CREATE INDEX `idx_score_top_curriculum` ON `opportunity_scores` (`top_curriculum`,`score`);--> statement-breakpoint
CREATE TABLE `outreach_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` integer NOT NULL,
	`pushed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`instantly_lead_id` text,
	`instantly_campaign_id` text,
	`instantly_list_id` text,
	`top_curriculum` text,
	`top_weakness` text,
	`template_id` text,
	`status` text DEFAULT 'success' NOT NULL,
	`error_message` text,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outreach_institution` ON `outreach_log` (`institution_id`,`pushed_at`);--> statement-breakpoint
CREATE INDEX `idx_outreach_status` ON `outreach_log` (`status`);--> statement-breakpoint
CREATE TABLE `phrase_library_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`loaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`yaml_hash` text NOT NULL,
	`phrase_count` integer NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_phrase_lib_hash` ON `phrase_library_versions` (`yaml_hash`);--> statement-breakpoint
CREATE TABLE `raw_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`content_type` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`status_code` integer,
	`sha256` text,
	`local_path` text,
	`bytes` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_raw_url` ON `raw_documents` (`url`);--> statement-breakpoint
CREATE INDEX `idx_raw_sha` ON `raw_documents` (`sha256`);--> statement-breakpoint
CREATE TABLE `report_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`inspection_id` integer NOT NULL,
	`section_key` text NOT NULL,
	`section_title` text,
	`section_text` text NOT NULL,
	`multiplier` real DEFAULT 1 NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`inspection_id`) REFERENCES `inspections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_section_inspection` ON `report_sections` (`inspection_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_section_key` ON `report_sections` (`section_key`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`filter_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_view_name` ON `saved_views` (`name`);