using System.ComponentModel.DataAnnotations;
using Ims.Domain.Fields;

namespace Ims.Application.Admin.Fields;

public sealed record FieldDto(Guid Id, string Name, string? Description, bool IsActive);

public sealed record CreateFieldRequest(
    [Required, MaxLength(Field.NameMaxLength)] string Name,
    [MaxLength(Field.DescriptionMaxLength)] string? Description);

public sealed record UpdateFieldRequest(
    [Required, MaxLength(Field.NameMaxLength)] string Name,
    [MaxLength(Field.DescriptionMaxLength)] string? Description,
    bool IsActive);
