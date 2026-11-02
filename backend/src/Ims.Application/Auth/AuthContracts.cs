using System.ComponentModel.DataAnnotations;
using Ims.Domain.Common;
using Ims.Domain.Roles;

namespace Ims.Application.Auth;

/// <summary>The signed-in user as returned to the client. A trainee only ever receives their own record.</summary>
public sealed record SessionUser(Guid Id, UserRole Role, string Email, string? Name);

public sealed record GoogleSignInRequest([Required] string IdToken);

public sealed record TraineeCodeRequest([Required, MaxLength(EmailAddress.MaxLength)] string Email);

public sealed record TraineeCodeVerification(
    [MaxLength(EmailAddress.MaxLength)] string? Email,
    [MaxLength(6)] string? Code,
    [MaxLength(64)] string? Token);

/// <summary>Public, non-secret sign-in settings the web app needs to render the sign-in page.</summary>
public sealed record AuthConfiguration(string? GoogleClientId, string? GoogleHostedDomain, int TraineeCodeLifetimeMinutes);

public enum StaffSignInFailure
{
    NotConfigured,
    InvalidToken,
    EmailNotVerified,
    DomainNotAllowed,
}
