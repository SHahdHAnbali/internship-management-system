using System.Security.Claims;
using Ims.Application.Auth;
using Ims.Domain.Roles;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace Ims.Api.Auth;

/// <summary>Issues and re-validates the HttpOnly session cookie for staff and trainees (AD-12).</summary>
internal static class SessionCookie
{
    public static ClaimsPrincipal CreatePrincipal(SessionUser user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Role, user.Role.ToString()),
            new(ClaimTypes.Email, user.Email),
        };
        if (user.Name is not null)
        {
            claims.Add(new Claim(ClaimTypes.Name, user.Name));
        }

        return new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme));
    }

    public static Task SignInAsync(HttpContext httpContext, SessionUser user)
        => httpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, CreatePrincipal(user));

    /// <summary>
    /// Runs on every authenticated request: the account must still exist, and its role is re-read from PostgreSQL, so a
    /// role granted or removed by an Admin applies immediately (not only after the next sign-in).
    /// </summary>
    public static async Task ValidateAsync(CookieValidatePrincipalContext context)
    {
        var principal = context.Principal;
        var roleClaim = principal?.FindFirstValue(ClaimTypes.Role);
        if (!Guid.TryParse(principal?.FindFirstValue(ClaimTypes.NameIdentifier), out var userId) || roleClaim is null)
        {
            await RejectAsync(context);
            return;
        }

        var lookup = context.HttpContext.RequestServices.GetRequiredService<SessionLookup>();
        var user = await lookup.FindAsync(userId, roleClaim == nameof(UserRole.Trainee), context.HttpContext.RequestAborted);
        if (user is null)
        {
            await RejectAsync(context);
            return;
        }

        if (user.Role.ToString() != roleClaim)
        {
            context.ReplacePrincipal(CreatePrincipal(user));
            context.ShouldRenew = true;
        }
    }

    private static async Task RejectAsync(CookieValidatePrincipalContext context)
    {
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    }
}
