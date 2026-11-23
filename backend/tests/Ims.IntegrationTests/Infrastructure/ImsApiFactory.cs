using System.Net;
using Docker.DotNet;
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

    /// <summary>Container starts per factory, the first included (S2.4 stabilization, owner decision of 2026-11-23).</summary>
    internal const int MaxContainerStartAttempts = 3;

    /// <summary>
    /// When set, each retried container start is appended to this file (outside the repository), so a run with a
    /// recovered host-port collision can be told from a clean one. Optional; no configuration changes otherwise.
    /// </summary>
    internal const string RetryLogVariable = "IMS_TESTCONTAINERS_RETRY_LOG";

    private PostgreSqlContainer _database = NewContainer();

    private static PostgreSqlContainer NewContainer() => new PostgreSqlBuilder("postgres:18.6-alpine").Build();

    public string ConnectionString => _database.GetConnectionString();

    /// <summary>The migration the database starts at; null (default) is the latest. Migration tests start earlier.</summary>
    protected virtual string? InitialMigration => null;

    public async ValueTask InitializeAsync()
    {
        await StartDatabaseAsync();
        await using var scope = Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<AppDbContext>().Database;
        await (InitialMigration is null ? database.MigrateAsync() : database.MigrateAsync(InitialMigration));
    }

    /// <summary>
    /// Starts the container. Docker Desktop on macOS can pick a random host port that is already in use ("failed to bind
    /// host port … address already in use", seen when the suites run one after another); only that failure is retried,
    /// with a new container each time, at most <see cref="MaxContainerStartAttempts"/> starts in all. Any other failure,
    /// and the last collision, is thrown unchanged. Migrations and tests are never retried.
    /// </summary>
    private async Task StartDatabaseAsync()
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await _database.StartAsync();
                return;
            }
            catch (DockerApiException error) when (attempt < MaxContainerStartAttempts && IsHostPortCollision(error))
            {
                RecordRetry(attempt, error);
                await _database.DisposeAsync();
                _database = NewContainer();
            }
        }
    }

    /// <summary>Docker could not bind the randomly chosen host port because something else holds it.</summary>
    internal static bool IsHostPortCollision(DockerApiException error) =>
        error.StatusCode == HttpStatusCode.InternalServerError
        && error.Message.Contains("failed to bind host port", StringComparison.Ordinal)
        && error.Message.Contains("address already in use", StringComparison.Ordinal);

    private void RecordRetry(int attempt, DockerApiException error)
    {
        var line = $"{DateTimeOffset.UtcNow:O} {GetType().Name} start attempt {attempt} of {MaxContainerStartAttempts} " +
                   $"failed with a host-port collision; retrying with a new container: {error.Message}";
        Console.Error.WriteLine(line);
        var log = Environment.GetEnvironmentVariable(RetryLogVariable);
        if (!string.IsNullOrEmpty(log))
        {
            File.AppendAllText(log, line + Environment.NewLine);
        }
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
