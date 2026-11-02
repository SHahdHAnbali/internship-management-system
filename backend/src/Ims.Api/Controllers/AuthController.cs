using Ims.Api.Auth;
using Ims.Application.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using System.Security.Claims;

namespace Ims.Api.Controllers;

/// <summary>Sign-in for staff (Google, company domain) and trainees (one-time e-mail link or code), session, sign-out.</summary>
[ApiController]
[Route("api/auth")]
public sealed class AuthController(
    StaffSignIn staffSignIn,
    TraineeSignIn traineeSignIn,
    SessionLookup sessions,
    IOptions<GoogleAuthOptions> google,
    IOptions<TraineeSignInOptions> trainee) : ControllerBase
{
    public const string TraineeRateLimitPolicy = "trainee-sign-in";

    [AllowAnonymous]
    [HttpGet("config")]
    public AuthConfiguration Config() => new(
        google.Value.IsConfigured ? google.Value.ClientId : null,
        google.Value.IsConfigured ? google.Value.HostedDomain : null,
        trainee.Value.CodeLifetimeMinutes);

    [AllowAnonymous]
    [HttpPost("staff/google")]
    public async Task<ActionResult<SessionUser>> GoogleSignIn(GoogleSignInRequest request, CancellationToken cancellationToken)
    {
        var (user, failure) = await staffSignIn.SignInAsync(request.IdToken, cancellationToken);
        if (user is null)
        {
            return failure switch
            {
                StaffSignInFailure.NotConfigured => Failure(StatusCodes.Status503ServiceUnavailable, "auth.google_not_configured",
                    "Google sign-in is not configured on the server."),
                StaffSignInFailure.DomainNotAllowed => Failure(StatusCodes.Status403Forbidden, "auth.domain_not_allowed",
                    "Only accounts of the company domain can sign in."),
                StaffSignInFailure.EmailNotVerified => Failure(StatusCodes.Status401Unauthorized, "auth.email_not_verified",
                    "The Google account's e-mail is not verified."),
                _ => Failure(StatusCodes.Status401Unauthorized, "auth.invalid_token", "The Google sign-in could not be verified."),
            };
        }

        await SessionCookie.SignInAsync(HttpContext, user);
        return user;
    }

    [AllowAnonymous]
    [EnableRateLimiting(TraineeRateLimitPolicy)]
    [HttpPost("trainee/request")]
    public async Task<IActionResult> RequestTraineeCode(TraineeCodeRequest request, CancellationToken cancellationToken)
    {
        await traineeSignIn.RequestAsync(request.Email, cancellationToken);
        return Accepted();
    }

    [AllowAnonymous]
    [EnableRateLimiting(TraineeRateLimitPolicy)]
    [HttpPost("trainee/verify")]
    public async Task<ActionResult<SessionUser>> VerifyTrainee(TraineeCodeVerification request, CancellationToken cancellationToken)
    {
        SessionUser? user;
        if (!string.IsNullOrWhiteSpace(request.Token))
        {
            user = await traineeSignIn.VerifyTokenAsync(request.Token, cancellationToken);
        }
        else if (!string.IsNullOrWhiteSpace(request.Email) && !string.IsNullOrWhiteSpace(request.Code))
        {
            user = await traineeSignIn.VerifyCodeAsync(request.Email, request.Code, cancellationToken);
        }
        else
        {
            return Failure(StatusCodes.Status400BadRequest, "validation.required", "Provide either the link token, or the e-mail and code.");
        }

        if (user is null)
        {
            return Failure(StatusCodes.Status400BadRequest, "auth.invalid_code", "The sign-in link or code is invalid, expired or already used.");
        }

        await SessionCookie.SignInAsync(HttpContext, user);
        return user;
    }

    /// <summary>The signed-in user's own account (fresh from the database). Never exposes other users.</summary>
    [HttpGet("me")]
    public async Task<ActionResult<SessionUser>> Me(CancellationToken cancellationToken)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await sessions.FindAsync(userId, User.IsInRole(AuthRoles.Trainee), cancellationToken);
        return user is null ? Unauthorized() : user;
    }

    [AllowAnonymous]
    [HttpPost("sign-out")]
    public async Task<IActionResult> SignOutSession()
    {
        await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        return NoContent();
    }

    private static ObjectResult Failure(int status, string code, string detail)
        => new(new ProblemDetails { Status = status, Detail = detail, Extensions = { ["code"] = code } }) { StatusCode = status };
}
