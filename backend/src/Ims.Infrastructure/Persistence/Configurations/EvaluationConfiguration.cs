using Ims.Domain.Applications;
using Ims.Domain.Evaluations;
using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EvaluationConfiguration : IEntityTypeConfiguration<Evaluation>
{
    public void Configure(EntityTypeBuilder<Evaluation> builder)
    {
        builder.ToTable("evaluations", t =>
        {
            // A draft has no submitter or submission time; a submitted evaluation has both (AD-66: whoever submits is recorded).
            t.HasCheckConstraint(
                "ck_evaluations_submission",
                "(status = 'Draft' AND submitted_by_id IS NULL AND submitted_at IS NULL) OR " +
                "(status = 'Submitted' AND submitted_by_id IS NOT NULL AND submitted_at IS NOT NULL)");
            // AD-66: the written comment and the hiring recommendation are required at submission (a draft may lack them).
            t.HasCheckConstraint(
                "ck_evaluations_submitted_content",
                "status <> 'Submitted' OR (comment IS NOT NULL AND comment ~ '\\S' AND hiring_recommendation IS NOT NULL)");
            t.HasCheckConstraint("ck_evaluations_version", "version >= 0");
        });
        builder.Property(e => e.Comment).HasMaxLength(Evaluation.CommentMaxLength);
        // `version` (not `Version`, which is the xmin concurrency token of every entity): the editors' change counter.
        // The sentinel makes EF always send the value; the default serves the Worker's inserts.
        builder.Property(e => e.Revision).HasColumnName("version").HasDefaultValue(0).HasSentinel(-1);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(e => e.ApplicationId);
        builder.HasOne<Assignment>().WithMany().HasForeignKey(e => e.AssignmentId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(e => e.SubmittedById);
        // AD-66: exactly one final evaluation per training application, whatever the number of transfers or evaluators.
        builder.HasIndex(e => e.ApplicationId).IsUnique();
    }
}
