using Ims.Domain.Common;
using Ims.Domain.Trainees;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class TraineeConfiguration : IEntityTypeConfiguration<Trainee>
{
    public void Configure(EntityTypeBuilder<Trainee> builder)
    {
        builder.ToTable("trainees", t => t.HasCheckConstraint("ck_trainees_email_normalized", "email = lower(btrim(email))"));
        builder.Property(t => t.Email).HasMaxLength(EmailAddress.MaxLength);
        builder.HasIndex(t => t.Email).IsUnique();
        builder.Property(t => t.FullName).HasMaxLength(Trainee.NameMaxLength);
        builder.Property(t => t.Phone).HasMaxLength(Trainee.PhoneMaxLength);
        builder.Property(t => t.University).HasMaxLength(Trainee.UniversityMaxLength);
        builder.Property(t => t.Major).HasMaxLength(Trainee.MajorMaxLength);
        builder.Property(t => t.StudyYear).HasMaxLength(Trainee.StudyYearMaxLength);
    }
}
