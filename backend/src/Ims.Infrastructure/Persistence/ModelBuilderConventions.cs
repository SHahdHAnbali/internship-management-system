using System.Text;
using Ims.Domain.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace Ims.Infrastructure.Persistence;

/// <summary>
/// Database-wide mapping rules, applied after the per-entity configurations:
/// <list type="bullet">
/// <item>snake_case table/column/key/index names (plain SQL, reports and triggers stay readable);</item>
/// <item>client-generated ids (<see cref="Entity.Id"/>) and an <c>xmin</c> optimistic-concurrency token on every entity;</item>
/// <item>enums stored as text with a CHECK constraint listing the allowed values;</item>
/// <item><see cref="DeleteBehavior.Restrict"/> on every foreign key — nothing ever cascades (records are never deleted).</item>
/// </list>
/// </summary>
internal static class ModelBuilderConventions
{
    public const string ConcurrencyTokenProperty = "Version";

    public static void ApplyDatabaseConventions(this ModelBuilder modelBuilder)
    {
        foreach (var entityType in modelBuilder.Model.GetEntityTypes().ToList())
        {
            if (typeof(Entity).IsAssignableFrom(entityType.ClrType))
            {
                var builder = modelBuilder.Entity(entityType.ClrType);
                builder.Property(nameof(Entity.Id)).ValueGeneratedNever();
                builder.Property<uint>(ConcurrencyTokenProperty).HasColumnName("xmin").HasColumnType("xid").IsRowVersion();
            }

            var table = entityType.GetTableName()
                ?? throw new InvalidOperationException($"{entityType.DisplayName()} must be mapped to a table with ToTable().");

            foreach (var property in entityType.GetProperties())
            {
                if (property.FindAnnotation(RelationalAnnotationNames.ColumnName) is null)
                {
                    property.SetColumnName(ToSnakeCase(property.Name));
                }
            }

            foreach (var property in entityType.GetProperties()
                .Concat(entityType.GetComplexProperties().SelectMany(c => c.ComplexType.GetProperties())))
            {
                var enumType = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                if (enumType.IsEnum)
                {
                    property.SetProviderClrType(typeof(string));
                    property.SetMaxLength(32);
                    var column = property.GetColumnName();
                    var allowed = string.Join(", ", Enum.GetNames(enumType).Select(n => $"'{n}'"));
                    entityType.AddCheckConstraint($"ck_{table}_{column}", $"{column} IN ({allowed})");
                }
            }

            entityType.FindPrimaryKey()?.SetName($"pk_{table}");

            foreach (var foreignKey in entityType.GetForeignKeys())
            {
                foreignKey.DeleteBehavior = DeleteBehavior.Restrict;
                var principalTable = foreignKey.PrincipalEntityType.GetTableName();
                foreignKey.SetConstraintName($"fk_{table}_{principalTable}_{ColumnList(foreignKey.Properties)}");
            }

            foreach (var index in entityType.GetIndexes().Where(i => i.Name is null))
            {
                index.SetDatabaseName($"{(index.IsUnique ? "ux" : "ix")}_{table}_{ColumnList(index.Properties)}");
            }
        }
    }

    public static string ToSnakeCase(string name)
    {
        var builder = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c) && i > 0 && (char.IsLower(name[i - 1]) || char.IsDigit(name[i - 1])))
            {
                builder.Append('_');
            }

            builder.Append(char.ToLowerInvariant(c));
        }

        return builder.ToString();
    }

    private static string ColumnList(IEnumerable<IMutableProperty> properties)
        => string.Join("_", properties.Select(p => p.GetColumnName()));
}
