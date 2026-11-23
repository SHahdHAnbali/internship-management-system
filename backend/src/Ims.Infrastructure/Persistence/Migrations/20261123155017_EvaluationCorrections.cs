using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// S2.4 (owner decisions of 2026-11-23, AD-72; design M1 with D3+, H1 and H2, proven in an isolated PostgreSQL proof of
    /// concept): corrections of a submitted final evaluation. Functions and triggers only: no column, constraint, index, row or
    /// other table change, so the EF model is unchanged. Replaces ONLY the "submitted is read-only" branches of the two S2.2
    /// guards; every permanent branch (identity, submission, cleared score, frozen snapshot) is kept word for word.
    /// <list type="bullet">
    /// <item>D3+: a submitted evaluation, or the score of one of its frozen criteria, changes only when THIS transaction
    /// inserted a correction record of that evaluation (proven by the record's audit INSERT row and its 64-bit transaction
    /// id, which no role but the audit trigger can write), by the current Staff actor; otherwise the S2.2 refusal under the
    /// same constraint names (so the existing 409 mappings keep working). A correction changes only the comment, the
    /// recommendation, the change counter and the last change time; never a frozen name or order, never adds a score.</item>
    /// <item>H1: a correction record is inserted only for a submitted evaluation (locked FOR UPDATE, so the corrections of
    /// one evaluation are serialized), by the transaction's Staff actor, at most one per evaluation and transaction.</item>
    /// <item>H2 (deferred to commit): each record comes with a NET change of a frozen score, the comment or the
    /// recommendation: the first value audited in the transaction differs from the final one (a reason, the counter or a
    /// value changed and restored is not a correction).</item>
    /// </list>
    /// The latest correction is the one whose audit INSERT row is the latest (the API reads it that way). The Worker's
    /// INSERT grant is in backend-workers/scripts/ims-app-grants.sql. Certificates (which will stop corrections) and
    /// reopening a training are later features.
    /// </summary>
    public partial class EvaluationCorrections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                -- D3+: a genuine correction record of this evaluation, inserted (audited) in THIS transaction by the current Staff actor.
                CREATE FUNCTION ims_evaluation_correction_in_transaction(target uuid) RETURNS boolean LANGUAGE sql AS $$
                    SELECT EXISTS (
                        SELECT 1 FROM evaluation_corrections c
                          JOIN audit_logs a ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
                         WHERE c.evaluation_id = target
                           AND a.transaction_id = pg_current_xact_id()::text::bigint
                           AND current_setting('ims.actor_type', true) = 'Staff'
                           AND c.corrected_by_id = nullif(current_setting('ims.actor_id', true), '')::uuid)
                $$;

                CREATE OR REPLACE FUNCTION ims_evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
                        -- S2.4: changed only by a correction of this transaction (same refusal name as S2.2 otherwise).
                        IF NOT ims_evaluation_correction_in_transaction(OLD.id) THEN
                            RAISE EXCEPTION 'A submitted evaluation cannot be changed.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluations_submitted_readonly';
                        END IF;
                        IF (to_jsonb(NEW) - ARRAY['comment', 'hiring_recommendation', 'version', 'updated_at'])
                           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['comment', 'hiring_recommendation', 'version', 'updated_at']) THEN
                            RAISE EXCEPTION 'A correction changes only the comment and the hiring recommendation.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluations_correction_scope';
                        END IF;
                    END IF;
                    RETURN NEW;
                END;
                $$;

                CREATE OR REPLACE FUNCTION ims_evaluation_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
                        -- S2.4: only the score of a frozen row, only by a correction of this transaction (else the S2.2 refusal).
                        IF TG_OP <> 'UPDATE' OR OLD.frozen_sort_order IS NULL
                           OR NOT ims_evaluation_correction_in_transaction(NEW.evaluation_id) THEN
                            RAISE EXCEPTION 'The scores of a submitted evaluation cannot be changed.'
                                USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_scores_submitted_readonly';
                        END IF;
                    END IF;
                    RETURN NEW; -- an unknown parent is left to the foreign key
                END;
                $$;

                -- H1: a correction record only for a Submitted evaluation, by the current Staff actor, one per evaluation and transaction.
                CREATE FUNCTION ims_evaluation_corrections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                    parent_status text;
                BEGIN
                    SELECT status INTO parent_status FROM evaluations WHERE id = NEW.evaluation_id FOR UPDATE;
                    IF parent_status IS DISTINCT FROM 'Submitted' THEN
                        RAISE EXCEPTION 'Only a submitted evaluation can be corrected.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_corrections_submitted_only';
                    END IF;
                    IF current_setting('ims.actor_type', true) IS DISTINCT FROM 'Staff'
                       OR NEW.corrected_by_id IS DISTINCT FROM nullif(current_setting('ims.actor_id', true), '')::uuid THEN
                        RAISE EXCEPTION 'A correction is recorded by the staff member making it.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_corrections_actor';
                    END IF;
                    IF EXISTS (SELECT 1 FROM evaluation_corrections c
                                 JOIN audit_logs a ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
                                WHERE c.evaluation_id = NEW.evaluation_id AND a.transaction_id = pg_current_xact_id()::text::bigint) THEN
                        RAISE EXCEPTION 'One correction per evaluation and transaction.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_corrections_one_per_transaction';
                    END IF;
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER evaluation_corrections_guard BEFORE INSERT ON evaluation_corrections
                    FOR EACH ROW EXECUTE FUNCTION ims_evaluation_corrections_guard();

                -- H2 (deferred, at commit): exactly one record for the evaluation in this transaction, and a NET change of a frozen
                -- score, the comment or the recommendation: the first old value audited in this transaction differs from the final one.
                CREATE FUNCTION ims_evaluation_corrections_net_change() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                    tx bigint := pg_current_xact_id()::text::bigint;
                    records int;
                    changed boolean;
                BEGIN
                    SELECT count(*) INTO records FROM evaluation_corrections c
                      JOIN audit_logs a ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
                     WHERE c.evaluation_id = NEW.evaluation_id AND a.transaction_id = tx;
                    IF records <> 1 THEN
                        RAISE EXCEPTION 'One correction per evaluation and transaction.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_corrections_one_per_transaction';
                    END IF;
                    SELECT EXISTS (
                               SELECT 1 FROM evaluations e
                                CROSS JOIN unnest(ARRAY['comment', 'hiring_recommendation']) AS col
                                CROSS JOIN LATERAL (SELECT a.old_values -> col AS first_value FROM audit_logs a
                                                     WHERE a.table_name = 'evaluations' AND a.entity_id = e.id::text AND a.operation = 'UPDATE'
                                                       AND a.transaction_id = tx AND a.old_values ? col
                                                     ORDER BY a.id LIMIT 1) f
                                WHERE e.id = NEW.evaluation_id AND f.first_value IS DISTINCT FROM to_jsonb(e) -> col)
                        OR EXISTS (
                               SELECT 1 FROM evaluation_scores s
                                CROSS JOIN LATERAL (SELECT a.old_values -> 'score' AS first_value FROM audit_logs a
                                                     WHERE a.table_name = 'evaluation_scores' AND a.entity_id = s.id::text AND a.operation = 'UPDATE'
                                                       AND a.transaction_id = tx AND a.old_values ? 'score'
                                                     ORDER BY a.id LIMIT 1) f
                                WHERE s.evaluation_id = NEW.evaluation_id AND s.frozen_sort_order IS NOT NULL
                                  AND f.first_value IS DISTINCT FROM to_jsonb(s) -> 'score')
                      INTO changed;
                    IF NOT changed THEN
                        RAISE EXCEPTION 'A correction must change a score, the comment or the hiring recommendation.'
                            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'evaluation_corrections_net_change';
                    END IF;
                    RETURN NULL;
                END;
                $$;
                CREATE CONSTRAINT TRIGGER evaluation_corrections_net_change AFTER INSERT ON evaluation_corrections
                    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ims_evaluation_corrections_net_change();
                """);
        }

        /// <inheritdoc />
        /// <remarks>Local and disposable databases only: restores the S2.2 guards exactly (production rolls back the code,
        /// never the guards).</remarks>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER evaluation_corrections_net_change ON evaluation_corrections;
                DROP TRIGGER evaluation_corrections_guard ON evaluation_corrections;
                DROP FUNCTION ims_evaluation_corrections_net_change();
                DROP FUNCTION ims_evaluation_corrections_guard();
                CREATE OR REPLACE FUNCTION ims_evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

                CREATE OR REPLACE FUNCTION ims_evaluation_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
                DROP FUNCTION ims_evaluation_correction_in_transaction(uuid);
                """);
        }
    }
}
