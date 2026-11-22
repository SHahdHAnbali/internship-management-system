using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>
/// Migration EvaluationWriteGuards (S2.2, owner decision K1 option B, 2026-11-22): database triggers that hold for every
/// role, the schema owner included. Permanently: an evaluation keeps its identity, a submitted evaluation keeps its status,
/// submitter and submission time, a saved score is never cleared, a frozen snapshot never changes. In S2.2: a submitted
/// evaluation and its scores are read-only (corrections, S2.4, will need their own approved migration). The Draft →
/// Submitted transition stays possible for S2.3. These tests run as the owner; the Worker's role is tested in the Worker.
/// </summary>
public sealed class EvaluationWriteGuardsTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        return connection;
    }

    /// <summary>A training and a Draft evaluation with one scored criterion; returns the ids.</summary>
    private static async Task<(Guid Evaluation, Guid Employee, Guid Score, Guid Criterion)> DraftAsync(NpgsqlConnection connection)
    {
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        var criterion = await EvaluationSql.CriterionAsync(connection);
        var score = Guid.CreateVersion7();
        await EvaluationSql.ExecuteAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES ('{score}', '{evaluation}', '{criterion}', 3)");
        return (evaluation, employee, score, criterion);
    }

    /// <summary>S2.3's order: freeze the scores while the evaluation is a Draft, then submit it.</summary>
    private static Task SubmitAsync(NpgsqlConnection connection, Guid evaluation, Guid employee) =>
        EvaluationSql.ExecuteAsync(connection, $"""
            UPDATE evaluation_scores SET frozen_name_ar = 'معيار', frozen_name_en = 'Criterion', frozen_sort_order = 1 WHERE evaluation_id = '{evaluation}';
            UPDATE evaluations SET status = 'Submitted', comment = 'Final comment', hiring_recommendation = 'Yes',
                   submitted_by_id = '{employee}', submitted_at = now() WHERE id = '{evaluation}';
            """);

    private static async Task<PostgresException> GuardedAsync(NpgsqlConnection connection, string sql, string guard)
    {
        var error = await EvaluationSql.RefusedAsync(connection, sql);
        Assert.Equal((PostgresErrorCodes.RestrictViolation, guard), (error.SqlState, error.ConstraintName));
        return error;
    }

    [Fact]
    public async Task A_draft_may_be_edited_and_submitted_once()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, score, _) = await DraftAsync(connection);

        await EvaluationSql.ExecuteAsync(connection, $"""
            UPDATE evaluations SET comment = 'Draft text', hiring_recommendation = 'Maybe', version = version + 1, updated_at = now() WHERE id = '{evaluation}';
            UPDATE evaluations SET comment = NULL, hiring_recommendation = NULL WHERE id = '{evaluation}';
            UPDATE evaluation_scores SET score = 5 WHERE id = '{score}';
            """);
        await SubmitAsync(connection, evaluation, employee);

        Assert.Equal("Submitted 5", await EvaluationSql.ScalarAsync(connection,
            $"SELECT e.status || ' ' || s.score FROM evaluations e JOIN evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = '{evaluation}'"));
    }

    [Theory]
    [InlineData("comment = 'Changed'")]
    [InlineData("hiring_recommendation = 'No'")]
    [InlineData("version = version + 1")]
    [InlineData("updated_at = now()")]
    [InlineData("comment = comment")] // even a change to the same value
    [InlineData("comment = 'Changed', hiring_recommendation = 'No', version = version + 1, updated_at = now()")]
    public async Task A_submitted_evaluation_is_read_only(string change)
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, _, _) = await DraftAsync(connection);
        await SubmitAsync(connection, evaluation, employee);

        await GuardedAsync(connection, $"UPDATE evaluations SET {change} WHERE id = '{evaluation}'", "evaluations_submitted_readonly");

        Assert.Equal("Final comment|Yes|0", await EvaluationSql.ScalarAsync(connection,
            $"SELECT concat_ws('|', comment, hiring_recommendation, version) FROM evaluations WHERE id = '{evaluation}'"));
    }

    [Theory]
    [InlineData("status = 'Draft', submitted_by_id = NULL, submitted_at = NULL")]
    [InlineData("submitted_at = now() - interval '1 day'")]
    [InlineData("submitted_by_id = @other")]
    public async Task A_submitted_evaluation_keeps_its_status_submitter_and_time(string change)
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, _, _) = await DraftAsync(connection);
        await SubmitAsync(connection, evaluation, employee);
        var other = (await EvaluationSql.TrainingAsync(connection)).Employee;

        await GuardedAsync(connection,
            $"UPDATE evaluations SET {change.Replace("@other", $"'{other}'", StringComparison.Ordinal)} WHERE id = '{evaluation}'",
            "evaluations_submission_immutable");
    }

    [Theory]
    [InlineData("application_id = @application")]
    [InlineData("assignment_id = @assignment")]
    [InlineData("created_at = now() - interval '1 day'")]
    [InlineData("id = gen_random_uuid()")]
    public async Task An_evaluation_keeps_its_identity(string change)
    {
        await using var connection = await OpenAsync();
        var (evaluation, _, _, _) = await DraftAsync(connection);
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);

        await GuardedAsync(connection,
            $"UPDATE evaluations SET {change.Replace("@application", $"'{application}'", StringComparison.Ordinal).Replace("@assignment", $"'{assignment}'", StringComparison.Ordinal)} WHERE id = '{evaluation}'",
            "evaluations_identity_immutable");
    }

    [Fact]
    public async Task The_scores_of_a_submitted_evaluation_cannot_be_inserted_or_changed()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, score, criterion) = await DraftAsync(connection);
        await SubmitAsync(connection, evaluation, employee);
        var another = await EvaluationSql.CriterionAsync(connection);

        await GuardedAsync(connection, $"UPDATE evaluation_scores SET score = 4 WHERE id = '{score}'", "evaluation_scores_submitted_readonly");
        await GuardedAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{another}', 2)",
            "evaluation_scores_submitted_readonly");
        // Through INSERT … ON CONFLICT DO UPDATE as well (the INSERT trigger runs first).
        await GuardedAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{criterion}', 1) ON CONFLICT (evaluation_id, criterion_id) DO UPDATE SET score = EXCLUDED.score",
            "evaluation_scores_submitted_readonly");

        Assert.Equal("3:1", await EvaluationSql.ScalarAsync(connection,
            $"SELECT max(score) || ':' || count(*) FROM evaluation_scores WHERE evaluation_id = '{evaluation}'"));
    }

    [Fact]
    public async Task A_saved_score_can_change_but_never_be_cleared()
    {
        await using var connection = await OpenAsync();
        var (evaluation, _, score, criterion) = await DraftAsync(connection);

        await EvaluationSql.ExecuteAsync(connection, $"UPDATE evaluation_scores SET score = 1 WHERE id = '{score}'");
        await EvaluationSql.ExecuteAsync(connection, $"UPDATE evaluation_scores SET score = 5 WHERE id = '{score}'");
        await GuardedAsync(connection, $"UPDATE evaluation_scores SET score = NULL WHERE id = '{score}'", "evaluation_scores_not_cleared");
        await GuardedAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{criterion}', NULL) ON CONFLICT (evaluation_id, criterion_id) DO UPDATE SET score = EXCLUDED.score",
            "evaluation_scores_not_cleared");

        Assert.Equal((short)5, await EvaluationSql.ScalarAsync(connection, $"SELECT score FROM evaluation_scores WHERE id = '{score}'"));
    }

    [Fact]
    public async Task An_empty_score_row_stays_allowed_and_may_get_a_score()
    {
        // S2.1 semantics kept (owner, 2026-11-22): inserting an empty score is not refused by the database.
        await using var connection = await OpenAsync();
        var (evaluation, _, _, _) = await DraftAsync(connection);
        var criterion = await EvaluationSql.CriterionAsync(connection);
        var empty = Guid.CreateVersion7();

        await EvaluationSql.ExecuteAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES ('{empty}', '{evaluation}', '{criterion}', NULL)");
        await EvaluationSql.ExecuteAsync(connection, $"UPDATE evaluation_scores SET score = NULL WHERE id = '{empty}'"); // still empty
        await EvaluationSql.ExecuteAsync(connection, $"UPDATE evaluation_scores SET score = 4 WHERE id = '{empty}'");

        Assert.Equal((short)4, await EvaluationSql.ScalarAsync(connection, $"SELECT score FROM evaluation_scores WHERE id = '{empty}'"));
    }

    [Theory]
    [InlineData("evaluation_id = @evaluation")]
    [InlineData("criterion_id = @criterion")]
    [InlineData("id = gen_random_uuid()")]
    public async Task A_score_keeps_its_identity(string change)
    {
        await using var connection = await OpenAsync();
        var (_, _, score, _) = await DraftAsync(connection);
        var (otherEvaluation, _, _, otherCriterion) = await DraftAsync(connection);

        await GuardedAsync(connection,
            $"UPDATE evaluation_scores SET {change.Replace("@evaluation", $"'{otherEvaluation}'", StringComparison.Ordinal).Replace("@criterion", $"'{otherCriterion}'", StringComparison.Ordinal)} WHERE id = '{score}'",
            "evaluation_scores_identity_immutable");
    }

    [Fact]
    public async Task A_frozen_snapshot_never_changes()
    {
        await using var connection = await OpenAsync();
        var (_, _, score, _) = await DraftAsync(connection);
        await EvaluationSql.ExecuteAsync(connection,
            $"UPDATE evaluation_scores SET frozen_name_ar = 'معيار', frozen_name_en = 'Criterion', frozen_sort_order = 1 WHERE id = '{score}'");

        foreach (var change in new[] { "frozen_name_en = 'Renamed'", "frozen_name_ar = 'معدل'", "frozen_sort_order = 2" })
        {
            await GuardedAsync(connection, $"UPDATE evaluation_scores SET {change} WHERE id = '{score}'", "evaluation_scores_snapshot_immutable");
        }

        // A frozen score of a Draft (submission in progress) may still change its score, never its snapshot.
        await EvaluationSql.ExecuteAsync(connection, $"UPDATE evaluation_scores SET score = 2 WHERE id = '{score}'");
    }

    [Fact]
    public async Task The_database_owner_may_still_insert_a_submitted_evaluation_that_meets_the_constraints()
    {
        // S2.1 semantics kept (owner, 2026-11-22): no new restriction on direct inserts by the schema owner.
        await using var connection = await OpenAsync();
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);

        await EvaluationSql.ExecuteAsync(connection, $"""
            INSERT INTO evaluations (id, application_id, assignment_id, status, comment, hiring_recommendation, created_at, updated_at, submitted_by_id, submitted_at)
              VALUES (gen_random_uuid(), '{application}', '{assignment}', 'Submitted', 'Text', 'No', now(), now(), '{employee}', now())
            """);
    }

    [Fact]
    public async Task A_refused_write_rolls_back_the_whole_transaction_and_leaves_no_audit_row()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, score, _) = await DraftAsync(connection);
        await SubmitAsync(connection, evaluation, employee);
        var audit = await EvaluationSql.ScalarAsync(connection, "SELECT count(*) || ':' || max(id) FROM audit_logs");

        await using (var transaction = await connection.BeginTransactionAsync(_ct))
        {
            await EvaluationSql.ExecuteAsync(connection, "INSERT INTO fields (id, name, is_active) VALUES (gen_random_uuid(), 'Rolled back ' || gen_random_uuid(), true)");
            await GuardedAsync(connection, $"UPDATE evaluation_scores SET score = 1 WHERE id = '{score}'", "evaluation_scores_submitted_readonly");
            await transaction.RollbackAsync(_ct);
        }

        Assert.Equal(audit, await EvaluationSql.ScalarAsync(connection, "SELECT count(*) || ':' || max(id) FROM audit_logs"));
        Assert.Equal((short)3, await EvaluationSql.ScalarAsync(connection, $"SELECT score FROM evaluation_scores WHERE id = '{score}'"));
    }

    [Fact]
    public async Task A_score_write_waits_for_a_concurrent_submission_and_is_then_refused()
    {
        await using var submitter = await OpenAsync();
        await using var writer = await OpenAsync();
        var (evaluation, employee, score, _) = await DraftAsync(submitter);

        // Connection 1 submits (row locked, not committed yet).
        await using var submission = await submitter.BeginTransactionAsync(_ct);
        await EvaluationSql.ExecuteAsync(submitter, $"SELECT 1 FROM evaluations WHERE id = '{evaluation}' FOR UPDATE");
        await SubmitAsync(submitter, evaluation, employee);

        // Connection 2 changes a score: the guard's FOR SHARE on the parent waits for the submission.
        var write = EvaluationSql.ExecuteAsync(writer, $"UPDATE evaluation_scores SET score = 1 WHERE id = '{score}'");
        await Task.Delay(500, _ct);
        Assert.False(write.IsCompleted);
        Assert.Equal(1L, await EvaluationSql.ScalarAsync(submitter,
            "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()"));

        await submission.CommitAsync(_ct);
        var error = await Assert.ThrowsAsync<PostgresException>(() => write);

        Assert.Equal((PostgresErrorCodes.RestrictViolation, "evaluation_scores_submitted_readonly"), (error.SqlState, error.ConstraintName));
        Assert.Equal((short)3, await EvaluationSql.ScalarAsync(writer, $"SELECT score FROM evaluation_scores WHERE id = '{score}'"));
    }

    [Fact]
    public async Task The_guards_are_installed_as_before_row_triggers()
    {
        await using var connection = await OpenAsync();

        Assert.Equal(
            "evaluation_scores.evaluation_scores_guard:BEFORE INSERT OR UPDATE;evaluations.evaluations_guard:BEFORE UPDATE",
            await EvaluationSql.ScalarAsync(connection, """
                SELECT string_agg(format('%s.%s:%s', event_object_table, trigger_name, events), ';' ORDER BY event_object_table)
                  FROM (SELECT event_object_table, trigger_name, action_timing || ' ' || string_agg(event_manipulation, ' OR ' ORDER BY event_manipulation) AS events
                          FROM information_schema.triggers WHERE trigger_name IN ('evaluations_guard', 'evaluation_scores_guard') AND action_orientation = 'ROW'
                         GROUP BY event_object_table, trigger_name, action_timing) t
                """));
    }
}

/// <summary>A database at FinalEvaluations: S2.1's schema before the guards.</summary>
public sealed class FinalEvaluationsBaselineFactory : ImsApiFactory
{
    protected override string? InitialMigration => "20261122124131_FinalEvaluations";
}

/// <summary>The guards migration adds functions and triggers only, and its Down removes exactly them (disposable database).</summary>
public sealed class EvaluationWriteGuardsMigrationTests(FinalEvaluationsBaselineFactory factory) : IClassFixture<FinalEvaluationsBaselineFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private const string Fingerprint = """
        SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
          SELECT format('%s.%s %s %s %s', table_name, column_name, data_type, is_nullable, column_default) AS x
            FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '__EFMigrationsHistory'
          UNION ALL SELECT conname || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
          UNION ALL SELECT 'audit' || md5(string_agg(a::text, ',' ORDER BY id)) FROM audit_logs a
          UNION ALL SELECT 'evaluations' || md5(coalesce(string_agg(e::text, ',' ORDER BY id), '')) FROM evaluations e
          UNION ALL SELECT 'scores' || md5(coalesce(string_agg(s::text, ',' ORDER BY id), '')) FROM evaluation_scores s) f
        """;

    private const string Guards =
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('evaluations_guard', 'evaluation_scores_guard')";

    [Fact]
    public async Task Migration_adds_only_the_guards_and_its_down_removes_them()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        await EvaluationSql.ExecuteAsync(connection,
            $"INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{await EvaluationSql.CriterionAsync(connection)}', 2)");
        var before = await EvaluationSql.ScalarAsync(connection, Fingerprint);
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, Guards));

        await MigrateToAsync("EvaluationWriteGuards");
        Assert.Equal(2L, await EvaluationSql.ScalarAsync(connection, Guards));
        Assert.Equal(before, await EvaluationSql.ScalarAsync(connection, Fingerprint));

        await MigrateToAsync("FinalEvaluations");
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, Guards));
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection,
            "SELECT count(*) FROM pg_proc WHERE proname IN ('ims_evaluations_guard', 'ims_evaluation_scores_guard')"));
        Assert.Equal(before, await EvaluationSql.ScalarAsync(connection, Fingerprint));
    }

    private Task<int> MigrateToAsync(string name) => factory.WithDbAsync(async db =>
    {
        await db.Database.MigrateAsync(db.Database.GetMigrations().Single(m => m.EndsWith(name, StringComparison.Ordinal)), _ct);
        return 0;
    });
}
