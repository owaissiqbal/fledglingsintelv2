DROP INDEX IF EXISTS `uq_compliance_event`;--> statement-breakpoint
-- Wipe existing rows: the new unique key would clash with duplicates
-- created under the old (institution_id, notice_body, notice_type, issued_at)
-- index where issued_at was NULL. Compliance ingests will repopulate on
-- the next refresh.
DELETE FROM `compliance_notices`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_compliance_inst_url` ON `compliance_notices` (`institution_id`,`source_url`);