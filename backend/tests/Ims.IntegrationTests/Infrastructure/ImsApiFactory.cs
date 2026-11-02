using Ims.Application.Common.Email;
using Ims.Application.Common.Security;
using Ims.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Testcontainers.PostgreSql;

namespace Ims.IntegrationTests.Infrastructure;

/// <summary>
/// Hosts the API in-memory against a disposable, fully migrated PostgreSQL container (requires Docker).
/// By default requests authenticate through <see cref="TestAuthHandler"/>; <see cref="CookieAuthApiFactory"/> uses the
/// real cookie sign-in instead. External services are replaced by test doubles (Google, e-mail, clock).
/// </summary>
public class ImsApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string CompanyDomain = "company.example";

    public FakeGoogleIdTokenValidator Google { get; } = new();

    public CapturingEmailSender Emails { get; } = new();

    public TestClock Clock { get; } = new();

    /// <summary>When true (default), the X-Test-Role header signs requests in; when false, the real session cookie is used.</summary>
    protected virtual bool UseTestAuthentication => true;

    protected virtual int TraineeRateLimitPerMinute => 1000;

    private readonly PostgreSqlContainer _database = new PostgreSqlBuilder("postgres:18.6-alpine").Build();

    public string ConnectionString => _database.GetConnectionString();

    public async ValueTask InitializeAsync()
    {
        await _database.StartAsync();
        await using var scope = Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
    }

    public override async ValueTask DisposeAsync()
    {
        await _database.DisposeAsync();
        await base.DisposeAsync();
        GC.SuppressFinalize(this);
    }

    /// <summary>A client signed in with the given role (role code from the <c>roles</c> table), or anonymous when null.</summary>
    public HttpClient CreateClient(string? role, Guid? userId = null)
    {
        var client = CreateClient();
        if (role is not null)
        {
            client.DefaultRequestHeaders.Add(TestAuthHandler.RoleHeader, role);
            client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, (userId ?? Guid.CreateVersion7()).ToString());
        }

        return client;
    }

    /// <summary>Runs work against the database with the API's own DbContext configuration.</summary>
    public async Task<T> WithDbAsync<T>(Func<AppDbContext, Task<T>> work)
    {
        await using var scope = Services.CreateAsyncScope();
        return await work(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration(configuration => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Database"] = _database.GetConnectionString(),
            ["Authentication:Google:ClientId"] = "test-client-id.apps.googleusercontent.com",
            ["Authentication:Google:HostedDomain"] = CompanyDomain,
            ["Authentication:Trainee:SignInLinkBaseUrl"] = "http://localhost:4200",
            ["Authentication:Trainee:RateLimitPerMinute"] = TraineeRateLimitPerMinute.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IGoogleIdTokenValidator>();
            services.AddSingleton<IGoogleIdTokenValidator>(Google);
            services.RemoveAll<IEmailSender>();
            services.AddSingleton<IEmailSender>(Emails);
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            if (!UseTestAuthentication)
            {
                return;
            }

            services.AddAuthentication().AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, null);
            services.PostConfigure<AuthenticationOptions>(options =>
            {
                options.DefaultScheme = TestAuthHandler.SchemeName;
                options.DefaultAuthenticateScheme = TestAuthHandler.SchemeName;
                options.DefaultChallengeScheme = TestAuthHandler.SchemeName;
                options.DefaultForbidScheme = TestAuthHandler.SchemeName;
            });
        });
    }
}
