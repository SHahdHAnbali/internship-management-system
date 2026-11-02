using Ims.Domain.Applications;
using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class AssignmentConfiguration : IEntityTypeConfiguration<Assignment>
{
    public void Configure(EntityTypeBuilder<Assignment> builder)
    {
        builder.ToTable("assignments", t => t.HasCheckConstraint("ck_assignments_period", "end_date >= start_date"));
        builder.Property(a => a.EndReason).HasMaxLength(Assignment.EndReasonMaxLength);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(a => a.ApplicationId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(a => a.EmployeeId);
        builder.HasOne<MentorRequest>().WithMany().HasForeignKey(a => a.MentorRequestId);
        builder.HasIndex(a => a.EmployeeId);
        builder.HasIndex(a => a.MentorRequestId).IsUnique();
        // One running training per application at a time.
        builder.HasIndex(a => a.ApplicationId).IsUnique().HasFilter("status = 'Active'")
            .HasDatabaseName("ux_assignments_application_id_active");
    }
}
