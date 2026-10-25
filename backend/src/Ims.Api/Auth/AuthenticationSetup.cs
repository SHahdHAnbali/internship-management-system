using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;

namespace Ims.Api.Auth;

public static class AuthenticationSetup
{
    /// <summary>
    /// Session strategy: after the API verifies a Google ID token (staff) or a one-time email code (trainee),
    /// it issues an HttpOnly cookie. The SPA is served from the same origin (dev proxy / single host), so no
    /// token is ever stored in JavaScript. Sign-in endpoints are implemented in a later step.
    /// </summary>
    public static IServiceCollection AddImsAuthentication(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        var idleTimeout = TimeSpan.FromMinutes(configuration.GetValue("Authentication:Session:IdleTimeoutMinutes", 480));

        services
            .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
            .AddCookie(options =>
            {
                options.Cookie.Name = "ims.session";
                options.Cookie.HttpOnly = true;
                options.Cookie.SameSite = SameSiteMode.Strict;
                options.Cookie.SecurePolicy = environment.IsDevelopment()
                    ? CookieSecurePolicy.SameAsRequest
                    : CookieSecurePolicy.Always;
                options.ExpireTimeSpan = idleTimeout;
                options.SlidingExpiration = true;

                // An API answers with status codes instead of redirecting to a login page.
                options.Events.OnRedirectToLogin = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                };
                options.Events.OnRedirectToAccessDenied = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return Task.CompletedTask;
                };
            });

        services.AddAuthorizationBuilder()
            // Secure by default: every endpoint requires a signed-in user unless marked [AllowAnonymous].
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build())
            .AddPolicy(AuthPolicies.Trainee, policy => policy.RequireRole(AuthRoles.Trainee))
            .AddPolicy(AuthPolicies.Employee, policy => policy.RequireRole(AuthRoles.Employee))
            .AddPolicy(AuthPolicies.Hr, policy => policy.RequireRole(AuthRoles.Hr))
            .AddPolicy(AuthPolicies.Admin, policy => policy.RequireRole(AuthRoles.Admin));

        return services;
    }
}
