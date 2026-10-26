using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Ims.Application.Admin.EvaluationCriteria;
using Ims.Application.Admin.Fields;
using Ims.Application.Admin.Settings;
using Ims.Application.Admin.Users;
using Ims.Domain.Auditing;
using Ims.Domain.Roles;
using Ims.Domain.Staff;
using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.IntegrationTests;

/// <summary>The Admin module end-to-end: HTTP → API → PostgreSQL, including permissions and audit.</summary>
public sealed class AdminApiTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    public static TheoryData<string, string> Endpoints => new()
    {
        { "GET", "/api/admin/fields" },
        { "GET", "/api/admin/evaluation-criteria" },
        { "GET", "/api/admin/users" },
        { "GET", "/api/admin/settings/notifications" },
    };

    // ── Permissions (PDF §2: only Admin manages fields, criteria, users) ─────

    [Theory]
    [MemberData(nameof(Endpoints))]
    public async Task Anonymous_requests_are_rejected(string method, string url)
    {
        using var client = factory.CreateClient(role: null);

        var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), url), _ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("HR")]
    [InlineData("Employee")]
    [InlineData("Trainee")]
    public async Task Only_admins_can_use_the_admin_module(string role)
    {
        using var client = factory.CreateClient(role);

        foreach (var url in new[] { "/api/admin/fields", "/api/admin/evaluation-criteria", "/api/admin/users", "/api/admin/settings/notifications" })
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(new Uri(url, UriKind.Relative), _ct)).StatusCode);
        }
    }

    // ── Fields ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Admin_creates_edits_and_deactivates_a_field()
    {
        using var admin = factory.CreateClient("Admin");
        var name = Unique("Frontend");

        var created = await ReadAsync<FieldDto>(await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest(name, "Angular"), _ct), HttpStatusCode.Created);
        Assert.True(created.IsActive);

        var updated = await ReadAsync<FieldDto>(
            await admin.PutAsJsonAsync($"/api/admin/fields/{created.Id}", new UpdateFieldRequest(name, "Angular & UI", IsActive: false), _ct));
        Assert.Equal(("Angular & UI", false), (updated.Description, updated.IsActive));

        var list = await admin.GetFromJsonAsync<List<FieldDto>>("/api/admin/fields", Json, _ct);
        Assert.Contains(list!, f => f.Id == created.Id && !f.IsActive);
    }

    [Fact]
    public async Task Field_names_are_unique_ignoring_case()
    {
        using var admin = factory.CreateClient("Admin");
        var name = Unique("QA");
        await ReadAsync<FieldDto>(await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest(name, null), _ct), HttpStatusCode.Created);

        var duplicate = await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest(name.ToUpperInvariant(), null), _ct);

        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
    }

    [Fact]
    public async Task Invalid_or_unknown_fields_are_rejected()
    {
        using var admin = factory.CreateClient("Admin");

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest("", null), _ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await admin.PutAsJsonAsync($"/api/admin/fields/{Guid.CreateVersion7()}", new UpdateFieldRequest("X", null, true), _ct)).StatusCode);
    }

    // ── Evaluation criteria ──────────────────────────────────────────────────

    [Fact]
    public async Task Admin_manages_evaluation_criteria_and_weights_in_order()
    {
        using var admin = factory.CreateClient("Admin");
        var second = await ReadAsync<EvaluationCriterionDto>(
            await admin.PostAsJsonAsync("/api/admin/evaluation-criteria", new SaveEvaluationCriterionRequest(Unique("Teamwork"), 1, 2), _ct), HttpStatusCode.Created);
        var first = await ReadAsync<EvaluationCriterionDto>(
            await admin.PostAsJsonAsync("/api/admin/evaluation-criteria", new SaveEvaluationCriterionRequest(Unique("Technical"), 3, 1), _ct), HttpStatusCode.Created);

        var updated = await ReadAsync<EvaluationCriterionDto>(
            await admin.PutAsJsonAsync($"/api/admin/evaluation-criteria/{second.Id}", new SaveEvaluationCriterionRequest(second.Name, 2.5m, 2), _ct));
        Assert.Equal(2.5m, updated.Weight);

        var list = (await admin.GetFromJsonAsync<List<EvaluationCriterionDto>>("/api/admin/evaluation-criteria", Json, _ct))!;
        Assert.True(list.FindIndex(c => c.Id == first.Id) < list.FindIndex(c => c.Id == second.Id));
    }

    [Fact]
    public async Task A_criterion_weight_must_be_positive()
    {
        using var admin = factory.CreateClient("Admin");

        var response = await admin.PostAsJsonAsync("/api/admin/evaluation-criteria", new SaveEvaluationCriterionRequest("Zero", 0, 1), _ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ── Users and roles ──────────────────────────────────────────────────────

    [Fact]
    public async Task Admin_grants_higher_roles_to_staff()
    {
        var employee = await SeedEmployeeAsync();
        using var admin = factory.CreateClient("Admin");

        var users = await admin.GetFromJsonAsync<List<UserDto>>("/api/admin/users", Json, _ct);
        Assert.Equal(UserRole.Employee, users!.Single(u => u.Id == employee.Id).Role);

        var promoted = await ReadAsync<UserDto>(
            await admin.PutAsJsonAsync($"/api/admin/users/{employee.Id}/role", new ChangeUserRoleRequest(UserRole.HR), Json, _ct));
        Assert.Equal(UserRole.HR, promoted.Role);
        Assert.Equal(UserRole.HR, await factory.WithDbAsync(db => db.Employees.Where(e => e.Id == employee.Id).Select(e => e.Role).SingleAsync(_ct)));
    }

    [Fact]
    public async Task Staff_cannot_be_given_the_Trainee_role_and_unknown_users_are_404()
    {
        var employee = await SeedEmployeeAsync();
        using var admin = factory.CreateClient("Admin");

        var trainee = await admin.PutAsJsonAsync($"/api/admin/users/{employee.Id}/role", new ChangeUserRoleRequest(UserRole.Trainee), Json, _ct);
        var unknown = await admin.PutAsJsonAsync($"/api/admin/users/{Guid.CreateVersion7()}/role", new ChangeUserRoleRequest(UserRole.HR), Json, _ct);

        Assert.Equal(HttpStatusCode.BadRequest, trainee.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    // ── Notification settings (PDF §7: 7 / 3 / 5 days) ───────────────────────

    [Fact]
    public async Task Admin_changes_the_notification_intervals()
    {
        using var admin = factory.CreateClient("Admin");

        var defaults = await admin.GetFromJsonAsync<NotificationSettingsDto>("/api/admin/settings/notifications", Json, _ct);
        Assert.Equal(new NotificationSettingsDto(7, 3, 5), defaults);

        var updated = await ReadAsync<NotificationSettingsDto>(
            await admin.PutAsJsonAsync("/api/admin/settings/notifications", new NotificationSettingsDto(10, 2, 4), _ct));
        Assert.Equal(new NotificationSettingsDto(10, 2, 4), updated);
        Assert.Equal(updated, await admin.GetFromJsonAsync<NotificationSettingsDto>("/api/admin/settings/notifications", Json, _ct));

        var invalid = await admin.PutAsJsonAsync("/api/admin/settings/notifications", new NotificationSettingsDto(0, 2, 4), _ct);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
    }

    // ── Database: roles, audit log, no hard deletes (PDF §6, §8) ─────────────

    [Fact]
    public async Task The_database_holds_exactly_the_four_roles()
    {
        var roles = await factory.WithDbAsync(db => db.Roles.Select(r => r.Code).ToListAsync(_ct));

        Assert.Equal([UserRole.Admin, UserRole.HR, UserRole.Trainee, UserRole.Employee], roles.Order());
    }

    [Fact]
    public async Task Admin_changes_are_recorded_in_the_audit_log_with_the_admin_as_actor()
    {
        var adminId = Guid.CreateVersion7();
        using var admin = factory.CreateClient("Admin", adminId);
        var field = await ReadAsync<FieldDto>(await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest(Unique("Design"), null), _ct), HttpStatusCode.Created);

        var entry = await factory.WithDbAsync(db => db.AuditLogs.SingleAsync(a => a.EntityId == field.Id.ToString(), _ct));

        Assert.Equal(("INSERT", "fields", AuditActorType.Staff, (Guid?)adminId), (entry.Operation, entry.TableName, entry.ActorType, entry.ActorId));
    }

    [Theory]
    [InlineData("DELETE FROM fields")]
    [InlineData("DELETE FROM employees")]
    [InlineData("DELETE FROM evaluation_criteria")]
    [InlineData("DELETE FROM roles")]
    [InlineData("TRUNCATE notification_settings")]
    public async Task Records_cannot_be_deleted(string sql)
    {
        // Row-level triggers fire per row, so make sure every table has at least one.
        await SeedEmployeeAsync();
        using var admin = factory.CreateClient("Admin");
        await admin.PostAsJsonAsync("/api/admin/fields", new CreateFieldRequest(Unique("Seed"), null), _ct);
        await admin.PostAsJsonAsync("/api/admin/evaluation-criteria", new SaveEvaluationCriterionRequest(Unique("Seed"), 1, 1), _ct);
        await using var connection = new NpgsqlConnection(factory.ConnectionString);
        await connection.OpenAsync(_ct);
        await using var command = new NpgsqlCommand(sql, connection);

        var error = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync(_ct));

        Assert.Equal(PostgresErrorCodes.RestrictViolation, error.SqlState);
    }

    private static string Unique(string prefix) => $"{prefix} {Guid.NewGuid():N}"[..(prefix.Length + 9)];

    private async Task<Employee> SeedEmployeeAsync()
    {
        var employee = Employee.CreateOnFirstSignIn($"{Guid.NewGuid():N}@company.com", "New Employee");
        return await factory.WithDbAsync(async db =>
        {
            db.Employees.Add(employee);
            await db.SaveChangesAsync(_ct);
            return employee;
        });
    }

    private async Task<T> ReadAsync<T>(HttpResponseMessage response, HttpStatusCode expected = HttpStatusCode.OK)
    {
        Assert.Equal(expected, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<T>(Json, _ct))!;
    }
}
