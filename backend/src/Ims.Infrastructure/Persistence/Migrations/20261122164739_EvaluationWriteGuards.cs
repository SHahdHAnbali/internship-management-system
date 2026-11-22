using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// S2.2 (owner decision K1, option B, 2026-11-22): database guards on the final evaluation tables, for every role, the
    /// schema owner included (only a superuser or the table owner can disable a trigger; the Worker's role cannot).
    /// Functions and triggers only: no column, constraint, row or other table changes, so the EF model is unchanged.
    /// <list type="bullet">
    /// <item>Permanent: an evaluation keeps its identity (id, application, assignment, creation time); a submitted
    /// evaluation never returns to Draft and keeps its submitter and submission time (AD-66); a saved score is never
    /// cleared; a frozen criterion snapshot never changes; a score keeps its evaluation and criterion.</item>
    /// <item>S2.2: a submitted evaluation and its scores are read-only. Corrections (S2.4) will replace only these
    /// branches, by their own approved migration; there is deliberately no bypass here.</item>
    /// <item>The Draft → Submitted transition (S2.3) stays possible: its scores are frozen while the evaluation is still a
    /// Draft, then its status changes (the Worker's role is not granted those columns before S2.3).</item>
    /// </list>
    /// Refusals use SQLSTATE 23001 (restrict_violation, as the no-delete guard) with a stable constraint name. The score
    /// guard locks the parent evaluation FOR SHARE: a score write waits for a concurrent submission, then sees it.
    /// </summary>
    public partial class EvaluationWriteGuards : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE FUNCTION ims_evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    -- Permanent: an evaluation keeps its identity.
                    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.application_id IS DISTINCT FROM OLD.application_id
                       OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
                        RAISE EXCEPTION 'An evaluation''s application, assignment and creation time cannot be changed.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluations_identity_immutable';
                    END IF;
                    IF OLD.status = 'Submitted' THEN
                        -- Permanent: never back to Draft; the original submitter and submission time are kept (AD-66).
                        IF NEW.status IS DISTINCT FROM OLD.status OR NEW.submitted_by_id IS DISTINCT FROM OLD.submitted_by_id
                           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
                            RAISE EXCEPTION 'A submitted evaluation keeps its status, submitter and submission time.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluations_submission_immutable';
                        END IF;
                        -- S2.2: a submitted evaluation is read-only (S2.4 replaces only this branch, with its own approval).
                        RAISE EXCEPTION 'A submitted evaluation cannot be changed.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluations_submitted_readonly';
                    END IF;
                    RETURN NEW;
                END;
                $$;

                CREATE TRIGGER evaluations_guard BEFORE UPDATE ON evaluations
                    FOR EACH ROW EXECUTE FUNCTION ims_evaluations_guard();

                CREATE FUNCTION ims_evaluation_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                    parent_status text;
                BEGIN
                    IF TG_OP = 'UPDATE' THEN
                        -- Permanent: a score keeps its evaluation and criterion, a saved score is never cleared, and a frozen
                        -- snapshot never changes.
                        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
                           OR NEW.criterion_id IS DISTINCT FROM OLD.criterion_id THEN
                            RAISE EXCEPTION 'A score''s evaluation and criterion cannot be changed.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_scores_identity_immutable';
                        END IF;
                        IF OLD.score IS NOT NULL AND NEW.score IS NULL THEN
                            RAISE EXCEPTION 'A saved score cannot be cleared.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_scores_not_cleared';
                        END IF;
                        IF OLD.frozen_sort_order IS NOT NULL AND (NEW.frozen_name_ar IS DISTINCT FROM OLD.frozen_name_ar
                           OR NEW.frozen_name_en IS DISTINCT FROM OLD.frozen_name_en
                           OR NEW.frozen_sort_order IS DISTINCT FROM OLD.frozen_sort_order) THEN
                            RAISE EXCEPTION 'A frozen criterion snapshot cannot be changed.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_scores_snapshot_immutable';
                        END IF;
                    END IF;
                    -- Lock the parent (waits for a concurrent status change) and read its latest committed status.
                    SELECT status INTO parent_status FROM evaluations WHERE id = NEW.evaluation_id FOR SHARE;
                    IF parent_status = 'Submitted' THEN
                        -- S2.2: the scores of a submitted evaluation are read-only (S2.4 replaces only this branch).
                        RAISE EXCEPTION 'The scores of a submitted evaluation cannot be changed.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_scores_submitted_readonly';
                    END IF;
                    RETURN NEW; -- an unknown parent is left to the foreign key
                END;
                $$;

                CREATE TRIGGER evaluation_scores_guard BEFORE INSERT OR UPDATE ON evaluation_scores
                    FOR EACH ROW EXECUTE FUNCTION ims_evaluation_scores_guard();
                """);
        }

        /// <inheritdoc />
        /// <remarks>Local and disposable databases only: production rolls back the code, never the guards.</remarks>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER evaluation_scores_guard ON evaluation_scores;
                DROP FUNCTION ims_evaluation_scores_guard();
                DROP TRIGGER evaluations_guard ON evaluations;
                DROP FUNCTION ims_evaluations_guard();
                """);
        }
    }
}
