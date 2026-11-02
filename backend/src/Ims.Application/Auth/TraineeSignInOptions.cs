namespace Ims.Application.Auth;

/// <summary>Passwordless trainee sign-in by one-time e-mail link or code (PDF §2, §9).</summary>
public sealed class TraineeSignInOptions
{
    public const string SectionName = "Authentication:Trainee";

    /// <summary>Validity of a sign-in link/code. The requirements specify 15 minutes.</summary>
    public int CodeLifetimeMinutes { get; init; } = 15;

    /// <summary>Public URL of the web app; the e-mailed link is <c>{base}/sign-in/verify?token=…</c>.</summary>
    public string SignInLinkBaseUrl { get; init; } = string.Empty;

    /// <summary>Requests per minute per client to the trainee sign-in endpoints (abuse protection).</summary>
    public int RateLimitPerMinute { get; init; } = 10;
}
