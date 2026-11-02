namespace Ims.Application.Common.Security;

/// <summary>Verifies a Google ID token (signature, issuer, expiry, audience). Returns null when the token is not valid.</summary>
public interface IGoogleIdTokenValidator
{
    Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken cancellationToken);
}

/// <param name="HostedDomain">The Google Workspace domain of the account (the token's <c>hd</c> claim), if any.</param>
public sealed record GoogleIdentity(string Email, bool EmailVerified, string? Name, string? HostedDomain);
