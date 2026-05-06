ALTER TABLE `inspections` ADD `inclusion` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `attendance_behaviour` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `personal_dev_wellbeing` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `achievement` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `curriculum_teaching` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `young_peoples_provision` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `high_needs_provision` text;--> statement-breakpoint
ALTER TABLE `inspections` ADD `contribution_to_skills` text;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `financial_literacy_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `employability_skills_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `confidence_resilience_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `online_safety_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `critical_signals` text;--> statement-breakpoint
ALTER TABLE `opportunity_scores` ADD `tier` text;