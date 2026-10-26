using Ims.Domain.Common;
using Ims.Domain.Roles;

namespace Ims.Domain.Staff;

/// <summary>
/// A company staff member who signs in with Google (PDF §8: name, Google email, department, role).
/// New accounts from the company domain are created with the Employee role; higher roles are granted by Admin (PDF §2).
/// </summary>
public sealed class Employee : Entity
{
    public const int NameMaxLength = 200;
    public const int DepartmentMaxLength = 200;

    /// <summary>The roles a staff member can hold (PDF §8: Employee / HR / Admin).</summary>
    public static readonly IReadOnlyList<UserRole> StaffRoles = [UserRole.Employee, UserRole.HR, UserRole.Admin];

    private Employee()
    {
        Email = null!;
        FullName = null!;
    }

    public string FullName { get; private set; }

    public string Email { get; private set; }

    public string? Department { get; private set; }

    public UserRole Role { get; private set; }

    public static Employee CreateOnFirstSignIn(string email, string fullName)
    {
        return new Employee
        {
            Email = EmailAddress.Normalize(email),
            FullName = Guard.Required(fullName, "Full name", NameMaxLength),
            Role = UserRole.Employee,
        };
    }

    public void ChangeRole(UserRole role)
    {
        if (!StaffRoles.Contains(role))
        {
            throw new DomainException("employee.invalid_role", "A staff member's role must be Employee, HR or Admin.");
        }

        Role = role;
    }
}
