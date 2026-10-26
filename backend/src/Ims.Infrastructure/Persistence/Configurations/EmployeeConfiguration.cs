using Ims.Domain.Common;
using Ims.Domain.Roles;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EmployeeConfiguration : IEntityTypeConfiguration<Employee>
{
    public void Configure(EntityTypeBuilder<Employee> builder)
    {
        builder.ToTable("employees", t =>
        {
            t.HasCheckConstraint("ck_employees_email_normalized", "email = lower(btrim(email))");
            // PDF §8: an employee's role is Employee, HR or Admin.
            t.HasCheckConstraint("ck_employees_staff_role", "role IN ('Employee', 'HR', 'Admin')");
        });
        builder.Property(e => e.FullName).HasMaxLength(Employee.NameMaxLength);
        builder.Property(e => e.Email).HasMaxLength(EmailAddress.MaxLength);
        builder.Property(e => e.Department).HasMaxLength(Employee.DepartmentMaxLength);
        builder.HasOne<Role>().WithMany().HasForeignKey(e => e.Role);
        builder.HasIndex(e => e.Email).IsUnique();
    }
}
