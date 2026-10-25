namespace Ims.Application.Common.Persistence;

/// <summary>
/// The Application layer's view of the database. Feature use cases depend on this, never on the
/// concrete EF Core context. Expose a <c>DbSet&lt;T&gt;</c> here for each aggregate as entities are introduced.
/// </summary>
public interface IAppDbContext
{
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
