using Ims.Domain.Common;

namespace Ims.Domain.Sessions;

/// <summary>
/// A signed-in browser session (AD-44). The encrypted session cookie names this record; the record holds what the
/// cookie cannot: the absolute end of the session and its revocation. The idle timeout lives in the cookie, which is
/// re-issued while the session is used but never past <see cref="ExpiresAt"/>. Exactly one owner: a staff member, a
/// trainee, or an ordinary Google user (who has no other record). Never deleted: sign-out, or a new sign-in in the same
/// browser, sets <see cref="RevokedAt"/>.
/// </summary>
public sealed class UserSession : Entity
{
    public const int GoogleSubjectMaxLength = 255;

    private UserSession()
    {
    }

    public Guid? EmployeeId { get; private set; }

    public Guid? TraineeId { get; private set; }

    /// <summary>The Google <c>sub</c> of an ordinary (role-less) Google user.</summary>
    public string? GoogleSubject { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Absolute end: activity never extends a session beyond it.</summary>
    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }

    public SessionRevokeReason? RevokeReason { get; private set; }

    public static UserSession ForEmployee(Guid employeeId, DateTimeOffset now, TimeSpan lifetime) =>
        Start(now, lifetime, s => s.EmployeeId = Guard.NotEmpty(employeeId, "Employee"));

    public static UserSession ForTrainee(Guid traineeId, DateTimeOffset now, TimeSpan lifetime) =>
        Start(now, lifetime, s => s.TraineeId = Guard.NotEmpty(traineeId, "Trainee"));

    public static UserSession ForGoogleUser(string subject, DateTimeOffset now, TimeSpan lifetime) =>
        Start(now, lifetime, s => s.GoogleSubject = Guard.Required(subject, "Google subject", GoogleSubjectMaxLength));

    public bool IsActive(DateTimeOffset now) => RevokedAt is null && now < ExpiresAt;

    /// <summary>Ends the session (e.g. sign-out). Revoking an already revoked session keeps the first reason.</summary>
    public void Revoke(SessionRevokeReason reason, DateTimeOffset now)
    {
        Guard.Defined(reason, "Revoke reason");
        if (RevokedAt is not null)
        {
            return;
        }

        RevokedAt = Guard.Utc(now);
        RevokeReason = reason;
    }

    private static UserSession Start(DateTimeOffset now, TimeSpan lifetime, Action<UserSession> owner)
    {
        if (lifetime <= TimeSpan.Zero)
        {
            throw new DomainException("validation.range", "The session lifetime must be positive.");
        }

        var session = new UserSession { CreatedAt = Guard.Utc(now), ExpiresAt = now + lifetime };
        owner(session);
        return session;
    }
}

public enum SessionRevokeReason
{
    /// <summary>The user signed out.</summary>
    SignOut,

    /// <summary>A new sign-in in the same browser replaced this session.</summary>
    Replaced,
}
