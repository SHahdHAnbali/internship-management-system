using Ims.Domain.Common;
using Ims.Domain.Sessions;

namespace Ims.UnitTests.Domain;

public sealed class UserSessionTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 28, 9, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Lifetime = TimeSpan.FromDays(30);

    [Fact]
    public void A_session_is_active_until_its_absolute_end()
    {
        var session = UserSession.ForEmployee(Guid.CreateVersion7(), Now, Lifetime);

        Assert.Equal(Now.AddDays(30), session.ExpiresAt);
        Assert.True(session.IsActive(Now.AddDays(30).AddSeconds(-1)));
        Assert.False(session.IsActive(Now.AddDays(30)));
    }

    [Fact]
    public void Each_session_has_exactly_one_owner()
    {
        var trainee = UserSession.ForTrainee(Guid.CreateVersion7(), Now, Lifetime);
        var google = UserSession.ForGoogleUser("1234567890", Now, Lifetime);

        Assert.NotNull(trainee.TraineeId);
        Assert.Null(trainee.EmployeeId);
        Assert.Equal("1234567890", google.GoogleSubject);
        Assert.Null(google.EmployeeId);
        Assert.Null(google.TraineeId);
        Assert.Throws<DomainException>(() => UserSession.ForEmployee(Guid.Empty, Now, Lifetime));
        Assert.Throws<DomainException>(() => UserSession.ForGoogleUser(" ", Now, Lifetime));
    }

    [Fact]
    public void Signing_out_revokes_the_session_once()
    {
        var session = UserSession.ForTrainee(Guid.CreateVersion7(), Now, Lifetime);
        session.Revoke(SessionRevokeReason.SignOut, Now.AddHours(1));
        session.Revoke(SessionRevokeReason.SignOut, Now.AddHours(2));

        Assert.False(session.IsActive(Now.AddHours(1)));
        Assert.Equal(Now.AddHours(1), session.RevokedAt);
        Assert.Equal(SessionRevokeReason.SignOut, session.RevokeReason);
    }

    [Fact]
    public void A_session_replaced_by_a_new_sign_in_is_revoked_as_Replaced()
    {
        var session = UserSession.ForEmployee(Guid.CreateVersion7(), Now, Lifetime);
        session.Revoke(SessionRevokeReason.Replaced, Now.AddDays(1));
        session.Revoke(SessionRevokeReason.SignOut, Now.AddDays(2));

        Assert.False(session.IsActive(Now.AddDays(1)));
        Assert.Equal(SessionRevokeReason.Replaced, session.RevokeReason);
    }

    [Fact]
    public void The_lifetime_must_be_positive_and_times_UTC()
    {
        Assert.Throws<DomainException>(() => UserSession.ForTrainee(Guid.CreateVersion7(), Now, TimeSpan.Zero));
        Assert.Throws<DomainException>(() => UserSession.ForTrainee(Guid.CreateVersion7(), Now.ToOffset(TimeSpan.FromHours(3)), Lifetime));
    }
}
