namespace Ims.Domain.Common;

internal static class Guard
{
    public static string Required(string? value, string name, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new DomainException("validation.required", $"{name} is required.");
        }

        return MaxLength(value.Trim(), name, maxLength);
    }

    public static string? Optional(string? value, string name, int maxLength)
    {
        return string.IsNullOrWhiteSpace(value) ? null : MaxLength(value.Trim(), name, maxLength);
    }

    public static Guid NotEmpty(Guid value, string name)
    {
        return value == Guid.Empty
            ? throw new DomainException("validation.required", $"{name} is required.")
            : value;
    }

    /// <summary>PostgreSQL <c>timestamptz</c> via Npgsql only accepts UTC offsets; catch mistakes at the source.</summary>
    public static DateTimeOffset Utc(DateTimeOffset value, string name = "Timestamp")
    {
        return value.Offset == TimeSpan.Zero
            ? value
            : throw new DomainException("validation.utc", $"{name} must be in UTC.");
    }

    public static void Defined<TEnum>(TEnum value, string name) where TEnum : struct, Enum
    {
        if (!Enum.IsDefined(value))
        {
            throw new DomainException("validation.invalid", $"{name} has an invalid value.");
        }
    }

    private static string MaxLength(string value, string name, int maxLength)
    {
        return value.Length <= maxLength
            ? value
            : throw new DomainException("validation.too_long", $"{name} must be at most {maxLength} characters.");
    }
}
