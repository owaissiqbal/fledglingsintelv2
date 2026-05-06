DROP INDEX IF EXISTS `uq_compliance_inst_url`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_compliance_inst_url` ON `compliance_notices` (`institution_id`,`source_url`,`notice_type`);