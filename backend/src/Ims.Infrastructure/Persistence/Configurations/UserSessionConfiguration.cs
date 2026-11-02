using Ims.Domain.Sessions;
using Ims.Domain.Staff;
using Ims.Domain.Trainees;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class UserSessionConfiguration : IEntityTypeConfiguration<UserSession>
{
    public void Configure(EntityTypeBuilder<UserSession> builder)
    {
        builder.ToTable("user_sessions", t =>
        {
            t.HasCheckConstraint(
                "ck_user_sessions_one_owner",
                "num_nonnulls(employee_id, trainee_id, google_subject) = 1");
            t.HasCheckConstraint("ck_user_sessions_expiry", "expires_at > created_at");
            t.HasCheckConstraint(
                "ck_user_sessions_revocation",
                "(revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)");
        });
        builder.Property(s => s.GoogleSubject).HasMaxLength(UserSession.GoogleSubjectMaxLength);
        builder.HasOne<Employee>().WithMany().HasForeignKey(s => s.EmployeeId);
        builder.HasOne<Trainee>().WithMany().HasForeignKey(s => s.TraineeId);
        builder.HasIndex(s => s.GoogleSubject);
    }
}
