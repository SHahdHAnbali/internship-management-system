using Ims.Domain.Auditing;
using Ims.Domain.Evaluations;
using Ims.Domain.Fields;
using Ims.Domain.Notifications;
using Ims.Domain.Roles;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Common.Persistence;

/// <summary>
/// The Application layer's view of the database. Feature use cases depend on this, never on the concrete EF Core context.
/// Expose a <c>DbSet&lt;T&gt;</c> here for each aggregate as entities are introduced.
/// </summary>
public interface IAppDbContext
{
    IQueryable<Role> Roles { get; }

    DbSet<Employee> Employees { get; }

    DbSet<Field> Fields { get; }

    DbSet<EvaluationCriterion> EvaluationCriteria { get; }

    DbSet<NotificationSettings> NotificationSettings { get; }

    /// <summary>Read-only: rows are written by database triggers.</summary>
    IQueryable<AuditLogEntry> AuditLogs { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
