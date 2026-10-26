using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Ims.Infrastructure.Persistence.Interceptors;

/// <summary>
/// Fails fast, with a clear message, when code asks EF to delete a tracked entity (Remove, orphan removal).
/// This is a developer guard only — the authoritative protection is the database trigger, which also blocks
/// ExecuteDelete, raw SQL and TRUNCATE (see the InitialSchema migration).
/// </summary>
internal sealed class PreventDeleteInterceptor : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        EnsureNoDeletes(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        EnsureNoDeletes(eventData.Context);
        return ValueTask.FromResult(result);
    }

    private static void EnsureNoDeletes(DbContext? context)
    {
        var deleted = context?.ChangeTracker.Entries().FirstOrDefault(e => e.State == EntityState.Deleted);
        if (deleted is not null)
        {
            throw new InvalidOperationException(
                $"Deleting {deleted.Metadata.ClrType.Name} is not allowed: records are permanent. Change their status instead.");
        }
    }
}
