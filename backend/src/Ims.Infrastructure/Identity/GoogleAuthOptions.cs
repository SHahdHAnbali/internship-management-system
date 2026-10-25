namespace Ims.Infrastructure.Identity;

/// <summary>Staff sign-in with Google, restricted to the company Google Workspace domain.</summary>
public sealed class GoogleAuthOptions
{
    public const string SectionName = "Authentication:Google";

    /// <summary>OAuth client id used to validate Google ID tokens (audience).</summary>
    public string ClientId { get; init; } = string.Empty;

    /// <summary>Company Google Workspace domain; tokens whose <c>hd</c> claim differs are rejected.</summary>
    public string HostedDomain { get; init; } = string.Empty;
}
