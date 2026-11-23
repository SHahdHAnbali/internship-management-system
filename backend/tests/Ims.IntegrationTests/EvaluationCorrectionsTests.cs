using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>
/// Migration EvaluationCorrections (S2.4, owner decisions of 2026-11-23, AD-72; M1 with D3+, H1 and H2): a submitted
/// evaluation changes only together with a correction record of the same transaction and Staff actor, one per evaluation
/// and transaction, with a net change of a frozen score, the comment or the recommendation (checked at commit). The
/// permanent guards stay. These tests run as the owner (the guards hold for every role); the Worker's role is tested in
/// the Worker, where the full scenario list of the proof of concept runs as `ims_app`.
/// </summary>
public sealed class EvaluationCorrectionsTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        return connection;
    }

    /// <summary>A submitted evaluation (S2.3's order) with one frozen score of 3; returns its ids and the mentor.</summary>
    private static async Task<(Guid Evaluation, Guid Employee, Guid Criterion)> SubmittedAsync(NpgsqlConnection connection)
    {
        var (application, assignment, employee) = await EvaluationSql.TrainingAsync(connection);
        var evaluation = await EvaluationSql.EvaluationAsync(connection, application, assignment);
        var criterion = await EvaluationSql.CriterionAsync(connection);
        await EvaluationSql.ExecuteAsync(connection, $"""
            INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{criterion}', 3);
            UPDATE evaluation_scores SET frozen_name_ar = 'معيار', frozen_name_en = 'Criterion', frozen_sort_order = 1 WHERE evaluation_id = '{evaluation}';
            UPDATE evaluations SET status = 'Submitted', comment = 'Final comment', hiring_recommendation = 'Yes',
                   submitted_by_id = '{employee}', submitted_at = now() WHERE id = '{evaluation}';
            """);
        return (evaluation, employee, criterion);
    }

    private static string AsStaff(Guid employee) =>
        $"SELECT set_config('ims.actor_type', 'Staff', true), set_config('ims.actor_id', '{employee}', true);";

    private static string Record(Guid evaluation, Guid employee) =>
        $"INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at) VALUES (gen_random_uuid(), '{evaluation}', '{employee}', now());";

    /// <summary>Runs `sql` in one transaction and returns the refusal (SQLSTATE and guard); the connection is reusable.</summary>
    private static async Task<(string State, string? Guard)> RefusedTransactionAsync(NpgsqlConnection connection, string sql)
    {
        try
        {
            await EvaluationSql.ExecuteAsync(connection, $"BEGIN; {sql} COMMIT;");
        }
        catch (PostgresException error)
        {
            await EvaluationSql.ExecuteAsync(connection, "ROLLBACK;");
            return (error.SqlState, error.ConstraintName);
        }

        throw new InvalidOperationException("Expected the transaction to be refused.");
    }

    [Fact]
    public async Task A_correction_with_its_record_changes_the_comment_and_a_frozen_score_in_one_audited_transaction()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, criterion) = await SubmittedAsync(connection);

        await EvaluationSql.ExecuteAsync(connection, $"""
            BEGIN; {AsStaff(employee)} {Record(evaluation, employee)}
            UPDATE evaluation_scores SET score = 5 WHERE evaluation_id = '{evaluation}' AND criterion_id = '{criterion}';
            UPDATE evaluations SET comment = 'Corrected', version = version + 1, updated_at = now() WHERE id = '{evaluation}';
            COMMIT;
            """);

        Assert.Equal("Submitted|Corrected|5|1", await EvaluationSql.ScalarAsync(connection, $"""
            SELECT e.status || '|' || e.comment || '|' || s.score || '|' || e.version
              FROM evaluations e JOIN evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = '{evaluation}'
            """));
        // The record's audit INSERT and the before/after values share one transaction id and the corrector as actor.
        Assert.Equal("evaluation_corrections:INSERT,evaluation_scores:UPDATE,evaluations:UPDATE|1|1", await EvaluationSql.ScalarAsync(connection, $"""
            WITH t AS (SELECT a.transaction_id FROM audit_logs a JOIN evaluation_corrections c
                         ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
                        WHERE c.evaluation_id = '{evaluation}')
            SELECT string_agg(DISTINCT a.table_name || ':' || a.operation, ',') || '|' || count(DISTINCT a.actor_id) || '|'
                   || count(*) FILTER (WHERE a.old_values ->> 'score' = '3' AND a.new_values ->> 'score' = '5')
              FROM audit_logs a, t WHERE a.transaction_id = t.transaction_id
            """));
    }

    [Fact]
    public async Task Without_a_record_of_its_own_transaction_a_submitted_evaluation_stays_read_only()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, criterion) = await SubmittedAsync(connection);
        var (other, _, _) = await SubmittedAsync(connection);

        Assert.Equal(("23001", "evaluations_submitted_readonly"), await RefusedTransactionAsync(connection,
            $"{AsStaff(employee)} UPDATE evaluations SET comment = 'No record' WHERE id = '{evaluation}';"));
        Assert.Equal(("23001", "evaluation_scores_submitted_readonly"), await RefusedTransactionAsync(connection,
            $"{AsStaff(employee)} UPDATE evaluation_scores SET score = 1 WHERE criterion_id = '{criterion}';"));
        Assert.Equal(("23001", "evaluations_submitted_readonly"), await RefusedTransactionAsync(connection,
            $"{AsStaff(employee)} {Record(other, employee)} UPDATE evaluations SET comment = 'Other record' WHERE id = '{evaluation}';"));
    }

    [Fact]
    public async Task A_record_needs_a_submitted_evaluation_the_actor_as_corrector_one_per_transaction_and_a_net_change()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, criterion) = await SubmittedAsync(connection);
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        var draft = await EvaluationSql.EvaluationAsync(connection, application, assignment);

        Assert.Equal(("23001", "evaluation_corrections_submitted_only"),
            await RefusedTransactionAsync(connection, $"{AsStaff(employee)} {Record(draft, employee)}"));
        Assert.Equal(("23001", "evaluation_corrections_actor"),
            await RefusedTransactionAsync(connection, $"{AsStaff(Guid.CreateVersion7())} {Record(evaluation, employee)}"));
        Assert.Equal(("23001", "evaluation_corrections_one_per_transaction"),
            await RefusedTransactionAsync(connection, $"{AsStaff(employee)} {Record(evaluation, employee)} {Record(evaluation, employee)}"));
        Assert.Equal(("23001", "evaluation_corrections_net_change"),
            await RefusedTransactionAsync(connection, $"{AsStaff(employee)} {Record(evaluation, employee)}"));
        Assert.Equal(("23001", "evaluation_corrections_net_change"), await RefusedTransactionAsync(connection, $"""
            {AsStaff(employee)} {Record(evaluation, employee)}
            UPDATE evaluation_scores SET score = 4 WHERE criterion_id = '{criterion}';
            UPDATE evaluation_scores SET score = 3 WHERE criterion_id = '{criterion}';
            UPDATE evaluations SET version = version + 1, updated_at = now() WHERE id = '{evaluation}';
            """));
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection,
            $"SELECT count(*) FROM evaluation_corrections WHERE evaluation_id = '{evaluation}'"));
    }

    [Fact]
    public async Task The_permanent_guards_hold_even_with_a_correction_record()
    {
        await using var connection = await OpenAsync();
        var (evaluation, employee, criterion) = await SubmittedAsync(connection);
        var prefix = $"{AsStaff(employee)} {Record(evaluation, employee)}";

        Assert.Equal(("23001", "evaluation_scores_snapshot_immutable"), await RefusedTransactionAsync(connection,
            $"{prefix} UPDATE evaluation_scores SET frozen_name_en = 'Renamed' WHERE criterion_id = '{criterion}';"));
        Assert.Equal(("23001", "evaluations_submission_immutable"), await RefusedTransactionAsync(connection,
            $"{prefix} UPDATE evaluations SET submitted_at = submitted_at - interval '1 day' WHERE id = '{evaluation}';"));
        Assert.Equal(("23001", "evaluations_submission_immutable"), await RefusedTransactionAsync(connection,
            $"{prefix} UPDATE evaluations SET status = 'Draft', submitted_by_id = NULL, submitted_at = NULL WHERE id = '{evaluation}';"));
        Assert.Equal(("23001", "evaluation_scores_submitted_readonly"), await RefusedTransactionAsync(connection,
            $"{prefix} INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '{evaluation}', '{await EvaluationSql.CriterionAsync(connection)}', 2);"));
    }
}

/// <summary>A database at EvaluationWriteGuards: S2.2's guards, before the corrections migration.</summary>
public sealed class EvaluationWriteGuardsBaselineFactory : ImsApiFactory
{
    protected override string? InitialMigration => "20261122164739_EvaluationWriteGuards";
}

/// <summary>The corrections migration changes functions and triggers only, and its Down restores S2.2 exactly.</summary>
public sealed class EvaluationCorrectionsMigrationTests(EvaluationWriteGuardsBaselineFactory factory)
    : IClassFixture<EvaluationWriteGuardsBaselineFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private const string Data = """
        SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
          SELECT format('%s.%s %s %s %s', table_name, column_name, data_type, is_nullable, column_default) AS x
            FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '__EFMigrationsHistory'
          UNION ALL SELECT conname || pg_get_constraintdef(oid) FROM pg_constraint
                     WHERE connamespace = 'public'::regnamespace AND contype <> 't' -- a constraint trigger is counted below
          UNION ALL SELECT indexname || indexdef FROM pg_indexes WHERE schemaname = 'public'
          UNION ALL SELECT 'evaluations' || md5(coalesce(string_agg(e::text, ',' ORDER BY id), '')) FROM evaluations e
          UNION ALL SELECT 'scores' || md5(coalesce(string_agg(s::text, ',' ORDER BY id), '')) FROM evaluation_scores s) f
        """;

    private const string Guards = """
        SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.proname))
          FROM pg_proc p WHERE p.proname IN ('ims_evaluations_guard', 'ims_evaluation_scores_guard')
        """;

    private const string CorrectionObjects = """
        SELECT (SELECT count(*) FROM pg_trigger WHERE tgname IN ('evaluation_corrections_guard', 'evaluation_corrections_net_change'))
             + (SELECT count(*) FROM pg_proc WHERE proname IN ('ims_evaluation_correction_in_transaction',
                  'ims_evaluation_corrections_guard', 'ims_evaluation_corrections_net_change'))
        """;

    [Fact]
    public async Task Migration_adds_only_functions_and_triggers_and_its_down_restores_the_s22_guards_exactly()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        var (application, assignment, _) = await EvaluationSql.TrainingAsync(connection);
        await EvaluationSql.EvaluationAsync(connection, application, assignment);
        var data = await EvaluationSql.ScalarAsync(connection, Data);
        var guards = await EvaluationSql.ScalarAsync(connection, Guards);
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, CorrectionObjects));

        await MigrateToAsync("EvaluationCorrections");
        Assert.Equal(5L, await EvaluationSql.ScalarAsync(connection, CorrectionObjects));
        Assert.NotEqual(guards, await EvaluationSql.ScalarAsync(connection, Guards));
        Assert.Equal(data, await EvaluationSql.ScalarAsync(connection, Data)); // no column, constraint, index or row changed

        await MigrateToAsync("EvaluationWriteGuards");
        Assert.Equal(0L, await EvaluationSql.ScalarAsync(connection, CorrectionObjects));
        Assert.Equal(guards, await EvaluationSql.ScalarAsync(connection, Guards)); // S2.2's functions, word for word
        Assert.Equal(data, await EvaluationSql.ScalarAsync(connection, Data));
    }

    private Task<int> MigrateToAsync(string name) => factory.WithDbAsync(async db =>
    {
        await db.Database.MigrateAsync(db.Database.GetMigrations().Single(m => m.EndsWith(name, StringComparison.Ordinal)), _ct);
        return 0;
    });
}
