using Ims.Domain.Common;

namespace Ims.Domain.Trainees;

/// <summary>
/// A one-time sign-in link and code e-mailed to a trainee (PDF §2, §9: link or code, valid for 15 minutes).
/// Only hashes are stored. It is usable once, until it expires, is replaced by a newer request,
/// or has had <see cref="MaxFailedAttempts"/> wrong codes entered.
/// </summary>
public sealed class TraineeSignInCode : Entity
{
    public const int MaxFailedAttempts = 5;

    private TraineeSignInCode()
    {
        Email = null!;
        TokenHash = null!;
        CodeHash = null!;
    }

    public string Email { get; private set; }

    /// <summary>SHA-256 of the secret in the sign-in link.</summary>
    public string TokenHash { get; private set; }

    /// <summary>SHA-256 of this record's id and the numeric code.</summary>
    public string CodeHash { get; private set; }

    public DateTimeOffset IssuedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? UsedAt { get; private set; }

    public DateTimeOffset? SupersededAt { get; private set; }

    public int FailedAttempts { get; private set; }

    public static TraineeSignInCode Issue(Guid id, string email, string tokenHash, string codeHash, DateTimeOffset now, TimeSpan lifetime)
    {
        if (lifetime <= TimeSpan.Zero)
        {
            throw new DomainException("validation.range", "The sign-in code lifetime must be positive.");
        }

        return new TraineeSignInCode
        {
            Id = id,
            Email = EmailAddress.Normalize(email),
            TokenHash = Guard.Required(tokenHash, "Token hash", 64),
            CodeHash = Guard.Required(codeHash, "Code hash", 64),
            IssuedAt = Guard.Utc(now),
            ExpiresAt = now + lifetime,
        };
    }

    public bool IsUsable(DateTimeOffset now) =>
        UsedAt is null && SupersededAt is null && FailedAttempts < MaxFailedAttempts && now < ExpiresAt;

    public void MarkUsed(DateTimeOffset now)
    {
        if (!IsUsable(now))
        {
            throw new DomainException("auth.code_unusable", "The sign-in code is expired or already used.");
        }

        UsedAt = Guard.Utc(now);
    }

    public void RecordFailedAttempt() => FailedAttempts++;

    /// <summary>A newer code was requested for the same e-mail; only the latest one stays valid.</summary>
    public void Supersede(DateTimeOffset now) => SupersededAt ??= Guard.Utc(now);
}
