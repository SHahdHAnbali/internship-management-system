using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>Plain SQL helpers for the final evaluation schema tests (each test class has its own disposable database).</summary>
internal static class EvaluationSql
{
    /// <summary>A training application (with its trainee, field and HR) and one assignment; returns their ids.</summary>
    public static async Task<(Guid Application, Guid Assignment, Guid Employee)> TrainingAsync(NpgsqlConnection connection)
    {
        var (employee, trainee, field, application, assignment) =
            (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());
        await ExecuteAsync(connection, $"""
            INSERT INTO employees (id, full_name, email, role) VALUES ('{employee}', 'Synthetic Mentor', '{employee}@company.example', 'Employee');
            INSERT INTO trainees (id, email) VALUES ('{trainee}', '{trainee}@example.com');
            INSERT INTO fields (id, name, is_active) VALUES ('{field}', 'Field {field}', true);
            INSERT INTO training_applications (id, trainee_id, field_id, status, available_from, available_to, hours, mandatory_for_university, submitted_at, decided_at, decided_by_id)
              VALUES ('{application}', '{trainee}', '{field}', 'Accepted', '2026-01-01', '2026-03-01', 120, false, now(), now(), '{employee}');
            INSERT INTO assignments (id, application_id, employee_id, start_date, end_date, status, created_at)
              VALUES ('{assignment}', '{application}', '{employee}', '2026-01-01', '2026-03-01', 'Completed', now());
            """);
        return (application, assignment, employee);
    }

    public static async Task<Guid> EvaluationAsync(NpgsqlConnection connection, Guid application, Guid assignment, string columns = "", string values = "")
    {
        var id = Guid.CreateVersion7();
        await ExecuteAsync(connection, $"""
            INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at{columns})
              VALUES ('{id}', '{application}', '{assignment}', 'Draft', now(), now(){values})
            """);
        return id;
    }

    public static async Task<Guid> CriterionAsync(NpgsqlConnection connection)
    {
        var id = Guid.CreateVersion7();
        await ExecuteAsync(connection, $"INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active) VALUES ('{id}', 'معيار', 'Criterion {id}', true)");
        return id;
    }

    public static async Task<object?> ScalarAsync(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        return await command.ExecuteScalarAsync(TestContext.Current.CancellationToken);
    }

    public static async Task ExecuteAsync(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
    }

    public static async Task<PostgresException> RefusedAsync(NpgsqlConnection connection, string sql)
        => await Assert.ThrowsAsync<PostgresException>(() => ExecuteAsync(connection, sql));
}

/// <summary>
/// Migration FinalEvaluations (R27, S2.1; AD-66, AD-68 G2–G8 and the owner's S2.1 decisions of 2026-11-22): the three
/// evaluation tables, their constraints and their protection. The schema only: nothing in the API writes them yet.
/// </summary>
public sealed class FinalEvaluationsSchemaTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private static readonly string[] Tables = ["evaluations", "evaluation_scores", "evaluation_corrections"];

    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        return connection;
    }

    [Fact]
    public async Task Tables_have_exactly_the_planned_columns_and_no_mean_or_grade()
    {
        await using var connection = await OpenAsync();

        Assert.Equal(
            "evaluations: id uuid NO, application_id uuid NO, assignment_id uuid NO, status character varying(32) NO, comment character varying(4000) YES, " +
            "hiring_recommendation character varying(32) YES, version integer NO, created_at timestamp with time zone NO, updated_at timestamp with time zone NO, " +
            "submitted_by_id uuid YES, submitted_at timestamp with time zone YES | " +
            "evaluation_scores: id uuid NO, evaluation_id uuid NO, criterion_id uuid NO, score smallint YES, frozen_name_ar character varying(200) YES, " +
            "frozen_name_en character varying(200) YES, frozen_sort_order integer YES | " +
            "evaluation_corrections: id uuid NO, evaluation_id uuid NO, corrected_by_id uuid NO, corrected_at timestamp with time zone NO, reason character varying(2000) YES",
            await EvaluationSql.ScalarAsync(connection, """
                SELECT string_agg(t || ': ' || cols, ' | ' ORDER BY array_position(ARRAY['evaluations','evaluation_scores','evaluation_corrections'], t))
                  FROM (SELECT c.relname AS t,
                               string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, ', ' ORDER BY a.attnum) AS cols
                          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                         WHERE c.relname IN ('evaluations','evaluation_scores','evaluation_corrections') AND a.attnum > 0 AND NOT a.attisdropped
                         GROUP BY c.relname) s
                """));
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, """
            SELECT count(*) FROM information_schema.columns
             WHERE table_name IN ('evaluations','evaluation_scores','evaluation_corrections')
               AND column_name ~* '(mean|average|avg|total|sum|grade)'
            """));
        Assert.Equal("0", await EvaluationSql.ScalarAsync(connection,
            "SELECT column_default FROM information_schema.columns WHERE table_name = 'evaluations' AND column_name = 'version'"));
    }

    [Fact]
    public async Task Every_foreign_key_restricts_deletes_and_the_lookups_are_indexed()
    {
        await using var connection = await OpenAsync();

        Assert.Equal(
            "evaluation_corrections.corrected_by_id→employees r;evaluation_corrections.evaluation_id→evaluations r;" +
            "evaluation_scores.criterion_id→evaluation_criteria r;evaluation_scores.evaluation_id→evaluations r;" +
            "evaluations.application_id→training_applications r;evaluations.assignment_id→assignments r;evaluations.submitted_by_id→employees r",
            await EvaluationSql.ScalarAsync(connection, """
                SELECT string_agg(fk, ';' ORDER BY fk) FROM (
                  SELECT format('%s.%s→%s %s', c.conrelid::regclass, a.attname, c.confrelid::regclass, c.confdeltype) AS fk
                    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                   WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('evaluations','evaluation_scores','evaluation_corrections')) s
                """));
        Assert.Equal(
            "ix_evaluation_corrections_corrected_by_id,ix_evaluation_corrections_evaluation_id,ix_evaluation_scores_criterion_id," +
            "ix_evaluations_assignment_id,ix_evaluations_submitted_by_id,ux_evaluation_scores_evaluation_id_criterion_id,ux_evaluations_application_id",
            await EvaluationSql.ScalarAsync(connection, """
                SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
                 WHERE tablename IN ('evaluations','evaluation_scores','evaluation_corrections') AND indexname NOT LIKE 'pk_%'
                """));
    }

    [Fact]
    public async Task Each_table_is_audited_and_refuses_delete_and_truncate()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        await EvaluationSql.ExecuteAsync(connection, $"""
            INSERT INTO evaluation_scores (id, evaluation_id, criterion_id) VALUES (gen_random_uuid(), '{evaluation}', '{await EvaluationSql.CriterionAsync(connection)}');
            INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at) VALUES (gen_random_uuid(), '{evaluation}', '{employee}', now());
            """);

        Assert.Equal(
            "evaluation_corrections:audit_row_change,no_delete,no_truncate;evaluation_scores:audit_row_change,no_delete,no_truncate;evaluations:audit_row_change,no_delete,no_truncate",
            await EvaluationSql.ScalarAsync(connection, """
                SELECT string_agg(relname || ':' || triggers, ';' ORDER BY relname)
                  FROM (SELECT c.relname, string_agg(t.tgname, ',' ORDER BY t.tgname) AS triggers
                          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         WHERE NOT t.tgisinternal AND c.relname IN ('evaluations','evaluation_scores','evaluation_corrections')
                         GROUP BY c.relname) s
                """));
        // Every write is recorded in the internal audit log (here: one INSERT per table).
        Assert.Equal(3L, await EvaluationSql.ScalarAsync(connection,
            $"SELECT count(*) FROM audit_logs WHERE operation = 'INSERT' AND table_name IN ('evaluations','evaluation_scores','evaluation_corrections') AND (entity_id = '{evaluation}' OR new_values ->> 'evaluation_id' = '{evaluation}')"));

        foreach (var table in Tables)
        {
            var delete = await EvaluationSql.RefusedAsync(connection, $"DELETE FROM {table}");
            Assert.Equal(PostgresErrorCodes.RestrictViolation, delete.SqlState);
            var truncate = await EvaluationSql.RefusedAsync(connection, $"TRUNCATE {table} CASCADE");
            Assert.Equal(PostgresErrorCodes.RestrictViolation, truncate.SqlState);
        }

        Assert.Equal(1L, await EvaluationSql.ScalarAsync(connection, $"SELECT count(*) FROM evaluations WHERE id = '{evaluation}'"));
    }

    [Fact]
    public async Task A_draft_may_be_incomplete_and_starts_at_version_zero()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);

        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);

        Assert.Equal(
            "Draft 0 t",
            await EvaluationSql.ScalarAsync(connection, $"""
                SELECT format('%s %s %s', status, version,
                              comment IS NULL AND hiring_recommendation IS NULL AND submitted_by_id IS NULL AND submitted_at IS NULL)
                  FROM evaluations WHERE id = '{evaluation}'
                """));
    }

    [Fact]
    public async Task One_evaluation_per_training_application()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        await EvaluationSql.EvaluationAsync(connection, application, assignment);

        var second = await Assert.ThrowsAsync<PostgresException>(() => EvaluationSql.EvaluationAsync(connection, application, assignment));

        Assert.Equal((PostgresErrorCodes.UniqueViolation, "ux_evaluations_application_id"), (second.SqlState, second.ConstraintName));
    }

    [Theory]
    [InlineData(", status", ", 'Pending'", "ck_evaluations_status")]
    [InlineData(", hiring_recommendation", ", 'Perhaps'", "ck_evaluations_hiring_recommendation")]
    [InlineData(", version", ", -1", "ck_evaluations_version")]
    // A draft has no submitter or submission time; a submitted evaluation has both.
    [InlineData(", submitted_at", ", now()", "ck_evaluations_submission")]
    public async Task Evaluation_values_outside_the_rules_are_refused(string column, string value, string constraint)
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);

        var error = await Assert.ThrowsAsync<PostgresException>(() => column == ", status"
            ? EvaluationSql.ExecuteAsync(connection, $"INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at) VALUES (gen_random_uuid(), '{application}', '{assignment}', 'Pending', now(), now())")
            : EvaluationSql.EvaluationAsync(connection, application, assignment, column, value));

        Assert.Equal((PostgresErrorCodes.CheckViolation, constraint), (error.SqlState, error.ConstraintName));
    }

    [Theory]
    // Submitted needs the submitter and the time, a non-blank comment and a hiring recommendation (AD-66).
    [InlineData("NULL", "now()", "'Good work'", "'Yes'", "ck_evaluations_submission")]
    [InlineData("@employee", "NULL", "'Good work'", "'Yes'", "ck_evaluations_submission")]
    [InlineData("@employee", "now()", "NULL", "'Yes'", "ck_evaluations_submitted_content")]
    [InlineData("@employee", "now()", "'   '", "'Yes'", "ck_evaluations_submitted_content")]
    [InlineData("@employee", "now()", "'Good work'", "NULL", "ck_evaluations_submitted_content")]
    [InlineData("@employee", "now()", "'Good work'", "'Maybe'", null)]
    public async Task A_submitted_evaluation_has_its_submitter_time_comment_and_recommendation(
        string submittedBy, string submittedAt, string comment, string recommendation, string? constraint)
    {
        await using var connection = await OpenAsync();
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);
        var by = submittedBy == "@employee" ? $"'{employee}'" : submittedBy;
        var sql = $"""
            INSERT INTO evaluations (id, application_id, assignment_id, status, comment, hiring_recommendation, created_at, updated_at, submitted_by_id, submitted_at)
              VALUES (gen_random_uuid(), '{application}', '{assignment}', 'Submitted', {comment}, {recommendation}, now(), now(), {by}, {submittedAt})
            """;

        if (constraint is null)
        {
            await EvaluationSql.ExecuteAsync(connection, sql);
            Assert.Equal("Submitted", await EvaluationSql.ScalarAsync(connection, $"SELECT status FROM evaluations WHERE application_id = '{application}'"));
        }
        else
        {
            var error = await EvaluationSql.RefusedAsync(connection, sql);
            Assert.Equal((PostgresErrorCodes.CheckViolation, constraint), (error.SqlState, error.ConstraintName));
        }
    }

    [Fact]
    public async Task The_comment_holds_at_most_4000_characters()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        // Characters, not bytes: Arabic letters take two bytes each in UTF-8.
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment, ", comment", ", repeat('ع', 4000)");

        var error = await EvaluationSql.RefusedAsync(connection, $"UPDATE evaluations SET comment = repeat('ع', 4001) WHERE id = '{evaluation}'");

        Assert.Equal(PostgresErrorCodes.StringDataRightTruncation, error.SqlState);
        Assert.Equal(4000, await EvaluationSql.ScalarAsync(connection, $"SELECT length(comment) FROM evaluations WHERE id = '{evaluation}'"));
    }

    [Fact]
    public async Task Scores_are_whole_numbers_1_to_5_or_empty_one_per_criterion()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        string Insert(Guid criterion, string score) =>
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{criterion}', {score})";

        foreach (var score in new[] { "NULL", "1", "5" })
        {
            await EvaluationSql.ExecuteAsync(connection, Insert(await EvaluationSql.CriterionAsync(connection), score));
        }

        foreach (var score in new[] { "0", "6", "-1" })
        {
            var error = await EvaluationSql.RefusedAsync(connection, Insert(await EvaluationSql.CriterionAsync(connection), score));
            Assert.Equal((PostgresErrorCodes.CheckViolation, "ck_evaluation_scores_score"), (error.SqlState, error.ConstraintName));
        }

        var fractional = await EvaluationSql.RefusedAsync(connection, Insert(await EvaluationSql.CriterionAsync(connection), "'2.5'"));
        Assert.Equal(PostgresErrorCodes.InvalidTextRepresentation, fractional.SqlState);

        var criterion = await EvaluationSql.CriterionAsync(connection);
        await EvaluationSql.ExecuteAsync(connection, Insert(criterion, "3"));
        var duplicate = await EvaluationSql.RefusedAsync(connection, Insert(criterion, "4"));
        Assert.Equal((PostgresErrorCodes.UniqueViolation, "ux_evaluation_scores_evaluation_id_criterion_id"), (duplicate.SqlState, duplicate.ConstraintName));
    }

    [Theory]
    // The snapshot taken at submission: all three values or none, and only with a score.
    [InlineData("3", "'معيار'", "'Criterion'", "1", null)]
    [InlineData("NULL", "NULL", "NULL", "NULL", null)]
    [InlineData("3", "'معيار'", "NULL", "1", "ck_evaluation_scores_snapshot")]
    [InlineData("3", "NULL", "'Criterion'", "1", "ck_evaluation_scores_snapshot")]
    [InlineData("3", "'معيار'", "'Criterion'", "NULL", "ck_evaluation_scores_snapshot")]
    [InlineData("3", "NULL", "NULL", "1", "ck_evaluation_scores_snapshot")]
    [InlineData("NULL", "'معيار'", "'Criterion'", "1", "ck_evaluation_scores_frozen_scored")]
    public async Task A_frozen_snapshot_is_complete_and_scored(string score, string nameAr, string nameEn, string order, string? constraint)
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        var sql = $"""
            INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score, frozen_name_ar, frozen_name_en, frozen_sort_order)
              VALUES (gen_random_uuid(), '{evaluation}', '{await EvaluationSql.CriterionAsync(connection)}', {score}, {nameAr}, {nameEn}, {order})
            """;

        if (constraint is null)
        {
            await EvaluationSql.ExecuteAsync(connection, sql);
        }
        else
        {
            var error = await EvaluationSql.RefusedAsync(connection, sql);
            Assert.Equal((PostgresErrorCodes.CheckViolation, constraint), (error.SqlState, error.ConstraintName));
        }
    }

    [Fact]
    public async Task A_correction_reason_is_optional_and_holds_at_most_2000_characters()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        string Insert(string reason) =>
            $"INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at, reason) VALUES (gen_random_uuid(), '{evaluation}', '{employee}', now(), {reason})";

        await EvaluationSql.ExecuteAsync(connection, Insert("NULL"));
        await EvaluationSql.ExecuteAsync(connection, Insert("repeat('ع', 2000)"));
        var error = await EvaluationSql.RefusedAsync(connection, Insert("repeat('ع', 2001)"));

        Assert.Equal(PostgresErrorCodes.StringDataRightTruncation, error.SqlState);
        Assert.Equal(2L, await EvaluationSql.ScalarAsync(connection, $"SELECT count(*) FROM evaluation_corrections WHERE evaluation_id = '{evaluation}'"));
    }

    [Fact]
    public async Task References_must_exist()
    {
        await using var connection = await OpenAsync();
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);

        var error = await Assert.ThrowsAsync<PostgresException>(() => EvaluationSql.EvaluationAsync(connection, Guid.CreateVersion7(), assignment));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_evaluations_training_applications_application_id"), (error.SqlState, error.ConstraintName));
        var unknownCriterion = await EvaluationSql.RefusedAsync(connection, $"""
            INSERT INTO evaluation_scores (id, evaluation_id, criterion_id) VALUES (gen_random_uuid(), '{await EvaluationSql.EvaluationAsync(connection, application, assignment)}', gen_random_uuid())
            """);
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_evaluation_scores_evaluation_criteria_criterion_id"), (unknownCriterion.SqlState, unknownCriterion.ConstraintName));
    }
}

/// <summary>A database at EvaluationCriteriaAutomaticOrder: the production schema before S2.1.</summary>
public sealed class AutomaticOrderBaselineFactory : ImsApiFactory
{
    protected override string? InitialMigration => "20261118202455_EvaluationCriteriaAutomaticOrder";
}

/// <summary>The migration only adds the three tables: existing tables, data and audit history are unchanged.</summary>
public sealed class FinalEvaluationsMigrationTests(AutomaticOrderBaselineFactory factory) : IClassFixture<AutomaticOrderBaselineFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Migration_adds_the_evaluation_tables_and_changes_nothing_else()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        await EvaluationSql.TrainingAsync(connection);
        await EvaluationSql.CriterionAsync(connection);
        // Every existing column and constraint, and every row of every table (audit_logs included), as one fingerprint.
        const string Schema = """
            SELECT md5(string_agg(format('%s.%s %s %s %s', table_name, column_name, data_type, is_nullable, column_default), ',' ORDER BY table_name, ordinal_position))
              FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT IN ('evaluations','evaluation_scores','evaluation_corrections','__EFMigrationsHistory')
            """;
        const string Constraints = """
            SELECT md5(string_agg(conname || pg_get_constraintdef(oid), ',' ORDER BY conname)) FROM pg_constraint
             WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT IN ('evaluations','evaluation_scores','evaluation_corrections')
            """;
        const string Data = """
            SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
              SELECT 'audit_logs' || md5(string_agg(a::text, ',' ORDER BY id)) AS t FROM audit_logs a
              UNION ALL SELECT 'assignments' || md5(string_agg(x::text, ',' ORDER BY id)) FROM assignments x
              UNION ALL SELECT 'training_applications' || md5(string_agg(x::text, ',' ORDER BY id)) FROM training_applications x
              UNION ALL SELECT 'evaluation_criteria' || md5(string_agg(x::text, ',' ORDER BY id)) FROM evaluation_criteria x
              UNION ALL SELECT 'employees' || md5(string_agg(x::text, ',' ORDER BY id)) FROM employees x) s
            """;
        var before = (await EvaluationSql.ScalarAsync(connection, Schema), await EvaluationSql.ScalarAsync(connection, Constraints), await EvaluationSql.ScalarAsync(connection, Data));
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, "SELECT count(*) FROM pg_class WHERE relname = 'evaluations'"));

        await factory.WithDbAsync(async db =>
        {
            await db.Database.MigrateAsync(db.Database.GetMigrations().Single(m => m.EndsWith("FinalEvaluations", StringComparison.Ordinal)), _ct);
            return 0;
        });

        Assert.Equal(before, (await EvaluationSql.ScalarAsync(connection, Schema), await EvaluationSql.ScalarAsync(connection, Constraints), await EvaluationSql.ScalarAsync(connection, Data)));
        Assert.Equal(3L, await EvaluationSql.ScalarAsync(connection, "SELECT count(*) FROM pg_class WHERE relname IN ('evaluations','evaluation_scores','evaluation_corrections') AND relkind = 'r'"));
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, "SELECT (SELECT count(*) FROM evaluations) + (SELECT count(*) FROM evaluation_scores) + (SELECT count(*) FROM evaluation_corrections)"));
    }
}
