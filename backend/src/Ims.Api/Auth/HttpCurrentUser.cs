using System.Security.Claims;
using Ims.Application.Common.Security;
using Ims.Domain.Auditing;

namespace Ims.Api.Auth;

/// <summary>
/// The actor of the current HTTP request, read from the session cookie's claims
/// (<see cref="ClaimTypes.NameIdentifier"/> = employee/trainee id, role = <see cref="AuthRoles"/>).
/// </summary>
internal sealed class HttpCurrentUser(IHttpContextAccessor httpContextAccessor) : ICurrentUser
{
    public AuditActorType ActorType
    {
        get
        {
            var user = httpContextAccessor.HttpContext?.User;
            if (user is null)
            {
                return AuditActorType.System;
            }

            if (user.Identity?.IsAuthenticated != true)
            {
                return AuditActorType.Anonymous;
            }

            return user.IsInRole(AuthRoles.Trainee) ? AuditActorType.Trainee : AuditActorType.Staff;
        }
    }

    public Guid? UserId =>
        Guid.TryParse(httpContextAccessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier), out var id) ? id : null;
}
