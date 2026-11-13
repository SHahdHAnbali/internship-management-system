-- Least-privilege grants for `ims_app`, the database role the IMS Worker connects as (Option A of the least-privilege
-- assessment of 2026-11-03; see docs/least-privilege.md). Rehearsed locally, applied to production on 2026-11-04 (AD-52).
--
-- Run as the owner of the schema (locally `ims`; on Neon `neondb_owner`) AFTER the role exists, created with:
--   CREATE ROLE ims_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
-- On Neon the role must be created with SQL, not in the Neon console (console roles join neon_superuser, which has
-- pg_write_all_data). This file holds no password and is safe to run more than once.
--
-- `ims_app` owns nothing, so it cannot ALTER, DROP or DISABLE TRIGGER on any table, nor replace any function. It gets
-- exactly the rights the Worker's SQL uses, taken from every statement in backend-workers/src:
--   SELECT on the 16 tables the Worker reads (all but `roles`; foreign-key checks run as the table owner),
--   INSERT on the 14 tables it inserts into, UPDATE on the 11 it updates; never DELETE, TRUNCATE, TRIGGER, REFERENCES.
-- `audit_logs`: SELECT for the Admin viewer, and INSERT because the audit trigger (`ims_audit_row_change`) runs as
-- SECURITY INVOKER, so it writes the audit row as `ims_app`. A direct INSERT is still refused by the `append_only`
-- trigger (only inserts from inside a trigger pass); that check holds only while `ims_app` cannot create a trigger of
-- its own, which is why TEMPORARY is revoked from PUBLIC below (a temporary table it owns could carry one).
-- Every new table in a later migration needs its grants added here.

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ims_app', current_database());
    -- No temporary objects for anyone but explicit grantees: closes the temporary-table trigger path to audit_logs.
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM ims_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO ims_app;
REVOKE CREATE ON SCHEMA public FROM ims_app;

-- Reads (the Worker never reads `roles` or `__EFMigrationsHistory`).
GRANT SELECT ON
    application_attachments, assignment_extensions, assignment_transfers, assignments, audit_logs, certificate_templates,
    contact_logs, employees, evaluation_criteria, fields, mentor_requests, notification_settings, notifications,
    progress_notes, responsible_hr_changes, trainee_sign_in_codes, trainees, training_applications, transfer_decisions,
    user_sessions
TO ims_app;

-- Inserts (`audit_logs` only through the audit trigger, see above).
GRANT INSERT ON
    application_attachments, assignment_extensions, assignment_transfers, assignments, audit_logs, certificate_templates,
    contact_logs, employees, evaluation_criteria, fields, mentor_requests, notifications, progress_notes,
    responsible_hr_changes, trainee_sign_in_codes, trainees, training_applications, transfer_decisions, user_sessions
TO ims_app;

-- Updates (no UPDATE on contact logs, progress notes, attachments or audit_logs: the Worker has none).
GRANT UPDATE ON
    certificate_templates, employees, evaluation_criteria, fields, mentor_requests, notification_settings,
    notifications, trainee_sign_in_codes, trainees, training_applications, user_sessions
TO ims_app;

-- Training lifecycle, Phase 1 (AD-63, owner approval 2026-11-11): HR ends a training by setting its status, actual end
-- date and reason. Column-level only: the application, employee, mentor request, start date and creation time of an
-- assignment can never be changed by the Worker.
GRANT UPDATE (status, end_date, end_reason) ON assignments TO ims_app;
-- Training extension (AD-63 L2, NEW-35): `assignment_extensions` is insert-only for the Worker (SELECT and INSERT above,
-- no UPDATE): every extension and its reason stay as recorded; the extension moves `assignments.end_date` (granted above).
-- Responsible HR (AD-64): `responsible_hr_changes` is insert-only for the Worker too (SELECT and INSERT above, no UPDATE):
-- every Admin appointment stays as recorded; the accepting HR stays in `training_applications.decided_by_id`.
-- Transfer (AD-65): `assignment_transfers` is insert-only for the Worker too (SELECT and INSERT above, no UPDATE); an
-- executed transfer closes the outgoing assignment through the column grant above and inserts the incoming one. A
-- transfer decision only ever leaves Pending (executed, cancelled or void), so only its resolution columns are updatable.
GRANT UPDATE (status, resolved_at, resolved_by_id, resolution_code, resolution_reason) ON transfer_decisions TO ims_app;

-- Only the schema owner sets up audit protection on a table.
REVOKE EXECUTE ON FUNCTION ims_protect_table(regclass) FROM PUBLIC;
