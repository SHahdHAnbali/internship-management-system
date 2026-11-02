using Ims.Domain.Applications;
using Ims.Domain.Fields;
using Ims.Domain.Staff;
using Ims.Domain.Trainees;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class TrainingApplicationConfiguration : IEntityTypeConfiguration<TrainingApplication>
{
    public void Configure(EntityTypeBuilder<TrainingApplication> builder)
    {
        builder.ToTable("training_applications", t =>
        {
            t.HasCheckConstraint("ck_training_applications_period", "available_to >= available_from");
            t.HasCheckConstraint("ck_training_applications_hours", "hours > 0");
            t.HasCheckConstraint(
                "ck_training_applications_rejection_reason",
                "(status = 'Rejected') = (rejection_reason IS NOT NULL)");
            t.HasCheckConstraint(
                "ck_training_applications_decision",
                "(status IN ('Accepted', 'Rejected')) = (decided_at IS NOT NULL AND decided_by_id IS NOT NULL)");
        });
        builder.Property(a => a.RejectionReason).HasMaxLength(TrainingApplication.RejectionReasonMaxLength);
        builder.HasOne<Trainee>().WithMany().HasForeignKey(a => a.TraineeId);
        builder.HasOne<Field>().WithMany().HasForeignKey(a => a.FieldId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(a => a.DecidedById);
        builder.HasIndex(a => a.Status);
    }
}
