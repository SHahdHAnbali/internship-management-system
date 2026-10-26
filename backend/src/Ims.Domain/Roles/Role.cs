namespace Ims.Domain.Roles;

/// <summary>Reference row in the <c>roles</c> table, one per <see cref="UserRole"/>. Seeded by migration, never edited.</summary>
public sealed class Role
{
    public Role(UserRole code) => Code = code;

    public UserRole Code { get; private set; }
}
