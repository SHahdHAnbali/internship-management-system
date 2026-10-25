namespace Ims.Infrastructure.Identity;

/// <summary>Passwordless trainee sign-in by one-time email link or code.</summary>
public sealed class TraineeSignInOptions
{
    public const string SectionName = "Authentication:Trainee";

    /// <summary>Validity of a sign-in link/code. The requirements specify 15 minutes.</summary>
    public int CodeLifetimeMinutes { get; init; } = 15;
}
