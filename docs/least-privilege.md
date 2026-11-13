# Least-privilege database role for the Worker (`ims_app`)

**Status: Option A, rehearsed locally and deployed to production on 2026-11-04 (owner approval).** The production Worker
now connects as `ims_app` (since Worker version `aaa13c87`; kept by the current `6900a9e2`, 2026-11-07). The owner's signed-in smoke test passed on 2026-11-04 (below).
Option B is not done. Basis: the read-only Neon least-privilege assessment of 2026-11-03.

## The role

`ims_app` is the database role the IMS Worker connects as. It is an ordinary login role: no superuser, no CREATEDB, no
CREATEROLE, no BYPASSRLS, no REPLICATION, member of no role, owner of nothing (no table, function, sequence or schema).
The schema owner (locally `ims`, on Neon `neondb_owner`) keeps owning everything and runs the migrations.

Grants, in [`backend-workers/scripts/ims-app-grants.sql`](../backend-workers/scripts/ims-app-grants.sql) (no password
in it; safe to run again):

| Privilege | Tables |
|---|---|
| CONNECT | the database |
| USAGE (not CREATE) | schema `public` |
| SELECT (18) | `application_attachments`, `assignment_extensions`, `assignments`, `audit_logs`, `certificate_templates`, `contact_logs`, `employees`, `evaluation_criteria`, `fields`, `mentor_requests`, `notification_settings`, `notifications`, `progress_notes`, `responsible_hr_changes`, `trainee_sign_in_codes`, `trainees`, `training_applications`, `user_sessions` |
| INSERT (17) | the same, except `notification_settings` (`audit_logs` only through the audit trigger, see below). `assignment_extensions` (training extension, NEW-35) is insert-only: SELECT and INSERT, never UPDATE; applied on Neon by the owner's authorization on 2026-11-12 as `neondb_owner`, in one transaction, after the `AssignmentExtensions` migration, verified: SELECT and INSERT only, no UPDATE (table or column), DELETE or TRUNCATE; `ims_app` still owns nothing and holds no elevated attribute; every other grant unchanged. `responsible_hr_changes` (responsible HR, AD-64) is insert-only too: SELECT and INSERT, never UPDATE; applied on Neon by the owner's authorization on 2026-11-13 as `neondb_owner`, in one transaction, after the `ResponsibleHrChanges` migration, verified: SELECT and INSERT only, no UPDATE (table or column), DELETE or TRUNCATE; `ims_app` still owns nothing and holds no elevated attribute; every other grant unchanged |
| UPDATE (11) | `certificate_templates`, `employees`, `evaluation_criteria`, `fields`, `mentor_requests`, `notification_settings`, `notifications`, `trainee_sign_in_codes`, `trainees`, `training_applications`, `user_sessions` |
| UPDATE, column-level | `assignments (status, end_date, end_reason)` only, for the training lifecycle (AD-63 Phase 1). Applied on Neon by the owner's authorization on 2026-11-11 as `neondb_owner`, in one transaction, verified: those three columns only, no table-wide UPDATE, no other column, still no DELETE or TRUNCATE; no row changed |
| never | DELETE, TRUNCATE, TRIGGER, REFERENCES on any table; anything on `roles` and `__EFMigrationsHistory` (foreign-key checks run as the table owner) |

The list comes from every SQL statement in `backend-workers/src`. No sequence grant is needed: `audit_logs.id` is an
identity column (no privilege check) and every other id is made by the Worker. Trigger functions are not
privilege-checked when they fire.

**Revoked from PUBLIC:**
- `TEMPORARY` on the database. With INSERT on `audit_logs` (needed because `ims_audit_row_change` is SECURITY
  INVOKER), a role able to create a temporary table could put its own trigger on it and insert a forged audit row from
  inside that trigger, which the `append_only` check (`pg_trigger_depth() > 1`) lets through. Proven locally (control
  case in `test/least-privilege.test.ts`); without TEMP, `ims_app` cannot own any table, so it cannot have a trigger.
- `EXECUTE` on `ims_protect_table(regclass)` (only the schema owner sets up audit protection).

Every new table in a later migration needs its grants added to the script; the Worker tests run as `ims_app`, so a
missing grant fails them.

## Local rehearsal (done 2026-11-04)

1. Confirmed the target: container `ims-db-1` (`postgres:18.6-alpine`, `127.0.0.1:5434`), database `ims_dev`, role
   `ims`; no Neon host in `.dev.vars` or the .NET user-secrets `ConnectionStrings:Database`.
2. Backed up `ims_dev` (`pg_dump -Fc`), the roles (`pg_dumpall --roles-only`) and `.dev.vars`, outside the repository.
3. Created the role as `ims` with a generated password, then applied the script:
   ```bash
   PW=$(openssl rand -hex 24)
   docker exec -i ims-db-1 psql -U ims -d ims_dev -v ON_ERROR_STOP=1 -v pw="$PW" \
     <<< "CREATE ROLE ims_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;"
   docker exec -i ims-db-1 psql -U ims -d ims_dev -v ON_ERROR_STOP=1 < backend-workers/scripts/ims-app-grants.sql
   ```
4. Pointed the local Worker at it: `DATABASE_URL` in the git-ignored `backend-workers/.dev.vars` uses `ims_app`. The
   .NET user-secrets keep `ims` for `dotnet ef database update`.
5. The Worker test suite runs as `ims_app` (test/global-setup.ts creates it in the disposable test container and applies
   the same script; seeding and assertions use the owner). `TEST_DATABASE_ROLE=owner` runs it as the owner instead.

**Local rollback:** set `DATABASE_URL` in `.dev.vars` back to the `ims` user, then (optional) as `ims`:
`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ims_app; REVOKE ALL ON SCHEMA public FROM ims_app; REVOKE CONNECT ON
DATABASE ims_dev FROM ims_app; DROP ROLE ims_app; GRANT TEMPORARY ON DATABASE ims_dev TO PUBLIC; GRANT EXECUTE ON
FUNCTION ims_protect_table(regclass) TO PUBLIC;` Or restore the backup with `pg_restore`.

## Results (local)

- **Functional:** the whole Worker suite (every implemented workflow: sign-in and sessions, trainee codes, Admin,
  certificate template, HR, mentor requests and assignments, progress notes, trainee applications and files,
  notifications, the four reports, the audit log viewer) passes with the Worker connected as `ims_app`.
- **Audit:** writes are audited with the right Staff/Trainee actor (sign-in attribution included) and
  `database_user = ims_app`; all triggers stay enabled; earlier audit rows untouched.
- **Refused for `ims_app`** (`test/least-privilege.test.ts`): UPDATE, DELETE, TRUNCATE on `audit_logs`; a direct forged
  INSERT (append-only trigger); disabling or dropping triggers; replacing or dropping audit functions; running
  `ims_protect_table`; CREATE, ALTER or DROP of tables; temporary tables and functions; the temporary-table forgery path;
  `SET session_replication_role`; DELETE or TRUNCATE of business tables; CREATE ROLE; SET ROLE to the owner. A GRANT by
  `ims_app` changes nothing (PostgreSQL only warns).

## What Option A does not cover

- Anyone who can run SQL as `ims_app` (stolen credentials, SQL injection) can set `ims.actor_type` / `ims.actor_id` and
  so record real writes under another user's name; they can read all data and change business data the app can change.
  They cannot delete or alter audit history, disable triggers or change the schema.
- `ims_app` keeps INSERT on `audit_logs`; forged rows are blocked only by the append-only trigger plus the TEMP revoke.
  Option B (a SECURITY DEFINER audit function owned by a dedicated role, `session_user` for `database_user`, and only
  SELECT on `audit_logs` for `ims_app`) would remove that INSERT; it changes the trigger function (separate decision).
- The schema owner, Neon console access and Neon's own administrators can still change anything.

## Production rollout (done 2026-11-04)

Neon project endpoint `ep-flat-block-b4o5p8gt` (us-east-2), database `ims_db`.

1. **Preflight:** repository at `c451cfa` plus this change; Worker `6625ef5c` connected as `neondb_owner` (the newest audit
   rows); 8 migrations; 98 audit rows; 50 triggers enabled; `ims_app` absent. All test suites passed again.
2. **Restore point:** no Neon CLI or API access was available, so a Neon branch could not be made and the point-in-time
   restore window could not be read (to be checked in the Neon console). Instead a full logical backup (`pg_dump -Fc`)
   was taken and **verified by restoring it** into a disposable container: every table's row count matched production,
   all 50 triggers present. Kept outside the repository. The owner's pooled connection string was verified to connect
   (`verify-full`), for rollback.
3. **Role:** a generated password, stored first in the .NET user-secrets (`ConnectionStrings:NeonApp`); then, as
   `neondb_owner` in one transaction, `CREATE ROLE ims_app LOGIN … NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
   NOREPLICATION` and the grants script, unchanged.
4. **Checked before the switch (read-only):** the role matched the local design exactly (SELECT 16, INSERT 15, UPDATE 11
   tables; no DELETE, TRUNCATE, TRIGGER, REFERENCES; no TEMP for `ims_app` or PUBLIC; no schema CREATE; no
   `ims_protect_table`; no `session_replication_role`; member of no role; owns nothing). `neondb_owner` holds ADMIN on
   `ims_app` (PostgreSQL gives the creator that; it gives `ims_app` nothing). Triggers, function bodies and audit rows
   unchanged. `ims_app` connected through the pooler and read every table.
5. **Switch:** `wrangler secret put DATABASE_URL` with the pooled `ims_app` string → Worker version `aaa13c87`; nothing
   else changed; Pages unchanged.
6. **After:** `/health` Healthy (a query as `ims_app`), auth config unchanged, protected endpoints 401, pages 200; an
   `ims_app` connection live on Neon; 50 triggers enabled, functions unchanged, 98 audit rows untouched.

**Owner smoke test (2026-11-04): passed.** The Admin signed in and used the audit log and the reports; the new audit
rows (a sign-out and a new session) were written by `database_user = ims_app` with the Admin as the actor; triggers and
privileges unchanged (read-only check). The Neon restore window is **6 hours** (owner, AD-54); automated daily backups
are deferred until development is complete. Still open (decisions): rotating the `neondb_owner` password (NEW-16),
Option B (NEW-15).

**Rollback:** put the owner's pooled connection string back (`wrangler secret put DATABASE_URL`); the role and grants are
inert and stay; no data is touched.
