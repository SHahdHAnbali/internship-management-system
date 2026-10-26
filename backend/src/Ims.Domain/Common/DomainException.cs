namespace Ims.Domain.Common;

/// <summary>
/// A business rule was violated (invalid state transition, missing reason, …).
/// <see cref="Code"/> is stable and machine-readable so the API can map it to a ProblemDetails type.
/// </summary>
public sealed class DomainException : Exception
{
    public DomainException(string code, string message) : base(message) => Code = code;

    public DomainException()
    {
        Code = "domain.error";
    }

    public DomainException(string message) : base(message) => Code = "domain.error";

    public DomainException(string message, Exception innerException) : base(message, innerException) => Code = "domain.error";

    public string Code { get; }
}
