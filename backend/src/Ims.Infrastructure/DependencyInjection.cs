using Ims.Application.Common.Persistence;
using Ims.Application.Common.Security;
using Ims.Infrastructure.Identity;
using Ims.Infrastructure.Persistence;
using Ims.Infrastructure.Persistence.Interceptors;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Ims.Infrastructure;

public static class DependencyInjection
{
    public const string DatabaseConnectionName = "Database";

    /// <summary>
    /// Registers infrastructure services: EF Core/PostgreSQL and identity options.
    /// Email, file storage, PDF/QR and scheduled jobs are added as each integration is introduced.
    /// </summary>
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddScoped<ICurrentUser, SystemCurrentUser>();
        services.AddScoped<AuditActorConnectionInterceptor>();
        services.AddSingleton<PreventDeleteInterceptor>();

        // The connection string is resolved when the context is first built (not at startup) so that
        // integration tests and design-time tooling can supply it through configuration.
        services.AddDbContext<AppDbContext>((serviceProvider, options) =>
        {
            var connectionString = serviceProvider.GetRequiredService<IConfiguration>().GetConnectionString(DatabaseConnectionName);
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    $"Connection string '{DatabaseConnectionName}' is not configured. See README.md (Local database).");
            }

            options.UseNpgsql(connectionString);
            options.AddInterceptors(
                serviceProvider.GetRequiredService<AuditActorConnectionInterceptor>(),
                serviceProvider.GetRequiredService<PreventDeleteInterceptor>());
        });
        services.AddScoped<IAppDbContext>(serviceProvider => serviceProvider.GetRequiredService<AppDbContext>());

        services.AddHealthChecks().AddCheck<DatabaseHealthCheck>("database");

        services.Configure<GoogleAuthOptions>(configuration.GetSection(GoogleAuthOptions.SectionName));
        services.Configure<TraineeSignInOptions>(configuration.GetSection(TraineeSignInOptions.SectionName));

        return services;
    }
}
