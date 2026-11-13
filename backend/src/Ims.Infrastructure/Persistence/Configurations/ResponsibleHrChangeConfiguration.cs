using Ims.Domain.Applications;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class ResponsibleHrChangeConfiguration : IEntityTypeConfiguration<ResponsibleHrChange>
{
    public void Configure(EntityTypeBuilder<ResponsibleHrChange> builder)
    {
        builder.ToTable(
            "responsible_hr_changes",
            t => t.HasCheckConstraint("ck_responsible_hr_changes_sequence", "sequence >= 1"));
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(c => c.ApplicationId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(c => c.HrId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(c => c.ChangedById);
        builder.HasIndex(c => new { c.ApplicationId, c.Sequence }).IsUnique();
    }
}
