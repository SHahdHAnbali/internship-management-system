namespace Ims.Domain.Roles;

/// <summary>The four system roles (PDF §2). Staff are Employee, HR or Admin; trainees always have the Trainee role.</summary>
public enum UserRole
{
    Admin,
    HR,
    Trainee,
    Employee,
}
