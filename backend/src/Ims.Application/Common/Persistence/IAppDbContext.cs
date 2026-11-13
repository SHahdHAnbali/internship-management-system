using Ims.Domain.Applications;
using Ims.Domain.Auditing;
using Ims.Domain.Certificates;
using Ims.Domain.Evaluations;
using Ims.Domain.Fields;
using Ims.Domain.Mentoring;
using Ims.Domain.Notifications;
using Ims.Domain.Roles;
using Ims.Domain.Sessions;
using Ims.Domain.Staff;
using Ims.Domain.Trainees;
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

    DbSet<Trainee> Trainees { get; }

    DbSet<TraineeSignInCode> TraineeSignInCodes { get; }

    DbSet<Field> Fields { get; }

    DbSet<EvaluationCriterion> EvaluationCriteria { get; }

    DbSet<NotificationSettings> NotificationSettings { get; }

    DbSet<CertificateTemplate> CertificateTemplates { get; }

    DbSet<UserSession> UserSessions { get; }

    DbSet<TrainingApplication> TrainingApplications { get; }

    DbSet<ApplicationAttachment> ApplicationAttachments { get; }

    DbSet<ContactLog> ContactLogs { get; }

    DbSet<MentorRequest> MentorRequests { get; }

    DbSet<Assignment> Assignments { get; }

    DbSet<ProgressNote> ProgressNotes { get; }

    DbSet<AssignmentExtension> AssignmentExtensions { get; }

    DbSet<AssignmentTransfer> AssignmentTransfers { get; }

    DbSet<TransferDecision> TransferDecisions { get; }

    DbSet<ResponsibleHrChange> ResponsibleHrChanges { get; }

    DbSet<Notification> Notifications { get; }

    /// <summary>Read-only: rows are written by database triggers.</summary>
    IQueryable<AuditLogEntry> AuditLogs { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
