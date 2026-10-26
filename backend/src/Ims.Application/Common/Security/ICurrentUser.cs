using Ims.Domain.Auditing;

namespace Ims.Application.Common.Security;

/// <summary>The actor behind the current operation; recorded on every audited database change.</summary>
public interface ICurrentUser
{
    AuditActorType ActorType { get; }

    /// <summary>Employee id (staff) or trainee id; <c>null</c> for anonymous and system actors.</summary>
    Guid? UserId { get; }
}
