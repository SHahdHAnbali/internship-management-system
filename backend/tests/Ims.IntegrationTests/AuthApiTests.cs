using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Ims.Application.Auth;
using Ims.Domain.Roles;
using Ims.IntegrationTests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using static Ims.IntegrationTests.Infrastructure.ImsApiFactory;

namespace Ims.IntegrationTests;

/// <summary>
/// Authentication and authorization end-to-end with the real session cookie: staff Google sign-in (company domain only,
/// first sign-in = Employee), trainee one-time link/code (15 minutes, single use), role enforcement and isolation.
/// </summary>
public sealed class AuthApiTests(CookieAuthApiFactory factory) : IClassFixture<CookieAuthApiFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    // ── Staff: Google sign-in ────────────────────────────────────────────────

    [Fact]
    public async Task First_Google_sign_in_from_the_company_domain_creates_an_Employee()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@{CompanyDomain}";

        var user = await SignInWithGoogleAsync(client, email);

        Assert.Equal((UserRole.Employee, email), (user.Role, user.Email));
        var me = await client.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct);
        Assert.Equal(user.Id, me!.Id);

        using var again = factory.CreateClient();
        Assert.Equal(user.Id, (await SignInWithGoogleAsync(again, email.ToUpperInvariant())).Id);
        Assert.Equal(1, await factory.WithDbAsync(db => db.Employees.CountAsync(e => e.Email == email, _ct)));
    }

    [Theory]
    [InlineData("someone@gmail.com", null)]
    [InlineData("someone@other.example", "other.example")]
    [InlineData("someone@company.example", null)] // personal account using the company address, without the Workspace "hd" claim
    public async Task Accounts_outside_the_company_domain_are_refused(string email, string? hostedDomain)
    {
        using var client = factory.CreateClient();
        var token = factory.Google.Issue(email, hostedDomain);

        var response = await client.PostAsJsonAsync("/api/auth/staff/google", new GoogleSignInRequest(token), _ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.False(await factory.WithDbAsync(db => db.Employees.AnyAsync(e => e.Email == email, _ct)));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(new Uri("/api/auth/me", UriKind.Relative), _ct)).StatusCode);
    }

    [Fact]
    public async Task Invalid_tokens_and_unverified_emails_are_rejected()
    {
        using var client = factory.CreateClient();
        var unverified = factory.Google.Issue($"x@{CompanyDomain}", CompanyDomain, emailVerified: false);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/auth/staff/google", new GoogleSignInRequest("forged"), _ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/auth/staff/google", new GoogleSignInRequest(unverified), _ct)).StatusCode);
    }

    [Fact]
    public async Task Roles_come_from_PostgreSQL_and_changes_apply_to_the_current_session()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@{CompanyDomain}";
        await SignInWithGoogleAsync(client, email);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(new Uri("/api/admin/fields", UriKind.Relative), _ct)).StatusCode);

        await SetRoleAsync(email, UserRole.Admin);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(new Uri("/api/admin/fields", UriKind.Relative), _ct)).StatusCode);
        Assert.Equal(UserRole.Admin, (await client.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct))!.Role);

        await SetRoleAsync(email, UserRole.HR);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(new Uri("/api/admin/fields", UriKind.Relative), _ct)).StatusCode);
    }

    [Fact]
    public async Task Only_an_Admin_can_grant_higher_roles()
    {
        using var employee = factory.CreateClient();
        var employeeUser = await SignInWithGoogleAsync(employee, $"{Guid.NewGuid():N}@{CompanyDomain}");

        var selfPromotion = await employee.PutAsJsonAsync($"/api/admin/users/{employeeUser.Id}/role", new { role = "Admin" }, _ct);
        Assert.Equal(HttpStatusCode.Forbidden, selfPromotion.StatusCode);

        using var admin = factory.CreateClient();
        var adminEmail = $"{Guid.NewGuid():N}@{CompanyDomain}";
        await SignInWithGoogleAsync(admin, adminEmail);
        await SetRoleAsync(adminEmail, UserRole.Admin);
        var granted = await admin.PutAsJsonAsync($"/api/admin/users/{employeeUser.Id}/role", new { role = "HR" }, _ct);
        Assert.Equal(HttpStatusCode.OK, granted.StatusCode);
        Assert.Equal(UserRole.HR, (await employee.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct))!.Role);
    }

    // ── Trainee: passwordless e-mail link or code ────────────────────────────

    [Fact]
    public async Task A_trainee_registers_and_signs_in_with_the_emailed_code()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";

        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct)).StatusCode);
        var (code, _) = factory.Emails.LastSignInFor(email);
        Assert.Matches(@"^\d{6}$", code);
        Assert.Contains("15", factory.Emails.LastTo(email).TextBody, StringComparison.Ordinal);

        var user = await ReadAsync<SessionUser>(await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, code, null), _ct));

        Assert.Equal((UserRole.Trainee, email), (user.Role, user.Email));
        Assert.Equal(email, (await client.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct))!.Email);
        Assert.True(await factory.WithDbAsync(db => db.Trainees.AnyAsync(t => t.Email == email, _ct)));
    }

    [Fact]
    public async Task The_emailed_link_signs_the_trainee_in_once()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";
        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (_, token) = factory.Emails.LastSignInFor(email);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(null, null, token), _ct)).StatusCode);
        using var replay = factory.CreateClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await replay.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(null, null, token), _ct)).StatusCode);
    }

    [Fact]
    public async Task Codes_expire_after_15_minutes()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";
        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (code, token) = factory.Emails.LastSignInFor(email);

        factory.Clock.Advance(TimeSpan.FromMinutes(15));
        try
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, code, null), _ct)).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(null, null, token), _ct)).StatusCode);
        }
        finally
        {
            factory.Clock.Advance(TimeSpan.FromMinutes(-15));
        }
    }

    [Fact]
    public async Task A_code_is_still_valid_just_before_15_minutes()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";
        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (code, _) = factory.Emails.LastSignInFor(email);

        factory.Clock.Advance(TimeSpan.FromMinutes(14.9));
        try
        {
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, code, null), _ct)).StatusCode);
        }
        finally
        {
            factory.Clock.Advance(TimeSpan.FromMinutes(-14.9));
        }
    }

    [Fact]
    public async Task Codes_are_single_use_replaced_by_newer_requests_and_locked_after_5_wrong_attempts()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";

        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (first, _) = factory.Emails.LastSignInFor(email);
        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (second, _) = factory.Emails.LastSignInFor(email);
        if (first != second)
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, first, null), _ct)).StatusCode);
        }

        var wrong = second == "000000" ? "111111" : "000000";
        for (var i = 0; i < 5; i++)
        {
            await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, wrong, null), _ct);
        }

        var locked = await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, second, null), _ct);
        Assert.Equal(HttpStatusCode.BadRequest, locked.StatusCode);
    }

    [Fact]
    public async Task Requesting_a_code_does_not_reveal_whether_an_account_exists_and_stores_no_plain_code()
    {
        using var client = factory.CreateClient();
        var email = $"{Guid.NewGuid():N}@uni.example";

        var response = await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (code, token) = factory.Emails.LastSignInFor(email);
        var stored = await factory.WithDbAsync(db => db.TraineeSignInCodes.SingleAsync(c => c.Email == email, _ct));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.False(await factory.WithDbAsync(db => db.Trainees.AnyAsync(t => t.Email == email, _ct)));
        Assert.DoesNotContain(code, stored.CodeHash, StringComparison.Ordinal);
        Assert.NotEqual(token, stored.TokenHash);
    }

    // ── Authorization and isolation ──────────────────────────────────────────

    [Fact]
    public async Task A_trainee_sees_only_their_own_account_and_no_staff_area()
    {
        using var alice = factory.CreateClient();
        using var bob = factory.CreateClient();
        var aliceUser = await SignInTraineeAsync(alice, $"{Guid.NewGuid():N}@uni.example");
        var bobUser = await SignInTraineeAsync(bob, $"{Guid.NewGuid():N}@uni.example");

        Assert.Equal(aliceUser.Id, (await alice.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct))!.Id);
        Assert.Equal(bobUser.Id, (await bob.GetFromJsonAsync<SessionUser>("/api/auth/me", Json, _ct))!.Id);
        foreach (var url in new[] { "/api/admin/fields", "/api/admin/users", "/api/admin/evaluation-criteria", "/api/admin/settings/notifications" })
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await alice.GetAsync(new Uri(url, UriKind.Relative), _ct)).StatusCode);
        }
    }

    [Fact]
    public async Task Signing_out_ends_the_session_and_anonymous_requests_are_refused()
    {
        using var client = factory.CreateClient();
        await SignInWithGoogleAsync(client, $"{Guid.NewGuid():N}@{CompanyDomain}");

        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync(new Uri("/api/auth/sign-out", UriKind.Relative), null, _ct)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(new Uri("/api/auth/me", UriKind.Relative), _ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(new Uri("/api/admin/fields", UriKind.Relative), _ct)).StatusCode);
    }

    [Fact]
    public async Task Public_sign_in_settings_expose_only_the_client_id_domain_and_lifetime()
    {
        using var client = factory.CreateClient();

        var config = await client.GetFromJsonAsync<AuthConfiguration>("/api/auth/config", Json, _ct);

        Assert.Equal(new AuthConfiguration("test-client-id.apps.googleusercontent.com", CompanyDomain, 15), config);
    }

    private async Task<SessionUser> SignInWithGoogleAsync(HttpClient client, string email)
    {
        var token = factory.Google.Issue(email, CompanyDomain);
        return await ReadAsync<SessionUser>(await client.PostAsJsonAsync("/api/auth/staff/google", new GoogleSignInRequest(token), _ct));
    }

    private async Task<SessionUser> SignInTraineeAsync(HttpClient client, string email)
    {
        await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest(email), _ct);
        var (code, _) = factory.Emails.LastSignInFor(email);
        return await ReadAsync<SessionUser>(await client.PostAsJsonAsync("/api/auth/trainee/verify", new TraineeCodeVerification(email, code, null), _ct));
    }

    // Stands in for the operator's one-time SQL/Admin action; goes through the domain so the staff-role rule applies.
    private Task<int> SetRoleAsync(string email, UserRole role) => factory.WithDbAsync(async db =>
    {
        var normalized = email.ToLowerInvariant();
        var employee = await db.Employees.SingleAsync(e => e.Email == normalized, _ct);
        employee.ChangeRole(role);
        return await db.SaveChangesAsync(_ct);
    });

    private async Task<T> ReadAsync<T>(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<T>(Json, _ct))!;
    }
}
