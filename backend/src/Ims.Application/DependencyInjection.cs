using Microsoft.Extensions.DependencyInjection;

namespace Ims.Application;

public static class DependencyInjection
{
    /// <summary>Registers application-layer services (feature use cases, validators).</summary>
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        return services;
    }
}
