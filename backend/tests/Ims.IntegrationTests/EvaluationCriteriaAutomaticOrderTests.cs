using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>A database at EvaluationCriteriaSortOrderPositive: criteria still carry Admin-entered (possibly equal) orders.</summary>
public sealed class SortOrderPositiveBaselineFactory : ImsApiFactory
{
    protected override string? InitialMigration => "20261118194650_EvaluationCriteriaSortOrderPositive";
}

/// <summary>Plain SQL helpers for the criteria tests below (each test class has its own disposable database).</summary>
internal static class CriteriaSql
{
    public static async Task<int> InsertAsync(NpgsqlConnection connection, string nameEn, bool isActive = true, NpgsqlTransaction? transaction = null, int? sortOrder = null)
    {
        var order = sortOrder is null ? "" : ", sort_order";
        var value = sortOrder is null ? "" : $", {sortOrder}";
        await using var command = new NpgsqlCommand(
            $"INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active{order}) VALUES (gen_random_uuid(), 'معيار', @en, @active{value}) RETURNING sort_order",
            connection,
            transaction);
        command.Parameters.AddWithValue("en", nameEn);
        command.Parameters.AddWithValue("active", isActive);
        return (int)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
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
}

/// <summary>
/// Migration EvaluationCriteriaAutomaticOrder (owner decisions O1–O5, 2026-11-18): existing orders are numbered once in
/// the order the criteria are displayed today (sort_order, name_ar, id); ids, names, flags, legacy values and audit
/// history are otherwise unchanged; only the changed orders are audited.
/// </summary>
public sealed class EvaluationCriteriaAutomaticOrderMigrationTests(SortOrderPositiveBaselineFactory factory)
    : IClassFixture<SortOrderPositiveBaselineFactory>
{
    private const string Target = "EvaluationCriteriaAutomaticOrder";

    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Migration_numbers_the_criteria_once_in_their_displayed_order_and_keeps_everything_else()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        // As in the UAT copy: the three production criteria share order 1; an Admin added a fourth with order 2.
        // An inactive criterion is numbered like the others.
        await CriteriaSql.ExecuteAsync(connection, """
            INSERT INTO evaluation_criteria (id, name_ar, name_en, sort_order, is_active, name, weight) VALUES
              ('01900000-0000-7000-8000-000000000003', 'حضور وغياب', 'Attendance and Absence', 1, true, 'حضور وغياب', 1),
              ('01900000-0000-7000-8000-000000000001', 'التزام بالمواعيد', 'Punctuality', 1, true, 'التزام بالمواعيد', 1),
              ('01900000-0000-7000-8000-000000000002', 'التزام بالوقت (تنفيذ المهام)', 'Timely Task Completion', 1, true, 'التزام بالوقت (تنفيذ المهام)', 1),
              ('01900000-0000-7000-8000-000000000004', 'جودة العمل', 'Quality of Work', 2, true, 'جودة العمل', NULL),
              ('01900000-0000-7000-8000-000000000005', 'معيار موقوف', 'Inactive criterion', 7, false, 'معيار موقوف', NULL)
            """);
        const string Unchanged = "SELECT string_agg(format('%s|%s|%s|%s|%s|%s', id, name_ar, name_en, is_active, name, weight), ',' ORDER BY id) FROM evaluation_criteria";
        const string Audit = "SELECT count(*) || ':' || max(id) || ':' || md5(string_agg(a::text, '|' ORDER BY id)) FROM audit_logs a";
        var unchangedBefore = await CriteriaSql.ScalarAsync(connection, Unchanged);
        var auditBefore = (string)(await CriteriaSql.ScalarAsync(connection, Audit))!;
        var maxAuditId = long.Parse(auditBefore.Split(':')[1], System.Globalization.CultureInfo.InvariantCulture);

        await factory.WithDbAsync(async db =>
        {
            await db.Database.MigrateAsync(db.Database.GetMigrations().Single(m => m.EndsWith(Target, StringComparison.Ordinal)), _ct);
            return 0;
        });

        Assert.Equal(
            "Punctuality,Timely Task Completion,Attendance and Absence,Quality of Work,Inactive criterion|1,2,3,4,5",
            await CriteriaSql.ScalarAsync(connection, "SELECT string_agg(name_en, ',' ORDER BY sort_order) || '|' || string_agg(sort_order::text, ',' ORDER BY sort_order) FROM evaluation_criteria"));
        Assert.Equal(unchangedBefore, await CriteriaSql.ScalarAsync(connection, Unchanged));
        Assert.Equal(auditBefore, await CriteriaSql.ScalarAsync(connection, $"SELECT count(*) || ':' || max(id) || ':' || md5(string_agg(a::text, '|' ORDER BY id)) FROM audit_logs a WHERE id <= {maxAuditId}"));
        // Punctuality keeps 1 (not audited); the other four orders changed: one audited UPDATE each, order only. The actor is
        // System when EF applies the migration through the app (its connection interceptor); a psql apply records Database.
        Assert.Equal(
            "UPDATE System sort_order 01900000-0000-7000-8000-000000000002 1→2;UPDATE System sort_order 01900000-0000-7000-8000-000000000003 1→3;UPDATE System sort_order 01900000-0000-7000-8000-000000000004 2→4;UPDATE System sort_order 01900000-0000-7000-8000-000000000005 7→5",
            await CriteriaSql.ScalarAsync(connection, $"""
                SELECT string_agg(format('%s %s %s %s %s→%s', operation, actor_type, (SELECT string_agg(k, ',') FROM jsonb_object_keys(new_values) k),
                                         entity_id, old_values ->> 'sort_order', new_values ->> 'sort_order'), ';' ORDER BY entity_id)
                  FROM audit_logs WHERE id > {maxAuditId}
                """));
    }
}

/// <summary>
/// Automatic order in PostgreSQL (O2–O4): a BEFORE INSERT trigger gives each new criterion the highest order + 1 under a
/// transaction-scoped advisory lock, inactive criteria included; orders are unique and never change afterwards.
/// One ordered scenario on its own empty database.
/// </summary>
public sealed class EvaluationCriteriaAutomaticOrderDatabaseTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_database_numbers_new_criteria_one_after_another_and_never_changes_an_order()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);

        // First, then sequential criteria; an order supplied by the caller is ignored.
        Assert.Equal(1, await CriteriaSql.InsertAsync(connection, "First"));
        Assert.Equal(2, await CriteriaSql.InsertAsync(connection, "Second", sortOrder: 99));
        Assert.Equal(3, await CriteriaSql.InsertAsync(connection, "Third (inactive)", isActive: false));
        Assert.Equal(4, await CriteriaSql.InsertAsync(connection, "Fourth, after an inactive one"));

        // A rolled-back insert uses no number.
        await using (var rolledBack = await connection.BeginTransactionAsync(_ct))
        {
            Assert.Equal(5, await CriteriaSql.InsertAsync(connection, "Rolled back", transaction: rolledBack));
            await rolledBack.RollbackAsync(_ct);
        }

        Assert.Equal(5, await CriteriaSql.InsertAsync(connection, "Fifth"));

        // Names and the active flag change; the order does not. A direct change of the order is refused.
        await CriteriaSql.ExecuteAsync(connection, "UPDATE evaluation_criteria SET name_ar = 'معدل', name_en = 'Edited', is_active = false WHERE sort_order = 2");
        Assert.Equal("Edited", await CriteriaSql.ScalarAsync(connection, "SELECT name_en FROM evaluation_criteria WHERE sort_order = 2"));
        foreach (var change in new[] { "sort_order = 6", "sort_order = 1", "sort_order = sort_order + 1" })
        {
            var error = await Assert.ThrowsAnyAsync<PostgresException>(() =>
                CriteriaSql.ExecuteAsync(connection, $"UPDATE evaluation_criteria SET {change} WHERE sort_order = 3"));
            Assert.Contains("order", error.MessageText, StringComparison.OrdinalIgnoreCase);
        }

        // Unique even if the trigger is bypassed (only a superuser can): the index is the backstop.
        await using (var bypass = await connection.BeginTransactionAsync(_ct))
        {
            await CriteriaSql.ExecuteAsync(connection, "SET LOCAL session_replication_role = replica");
            var duplicate = await Assert.ThrowsAsync<PostgresException>(() => CriteriaSql.InsertAsync(connection, "Duplicate", transaction: bypass, sortOrder: 1));
            Assert.Equal((PostgresErrorCodes.UniqueViolation, "ux_evaluation_criteria_sort_order"), (duplicate.SqlState, duplicate.ConstraintName));
        }

        // 20 concurrent creates, each on its own connection and transaction, holding it briefly: 6..25, each exactly once.
        var orders = await Task.WhenAll(Enumerable.Range(1, 20).Select(async i =>
        {
            await using var own = new NpgsqlConnection(factory.ConnectionString);
            await own.OpenAsync(_ct);
            await using var transaction = await own.BeginTransactionAsync(_ct);
            var order = await CriteriaSql.InsertAsync(own, $"Concurrent {i}", transaction: transaction);
            await Task.Delay(20, _ct);
            await transaction.CommitAsync(_ct);
            return order;
        }));
        Assert.Equal(Enumerable.Range(6, 20), orders.Order());
        Assert.Equal(25L, await CriteriaSql.ScalarAsync(connection, "SELECT count(DISTINCT sort_order) FROM evaluation_criteria"));
    }
}

/// <summary>At the integer maximum the next criterion is refused (no wrap-around, no duplicate). Own database.</summary>
public sealed class EvaluationCriteriaAutomaticOrderOverflowTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task After_the_integer_maximum_a_new_criterion_is_refused_and_nothing_is_written()
    {
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        await using (var setup = await connection.BeginTransactionAsync(_ct))
        {
            // Only a superuser can bypass the trigger; this puts a criterion at the maximum to test the limit.
            await CriteriaSql.ExecuteAsync(connection, "SET LOCAL session_replication_role = replica");
            await CriteriaSql.InsertAsync(connection, "At the maximum", transaction: setup, sortOrder: int.MaxValue);
            await setup.CommitAsync(_ct);
        }

        var error = await Assert.ThrowsAsync<PostgresException>(() => CriteriaSql.InsertAsync(connection, "One too many"));

        Assert.Equal(PostgresErrorCodes.NumericValueOutOfRange, error.SqlState);
        Assert.Equal(1L, await CriteriaSql.ScalarAsync(connection, "SELECT count(*) FROM evaluation_criteria"));
    }
}
