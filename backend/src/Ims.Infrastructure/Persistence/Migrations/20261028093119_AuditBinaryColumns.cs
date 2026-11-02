using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Binary columns (the certificate logo and HR signature images, and any future uploaded file) are never copied into
    /// <c>audit_logs</c>. The audit trigger records, for each such column, only <c>{"action", "bytes", "sha256"}</c>:
    /// action <c>uploaded</c>, <c>replaced</c> or <c>removed</c> in <c>new_values</c>, and the previous size and hash in
    /// <c>old_values</c>. Everything else is unchanged: same function name and triggers, actor, transaction id, change
    /// detection (an identical re-upload is not a change), append-only log, no deletes. Existing audit rows are not
    /// touched (the log is append-only).
    /// </summary>
    public partial class AuditBinaryColumns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                -- Size and SHA-256 of a binary value, never its content; JSON null for NULL.
                CREATE FUNCTION ims_audit_binary_summary(value bytea) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
                    SELECT CASE WHEN value IS NULL THEN 'null'::jsonb
                                ELSE jsonb_build_object('bytes', octet_length(value), 'sha256', encode(sha256(value), 'hex'))
                           END
                $$;

                CREATE OR REPLACE FUNCTION ims_audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                    new_row        jsonb := to_jsonb(NEW);
                    old_row        jsonb;
                    old_values     jsonb;
                    new_values     jsonb;
                    binary_columns text[];
                    binary_column  text;
                    new_binary     bytea;
                    old_binary     bytea;
                BEGIN
                    IF TG_OP <> 'INSERT' THEN
                        old_row := to_jsonb(OLD);
                    END IF;

                    -- Replace every binary (bytea) column by its size and hash before anything is compared or logged.
                    SELECT array_agg(a.attname::text) INTO binary_columns
                      FROM pg_attribute a
                     WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'bytea'::regtype;

                    FOREACH binary_column IN ARRAY coalesce(binary_columns, '{}') LOOP
                        EXECUTE format('SELECT ($1).%I, ($2).%I', binary_column, binary_column)
                           INTO new_binary, old_binary USING NEW, OLD;
                        new_row := jsonb_set(new_row, ARRAY[binary_column], ims_audit_binary_summary(new_binary));
                        IF old_row IS NOT NULL THEN
                            old_row := jsonb_set(old_row, ARRAY[binary_column], ims_audit_binary_summary(old_binary));
                        END IF;
                    END LOOP;

                    IF TG_OP = 'INSERT' THEN
                        new_values := new_row;
                    ELSE
                        SELECT jsonb_object_agg(n.key, old_row -> n.key), jsonb_object_agg(n.key, n.value)
                          INTO old_values, new_values
                          FROM jsonb_each(new_row) AS n
                         WHERE n.value IS DISTINCT FROM old_row -> n.key;

                        IF new_values IS NULL THEN
                            RETURN NULL; -- no column actually changed
                        END IF;
                    END IF;

                    -- Say what happened to each binary column that is logged.
                    FOREACH binary_column IN ARRAY coalesce(binary_columns, '{}') LOOP
                        CONTINUE WHEN NOT new_values ? binary_column
                                   OR (TG_OP = 'INSERT' AND new_values -> binary_column = 'null'::jsonb);
                        new_values := jsonb_set(new_values, ARRAY[binary_column],
                            CASE
                                WHEN new_values -> binary_column = 'null'::jsonb THEN jsonb_build_object('action', 'removed')
                                WHEN old_values IS NULL OR old_values -> binary_column IS NULL
                                     OR old_values -> binary_column = 'null'::jsonb
                                    THEN jsonb_build_object('action', 'uploaded') || (new_values -> binary_column)
                                ELSE jsonb_build_object('action', 'replaced') || (new_values -> binary_column)
                            END);
                    END LOOP;

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
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Restores the AdminModule version of the audit function (binary columns copied as-is).
            migrationBuilder.Sql("""
                CREATE OR REPLACE FUNCTION ims_audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
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

                DROP FUNCTION IF EXISTS ims_audit_binary_summary(bytea);
                """);
        }
    }
}
