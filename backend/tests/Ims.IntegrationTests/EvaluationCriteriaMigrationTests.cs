using Ims.IntegrationTests.Infrastructure;
using Ims.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>A database at the last migration before AD-66's criteria model, with the production criteria as they were.</summary>
public sealed class PendingRemindersBaselineFactory : ImsApiFactory
{
    protected override string? InitialMigration => "20261115103328_PendingReminders";
}

/// <summary>
/// Migration EvaluationCriteriaBilingual (AD-66, owner decision G1 of 2026-11-18): every criterion, legacy value and audit
/// entry is kept; the Arabic name is the legacy name; the three production criteria get the owner's English names.
/// </summary>
public sealed class EvaluationCriteriaMigrationTests(PendingRemindersBaselineFactory factory) : IClassFixture<PendingRemindersBaselineFactory>
{
    private const string Target = "20261118181152_EvaluationCriteriaBilingual";

    // The production criteria (read-only check, 2026-11-18: exactly these three, weight 1, order 1) and their G1 names.
    private static readonly (Guid Id, string Arabic, string English)[] Production =
    [
        (Guid.Parse("01900000-0000-7000-8000-000000000001"), "التزام بالمواعيد", "Punctuality"),
        (Guid.Parse("01900000-0000-7000-8000-000000000002"), "التزام بالوقت (تنفيذ المهام)", "Timely Task Completion"),
        (Guid.Parse("01900000-0000-7000-8000-000000000003"), "حضور وغياب", "Attendance and Absence"),
    ];

    private static readonly Guid Unmatched = Guid.Parse("01900000-0000-7000-8000-000000000004");

    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Migration_keeps_every_criterion_and_audit_entry_and_adds_the_approved_english_names()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        foreach (var (id, arabic, _) in Production)
        {
            await ExecuteAsync(connection, "INSERT INTO evaluation_criteria (id, name, weight, sort_order) VALUES (@id, @name, 1.0000, 1)", ("id", id), ("name", arabic));
        }

        // A criterion that is not one of the production three (local databases only): its legacy name is used for both.
        await ExecuteAsync(connection, "INSERT INTO evaluation_criteria (id, name, weight, sort_order) VALUES (@id, 'Local criterion', 2.5, 4)", ("id", Unmatched));
        // Unrelated records that the migration must not touch.
        await ExecuteAsync(connection, "INSERT INTO fields (id, name, description, is_active) VALUES (@id, 'Backend', 'APIs', true)", ("id", Guid.CreateVersion7()));
        await ExecuteAsync(connection, "INSERT INTO employees (id, full_name, email, role) VALUES (@id, 'Seed Employee', 'seed@company.example', 'Employee')", ("id", Guid.CreateVersion7()));

        var legacyBefore = await LegacyCriteriaAsync(connection);
        var otherTablesBefore = await OtherTablesAsync(connection);
        var (auditCount, auditMaxId, auditDigest) = await AuditAsync(connection, long.MaxValue);

        await factory.WithDbAsync(async db =>
        {
            await db.Database.MigrateAsync(Target, _ct);
            return 0;
        });

        // Ids, legacy names, weights and orders are unchanged; nothing is added or lost.
        Assert.Equal(legacyBefore, await LegacyCriteriaAsync(connection));
        var criteria = await QueryAsync(connection, "SELECT id, name_ar, name_en, is_active FROM evaluation_criteria ORDER BY id", r => (r.GetGuid(0), r.GetString(1), r.GetString(2), r.GetBoolean(3)));
        Assert.Equal(
            [.. Production.Select(p => (p.Id, p.Arabic, p.English, true)), (Unmatched, "Local criterion", "Local criterion", true)],
            criteria);

        // Earlier audit entries are untouched; the backfill adds exactly one UPDATE per criterion, with the new columns only.
        Assert.Equal((auditCount, auditMaxId, auditDigest), await AuditAsync(connection, auditMaxId));
        var added = await QueryAsync(
            connection,
            "SELECT table_name, operation, entity_id, (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(new_values) k) FROM audit_logs WHERE id > @after ORDER BY entity_id",
            r => (r.GetString(0), r.GetString(1), r.GetString(2), string.Join(",", r.GetFieldValue<string[]>(3))),
            ("after", auditMaxId));
        Assert.Equal(
            [.. Production.Select(p => p.Id).Append(Unmatched).Select(id => ("evaluation_criteria", "UPDATE", id.ToString(), "is_active,name_ar,name_en"))],
            added);

        Assert.Equal(otherTablesBefore, await OtherTablesAsync(connection));
    }

    private async Task<List<(Guid, string?, decimal?, int)>> LegacyCriteriaAsync(NpgsqlConnection connection) =>
        await QueryAsync(
            connection,
            "SELECT id, name, weight, sort_order FROM evaluation_criteria ORDER BY id",
            r => (r.GetGuid(0), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : (decimal?)r.GetDecimal(2), r.GetInt32(3)));

    /// <summary>Row count, highest id and a digest of every audit entry up to <paramref name="upTo"/>.</summary>
    private async Task<(long, long, string)> AuditAsync(NpgsqlConnection connection, long upTo) =>
        (await QueryAsync(
            connection,
            "SELECT count(*), coalesce(max(id), 0), md5(coalesce(string_agg(a::text, '|' ORDER BY id), '')) FROM audit_logs a WHERE id <= @upTo",
            r => (r.GetInt64(0), r.GetInt64(1), r.GetString(2)),
            ("upTo", upTo)))[0];

    /// <summary>A digest of every other table's rows (all but the criteria, the audit log and the migration history).</summary>
    private async Task<List<(string, long, string)>> OtherTablesAsync(NpgsqlConnection connection)
    {
        var tables = await QueryAsync(
            connection,
            "SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('evaluation_criteria', 'audit_logs', '__EFMigrationsHistory') ORDER BY tablename",
            r => r.GetString(0));
        var digests = new List<(string, long, string)>();
        foreach (var table in tables)
        {
            digests.Add((await QueryAsync(
                connection,
                $"SELECT '{table}', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM \"{table}\" t",
                r => (r.GetString(0), r.GetInt64(1), r.GetString(2))))[0]);
        }

        return digests;
    }

    private async Task ExecuteAsync(NpgsqlConnection connection, string sql, params (string Name, object Value)[] parameters)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        await command.ExecuteNonQueryAsync(_ct);
    }

    private async Task<List<T>> QueryAsync<T>(NpgsqlConnection connection, string sql, Func<NpgsqlDataReader, T> read, params (string Name, object Value)[] parameters)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        await using var reader = await command.ExecuteReaderAsync(_ct);
        var rows = new List<T>();
        while (await reader.ReadAsync(_ct)) rows.Add(read(reader));
        return rows;
    }
}

/// <summary>After EvaluationCriteriaBilingual the database still enforces the criteria rules (own database: see the class above).</summary>
public sealed class EvaluationCriteriaMigrationConstraintTests(PendingRemindersBaselineFactory factory) : IClassFixture<PendingRemindersBaselineFactory>
{
    private const string Target = "20261118181152_EvaluationCriteriaBilingual";

    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("INSERT INTO evaluation_criteria (id, name_en, sort_order, is_active) VALUES (gen_random_uuid(), 'X', 1, true)", PostgresErrorCodes.NotNullViolation)]
    [InlineData("INSERT INTO evaluation_criteria (id, name_ar, sort_order, is_active) VALUES (gen_random_uuid(), 'س', 1, true)", PostgresErrorCodes.NotNullViolation)]
    [InlineData("INSERT INTO evaluation_criteria (id, name_ar, name_en, weight, sort_order, is_active) VALUES (gen_random_uuid(), 'س', 'X', 0, 1, true)", PostgresErrorCodes.CheckViolation)]
    [InlineData("INSERT INTO evaluation_criteria (id, name_ar, name_en, sort_order, is_active) VALUES (gen_random_uuid(), repeat('س', 201), 'X', 1, true)", PostgresErrorCodes.StringDataRightTruncation)]
    [InlineData("DELETE FROM evaluation_criteria", PostgresErrorCodes.RestrictViolation)]
    public async Task After_the_migration_the_database_still_enforces_the_criteria_rules(string sql, string sqlState)
    {
        await MigrateWithOneCriterionAsync();
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        await using var transaction = await connection.BeginTransactionAsync(_ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() => new NpgsqlCommand(sql, connection, transaction).ExecuteNonQueryAsync(_ct));

        Assert.Equal(sqlState, error.SqlState);
    }

    [Fact]
    public async Task After_the_migration_a_criterion_needs_no_legacy_name_or_weight()
    {
        await MigrateWithOneCriterionAsync();
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        await using var transaction = await connection.BeginTransactionAsync(_ct);

        var inserted = await new NpgsqlCommand(
            "INSERT INTO evaluation_criteria (id, name_ar, name_en, sort_order, is_active) VALUES (gen_random_uuid(), 'الانضباط', 'Discipline', 2, true)",
            connection,
            transaction).ExecuteNonQueryAsync(_ct);

        Assert.Equal(1, inserted);
        await transaction.RollbackAsync(_ct);
    }

    /// <summary>The constraint tests share the class's database: migrate it once, with a row for the DELETE trigger to see.</summary>
    private async Task MigrateWithOneCriterionAsync()
    {
        await factory.WithDbAsync(async db =>
        {
            if ((await db.Database.GetAppliedMigrationsAsync(_ct)).Contains(Target)) return 0;
            await db.Database.ExecuteSqlRawAsync("INSERT INTO evaluation_criteria (id, name, weight, sort_order) VALUES (gen_random_uuid(), 'معيار', 1, 1)", _ct);
            await db.Database.MigrateAsync(Target, _ct);
            return 0;
        });
    }
}
