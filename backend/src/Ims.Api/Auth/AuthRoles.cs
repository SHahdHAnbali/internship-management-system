using Ims.Domain.Roles;

namespace Ims.Api.Auth;

/// <summary>Role claim values: exactly the codes in the <c>roles</c> table (<see cref="UserRole"/>).</summary>
public static class AuthRoles
{
    public const string Trainee = nameof(UserRole.Trainee);
    public const string Employee = nameof(UserRole.Employee);
    public const string Hr = nameof(UserRole.HR);
    public const string Admin = nameof(UserRole.Admin);
}
