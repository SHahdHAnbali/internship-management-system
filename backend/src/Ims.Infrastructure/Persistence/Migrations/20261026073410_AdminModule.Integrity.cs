namespace Ims.Infrastructure.Persistence.Migrations;

/// <summary>
/// Hand-written part of the AdminModule migration (the first migration): the database-level integrity layer that EF Core cannot model.
/// Enforced by PostgreSQL itself, so it also covers ExecuteUpdate/ExecuteDelete, raw SQL and manual psql sessions:
/// <list type="bullet">
/// <item><b>No hard deletes</b> — DELETE and TRUNCATE are rejected on every domain table.</item>
/// <item><b>Audit log</b> — every INSERT/UPDATE writes an <c>audit_logs</c> row in the same transaction
///   (rolled back together), with the actor taken from the <c>ims.actor_*</c> session settings.</item>
/// <item><b>Append-only audit log</b> — rows can only be inserted by the audit trigger; never updated or deleted.</item>
/// </list>
/// Every table added by a later migration must call <c>SELECT ims_protect_table('table_name');</c>
/// (a test fails if a table is left unprotected).
/// </summary>
public partial class AdminModule
{
    private const string IntegrityUpSql = """
        -- Field names are unique ignoring case (an expression index EF Core cannot model).
        CREATE UNIQUE INDEX ux_fields_name_ci ON fields (lower(name));

        -- 1. No hard deletes ------------------------------------------------------------------------------
        CREATE FUNCTION ims_prevent_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'Deleting from "%" is not allowed: records are permanent. Change their status instead.', TG_TABLE_NAME
                USING ERRCODE = 'restrict_violation';
        END;
        $$;

        -- 2. Audit every row change, in the same transaction ---------------------------------------------
        CREATE FUNCTION ims_audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            new_row    jsonb := to_jsonb(NEW);
            old_row    jsonb;
            old_values jsonb;
            new_values jsonb;
        BEGIN
            IF TG_OP = 'INSERT' THEN
                new_values := new_row;
            ELSE
                old_row := to_jsonb(OLD);
                SELECT jsonb_object_agg(n.key, old_row -> n.key), jsonb_object_agg(n.key, n.value)
                  INTO old_values, new_values
                  FROM jsonb_each(new_row) AS n
                 WHERE n.value IS DISTINCT FROM old_row -> n.key;

                IF new_values IS NULL THEN
                    RETURN NULL; -- no column actually changed
                END IF;
            END IF;

            INSERT INTO audit_logs
                (occurred_at, actor_type, actor_id, database_user, transaction_id, operation, table_name, entity_id, old_values, new_values)
            VALUES (
                clock_timestamp(),
                coalesce(nullif(current_setting('ims.actor_type', true), ''), 'Database'),
                nullif(current_setting('ims.actor_id', true), '')::uuid,
                current_user,
                pg_current_xact_id()::text::bigint,
                TG_OP,
                TG_TABLE_NAME,
                coalesce(new_row ->> 'id', new_row ->> 'code'), -- the row's primary key
                old_values,
                new_values);
            RETURN NULL;
        END;
        $$;

        -- 3. audit_logs is append-only and written by the trigger only ------------------------------------
        CREATE FUNCTION ims_audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'INSERT' AND pg_trigger_depth() > 1 THEN
                RETURN NEW; -- inserted by ims_audit_row_change
            END IF;
            RAISE EXCEPTION 'audit_logs is append-only and written by database triggers only (% rejected).', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$;

        CREATE TRIGGER append_only BEFORE INSERT OR UPDATE OR DELETE ON audit_logs
            FOR EACH ROW EXECUTE FUNCTION ims_audit_logs_append_only();
        CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit_logs
            FOR EACH STATEMENT EXECUTE FUNCTION ims_audit_logs_append_only();

        -- 4. Attach protection + audit to a table (call this for every new table in later migrations) ----
        CREATE FUNCTION ims_protect_table(target regclass) RETURNS void LANGUAGE plpgsql AS $$
        BEGIN
            EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ims_prevent_delete()', target);
            EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ims_prevent_delete()', target);
            EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION ims_audit_row_change()', target);
        END;
        $$;

        SELECT ims_protect_table(t)
          FROM unnest(ARRAY['roles', 'employees', 'fields', 'evaluation_criteria', 'notification_settings']::regclass[]) AS t;
        """;

    // Runs after the generated DropTable calls (dropping a table drops its triggers and indexes).
    private const string IntegrityDownSql = """
        DROP FUNCTION IF EXISTS ims_protect_table(regclass);
        DROP FUNCTION IF EXISTS ims_audit_logs_append_only();
        DROP FUNCTION IF EXISTS ims_audit_row_change();
        DROP FUNCTION IF EXISTS ims_prevent_delete();
        """;
}
