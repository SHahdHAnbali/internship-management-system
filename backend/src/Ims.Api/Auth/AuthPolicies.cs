namespace Ims.Api.Auth;

/// <summary>Authorization policy names used with <c>[Authorize(Policy = ...)]</c>.</summary>
public static class AuthPolicies
{
    public const string Trainee = nameof(Trainee);
    public const string Employee = nameof(Employee);
    public const string Hr = nameof(Hr);
    public const string Admin = nameof(Admin);
}
