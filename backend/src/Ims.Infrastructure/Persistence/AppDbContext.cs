using Ims.Application.Common.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Ims.Infrastructure.Persistence;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options), IAppDbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Entity configurations live in Persistence/Configurations as IEntityTypeConfiguration<T> classes.
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
