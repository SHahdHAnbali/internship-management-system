using Ims.Application.Common.Security;
using Ims.Domain.Auditing;

namespace Ims.Infrastructure.Identity;

/// <summary>Actor for work outside an HTTP request (background jobs, tooling). The API host replaces it per request.</summary>
internal sealed class SystemCurrentUser : ICurrentUser
{
    public AuditActorType ActorType => AuditActorType.System;

    public Guid? UserId => null;
}
