using Ims.Domain.Applications;
using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class MentorRequestConfiguration : IEntityTypeConfiguration<MentorRequest>
{
    public void Configure(EntityTypeBuilder<MentorRequest> builder)
    {
        builder.ToTable("mentor_requests", t => t.HasCheckConstraint(
            "ck_mentor_requests_decision",
            "(status IN ('Approved', 'Rejected')) = (decided_at IS NOT NULL AND decided_by_id IS NOT NULL)"));
        builder.Property(r => r.Note).HasMaxLength(MentorRequest.NoteMaxLength);
        builder.HasOne<Employee>().WithMany().HasForeignKey(r => r.EmployeeId);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(r => r.ApplicationId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(r => r.DecidedById);
    }
}
