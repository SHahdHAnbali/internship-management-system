using Ims.Application.Common.Errors;
using Ims.Application.Common.Persistence;
using Ims.Domain.Fields;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Admin.Fields;

/// <summary>
/// Admin: manage training fields (PDF §4). Fields are activated/deactivated, never deleted.
/// Names are unique ignoring case; the database index enforces it and the API returns 409 on a duplicate.
/// </summary>
public sealed class FieldManagement(IAppDbContext db)
{
    public async Task<IReadOnlyList<FieldDto>> ListAsync(CancellationToken cancellationToken)
    {
        return await db.Fields
            .OrderBy(f => f.Name)
            .Select(f => new FieldDto(f.Id, f.Name, f.Description, f.IsActive))
            .ToListAsync(cancellationToken);
    }

    public async Task<FieldDto> CreateAsync(CreateFieldRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var field = Field.Create(request.Name, request.Description);
        db.Fields.Add(field);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(field);
    }

    public async Task<FieldDto> UpdateAsync(Guid id, UpdateFieldRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var field = await db.Fields.SingleOrDefaultAsync(f => f.Id == id, cancellationToken)
            ?? throw NotFoundException.For<Field>(id);
        field.Update(request.Name, request.Description, request.IsActive);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(field);
    }

    private static FieldDto ToDto(Field field) => new(field.Id, field.Name, field.Description, field.IsActive);
}
