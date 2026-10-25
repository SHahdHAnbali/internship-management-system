namespace Ims.Api.Auth;

/// <summary>Role claim values. Staff roles mirror <c>StaffRole</c> on the Employee table; trainees have their own identity.</summary>
public static class AuthRoles
{
    public const string Trainee = "Trainee";
    public const string Employee = "Employee";
    public const string Hr = "Hr";
    public const string Admin = "Admin";
}
