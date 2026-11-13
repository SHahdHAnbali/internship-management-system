using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class AssignmentTransferConfiguration : IEntityTypeConfiguration<AssignmentTransfer>
{
    public void Configure(EntityTypeBuilder<AssignmentTransfer> builder)
    {
        builder.ToTable(
            "assignment_transfers",
            t => t.HasCheckConstraint("ck_assignment_transfers_distinct", "from_assignment_id <> to_assignment_id"));
        builder.HasOne<Assignment>().WithMany().HasForeignKey(t => t.FromAssignmentId);
        builder.HasOne<Assignment>().WithMany().HasForeignKey(t => t.ToAssignmentId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(t => t.TransferredById);
        builder.HasOne<TransferDecision>().WithMany().HasForeignKey(t => t.DecisionId);
        builder.HasIndex(t => t.DecisionId).IsUnique();
        builder.HasIndex(t => t.FromAssignmentId).IsUnique();
        builder.HasIndex(t => t.ToAssignmentId).IsUnique();
    }
}
