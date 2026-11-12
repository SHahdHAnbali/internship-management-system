using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class AssignmentExtensionConfiguration : IEntityTypeConfiguration<AssignmentExtension>
{
    public void Configure(EntityTypeBuilder<AssignmentExtension> builder)
    {
        builder.ToTable("assignment_extensions", t =>
        {
            t.HasCheckConstraint("ck_assignment_extensions_later", "new_end_date > previous_end_date");
            t.HasCheckConstraint("ck_assignment_extensions_reason", "btrim(reason) <> ''");
        });
        builder.Property(e => e.Reason).HasMaxLength(AssignmentExtension.ReasonMaxLength);
        builder.HasOne<Assignment>().WithMany().HasForeignKey(e => e.AssignmentId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(e => e.ExtendedById);
    }
}
