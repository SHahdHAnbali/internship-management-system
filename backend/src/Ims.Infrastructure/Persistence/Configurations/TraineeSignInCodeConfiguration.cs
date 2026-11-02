using Ims.Domain.Common;
using Ims.Domain.Trainees;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class TraineeSignInCodeConfiguration : IEntityTypeConfiguration<TraineeSignInCode>
{
    public void Configure(EntityTypeBuilder<TraineeSignInCode> builder)
    {
        builder.ToTable("trainee_sign_in_codes", t =>
        {
            t.HasCheckConstraint("ck_trainee_sign_in_codes_expiry", "expires_at > issued_at");
            t.HasCheckConstraint("ck_trainee_sign_in_codes_attempts", $"failed_attempts BETWEEN 0 AND {TraineeSignInCode.MaxFailedAttempts}");
        });
        builder.Property(c => c.Email).HasMaxLength(EmailAddress.MaxLength);
        builder.Property(c => c.TokenHash).HasMaxLength(64).IsFixedLength();
        builder.Property(c => c.CodeHash).HasMaxLength(64).IsFixedLength();
        builder.HasIndex(c => c.TokenHash).IsUnique();
        builder.HasIndex(c => new { c.Email, c.IssuedAt });
    }
}
