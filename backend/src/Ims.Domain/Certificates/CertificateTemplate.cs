namespace Ims.Domain.Certificates;

/// <summary>
/// The certificate template the Admin designs (PDF §4 "manage the certificate template", §5 certificate content).
/// A single row: <see cref="Settings"/> holds the validated design settings as JSON (layout, typography, colours, static
/// texts, element placement); the company logo and the HR signature are stored as images. It never contains trainee
/// data: the trainee/training values are placeholders filled when certificates are issued (a later module).
/// Edited through the Workers API (backend-workers, AD-38, AD-43); this API has no endpoints for it yet.
/// </summary>
public sealed class CertificateTemplate
{
    public const int SingletonId = 1;
    public const int MaxImageBytes = 512 * 1024;

    /// <summary>The image types accepted for the logo and the signature (no SVG: it can carry scripts).</summary>
    public static readonly IReadOnlyList<string> ImageContentTypes = ["image/png", "image/jpeg", "image/webp"];

    private CertificateTemplate()
    {
        Settings = null!;
    }

    public int Id { get; private set; } = SingletonId;

    /// <summary>The design settings as a JSON object (schema owned by backend-workers/src/domain/certificateTemplate.ts).</summary>
    public string Settings { get; private set; }

    public byte[]? LogoImage { get; private set; }

    public string? LogoContentType { get; private set; }

    public byte[]? SignatureImage { get; private set; }

    public string? SignatureContentType { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }
}
