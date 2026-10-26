using Ims.Application.Admin.EvaluationCriteria;
using Ims.Application.Admin.Fields;
using Ims.Application.Admin.Settings;
using Ims.Application.Admin.Users;
using Microsoft.Extensions.DependencyInjection;

namespace Ims.Application;

public static class DependencyInjection
{
    /// <summary>Registers application-layer services (feature use cases, validators).</summary>
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<FieldManagement>();
        services.AddScoped<EvaluationCriterionManagement>();
        services.AddScoped<UserManagement>();
        services.AddScoped<NotificationSettingsManagement>();
        return services;
    }
}
