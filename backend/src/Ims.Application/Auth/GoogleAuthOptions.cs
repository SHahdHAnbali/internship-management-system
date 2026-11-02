namespace Ims.Application.Auth;

/// <summary>Staff sign-in with Google, restricted to the company Google Workspace domain (PDF §2, §9).</summary>
public sealed class GoogleAuthOptions
{
    public const string SectionName = "Authentication:Google";

    /// <summary>OAuth 2.0 Web client id; Google ID tokens must be issued for this audience.</summary>
    public string ClientId { get; init; } = string.Empty;

    /// <summary>The company domain (e.g. <c>company.com</c>); accounts from any other domain are refused.</summary>
    public string HostedDomain { get; init; } = string.Empty;

    public bool IsConfigured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(HostedDomain);
}
