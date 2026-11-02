using Google.Apis.Auth;
using Ims.Application.Auth;
using Ims.Application.Common.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Ims.Infrastructure.Identity;

/// <summary>Validates Google ID tokens with Google's public keys (signature, issuer, expiry) and the configured client id.</summary>
internal sealed partial class GoogleIdTokenValidator(IOptions<GoogleAuthOptions> options, ILogger<GoogleIdTokenValidator> logger)
    : IGoogleIdTokenValidator
{
    public async Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken cancellationToken)
    {
        try
        {
            var payload = await GoogleJsonWebSignature.ValidateAsync(
                idToken,
                new GoogleJsonWebSignature.ValidationSettings { Audience = [options.Value.ClientId] });
            return new GoogleIdentity(payload.Email, payload.EmailVerified, payload.Name, payload.HostedDomain);
        }
        catch (InvalidJwtException exception)
        {
            LogRejected(logger, exception.Message);
            return null;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Rejected Google ID token: {Reason}")]
    private static partial void LogRejected(ILogger logger, string reason);
}
