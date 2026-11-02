using Ims.Domain.Common;

namespace Ims.Domain.Applications;

/// <summary>
/// A file attached to an application (PDF §4: the CV and any university letter). The file itself is in private object
/// storage (Cloudflare R2, owner decision 2026-10-29) under <see cref="StorageKey"/>; this row holds its reference and
/// metadata. Never deleted.
/// </summary>
public sealed class ApplicationAttachment : Entity
{
    public const int FileNameMaxLength = 255;
    public const int ContentTypeMaxLength = 255;
    public const int StorageKeyMaxLength = 200;

    private ApplicationAttachment()
    {
        FileName = null!;
        ContentType = null!;
        Sha256 = null!;
        StorageKey = null!;
    }

    public Guid ApplicationId { get; private set; }

    public AttachmentKind Kind { get; private set; }

    public string FileName { get; private set; }

    public string ContentType { get; private set; }

    public long SizeBytes { get; private set; }

    /// <summary>SHA-256 of the content, lower-case hex.</summary>
    public string Sha256 { get; private set; }

    public string StorageKey { get; private set; }

    public DateTimeOffset UploadedAt { get; private set; }

    public static ApplicationAttachment Create(
        Guid id,
        Guid applicationId,
        AttachmentKind kind,
        string fileName,
        string contentType,
        long sizeBytes,
        string sha256,
        string storageKey,
        DateTimeOffset now)
    {
        Guard.Defined(kind, "Attachment kind");
        if (sizeBytes <= 0)
        {
            throw new DomainException("attachment.empty", "The file is empty.");
        }

        return new ApplicationAttachment
        {
            Id = Guard.NotEmpty(id, "Attachment"),
            ApplicationId = Guard.NotEmpty(applicationId, "Application"),
            Kind = kind,
            FileName = Guard.Required(fileName, "File name", FileNameMaxLength),
            ContentType = Guard.Required(contentType, "Content type", ContentTypeMaxLength),
            SizeBytes = sizeBytes,
            Sha256 = Guard.Required(sha256, "Checksum", 64),
            StorageKey = Guard.Required(storageKey, "Storage key", StorageKeyMaxLength),
            UploadedAt = Guard.Utc(now),
        };
    }
}

public enum AttachmentKind
{
    Cv,
    UniversityLetter,
}
