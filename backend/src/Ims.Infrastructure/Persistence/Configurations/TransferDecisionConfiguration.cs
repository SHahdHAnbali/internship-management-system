using Ims.Domain.Applications;
using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class TransferDecisionConfiguration : IEntityTypeConfiguration<TransferDecision>
{
    public void Configure(EntityTypeBuilder<TransferDecision> builder)
    {
        builder.ToTable("transfer_decisions", t =>
        {
            // Resolved exactly when it leaves Pending; a cancellation has its HR member and reason, a void its code.
            t.HasCheckConstraint("ck_transfer_decisions_resolved", "(status = 'Pending') = (resolved_at IS NULL)");
            t.HasCheckConstraint(
                "ck_transfer_decisions_cancelled",
                "status <> 'Cancelled' OR (resolved_by_id IS NOT NULL AND resolution_reason IS NOT NULL)");
            t.HasCheckConstraint("ck_transfer_decisions_void", "status <> 'Void' OR resolution_code IS NOT NULL");
        });
        builder.Property(d => d.Reason).HasMaxLength(Assignment.EndReasonMaxLength);
        builder.Property(d => d.ResolutionReason).HasMaxLength(Assignment.EndReasonMaxLength);
        builder.Property(d => d.ResolutionCode).HasMaxLength(TransferDecision.ResolutionCodeMaxLength);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(d => d.ApplicationId);
        builder.HasOne<Assignment>().WithMany().HasForeignKey(d => d.FromAssignmentId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(d => d.IncomingEmployeeId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(d => d.DecidedById);
        builder.HasOne<Employee>().WithMany().HasForeignKey(d => d.ResolvedById);
        // At most one pending transfer per training application, enforced by the database under concurrency.
        builder.HasIndex(d => d.ApplicationId).IsUnique().HasFilter("status = 'Pending'");
        builder.HasIndex(d => d.FromAssignmentId);
        // The scheduled job's lookup of the due decisions.
        builder.HasIndex(d => new { d.Status, d.EffectiveDate });
    }
}
