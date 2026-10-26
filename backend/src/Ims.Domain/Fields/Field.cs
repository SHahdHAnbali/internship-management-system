using Ims.Domain.Common;

namespace Ims.Domain.Fields;

/// <summary>A training field managed by Admin (PDF §4, §8: name, description, active or not).</summary>
public sealed class Field : Entity
{
    public const int NameMaxLength = 100;
    public const int DescriptionMaxLength = 1000;

    private Field()
    {
        Name = null!;
    }

    public string Name { get; private set; }

    public string? Description { get; private set; }

    public bool IsActive { get; private set; }

    public static Field Create(string name, string? description)
    {
        var field = new Field { IsActive = true };
        field.Update(name, description, isActive: true);
        return field;
    }

    public void Update(string name, string? description, bool isActive)
    {
        Name = Guard.Required(name, "Name", NameMaxLength);
        Description = Guard.Optional(description, "Description", DescriptionMaxLength);
        IsActive = isActive;
    }
}
