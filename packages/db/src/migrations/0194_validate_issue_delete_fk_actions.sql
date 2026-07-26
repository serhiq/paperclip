ALTER TABLE "cost_events" VALIDATE CONSTRAINT "cost_events_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "finance_events" VALIDATE CONSTRAINT "finance_events_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" VALIDATE CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_comments" VALIDATE CONSTRAINT "issue_comments_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_read_states" VALIDATE CONSTRAINT "issue_read_states_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" VALIDATE CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_votes" VALIDATE CONSTRAINT "feedback_votes_issue_id_issues_id_fk";
