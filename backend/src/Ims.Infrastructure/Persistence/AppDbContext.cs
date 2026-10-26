using Ims.Application.Common.Persistence;
using Ims.Domain.Auditing;
using Ims.Domain.Evaluations;
using Ims.Domain.Fields;
using Ims.Domain.Notifications;
using Ims.Domain.Roles;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;

namespace Ims.Infrastructure.Persistence;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options), IAppDbContext
{
    public IQueryable<Role> Roles => Set<Role>().AsNoTracking();

    public DbSet<Employee> Employees => Set<Employee>();

    public DbSet<Field> Fields => Set<Field>();

    public DbSet<EvaluationCriterion> EvaluationCriteria => Set<EvaluationCriterion>();

    public DbSet<NotificationSettings> NotificationSettings => Set<NotificationSettings>();

    public IQueryable<AuditLogEntry> AuditLogs => Set<AuditLogEntry>().AsNoTracking();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Entity configurations live in Persistence/Configurations as IEntityTypeConfiguration<T> classes.
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
        modelBuilder.ApplyDatabaseConventions();
    }
}
