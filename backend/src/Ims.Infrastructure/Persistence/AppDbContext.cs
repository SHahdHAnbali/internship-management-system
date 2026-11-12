using Ims.Application.Common.Persistence;
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

namespace Ims.Infrastructure.Persistence;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options), IAppDbContext
{
    public IQueryable<Role> Roles => Set<Role>().AsNoTracking();

    public DbSet<Employee> Employees => Set<Employee>();

    public DbSet<Trainee> Trainees => Set<Trainee>();

    public DbSet<TraineeSignInCode> TraineeSignInCodes => Set<TraineeSignInCode>();

    public DbSet<Field> Fields => Set<Field>();

    public DbSet<EvaluationCriterion> EvaluationCriteria => Set<EvaluationCriterion>();

    public DbSet<NotificationSettings> NotificationSettings => Set<NotificationSettings>();

    public DbSet<CertificateTemplate> CertificateTemplates => Set<CertificateTemplate>();

    public DbSet<UserSession> UserSessions => Set<UserSession>();

    public DbSet<TrainingApplication> TrainingApplications => Set<TrainingApplication>();

    public DbSet<ApplicationAttachment> ApplicationAttachments => Set<ApplicationAttachment>();

    public DbSet<ContactLog> ContactLogs => Set<ContactLog>();

    public DbSet<MentorRequest> MentorRequests => Set<MentorRequest>();

    public DbSet<Assignment> Assignments => Set<Assignment>();

    public DbSet<ProgressNote> ProgressNotes => Set<ProgressNote>();

    public DbSet<AssignmentExtension> AssignmentExtensions => Set<AssignmentExtension>();

    public DbSet<Notification> Notifications => Set<Notification>();

    public IQueryable<AuditLogEntry> AuditLogs => Set<AuditLogEntry>().AsNoTracking();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Entity configurations live in Persistence/Configurations as IEntityTypeConfiguration<T> classes.
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
        modelBuilder.ApplyDatabaseConventions();
    }
}
