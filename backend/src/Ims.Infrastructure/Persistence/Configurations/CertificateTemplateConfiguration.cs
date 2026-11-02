using Ims.Domain.Certificates;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class CertificateTemplateConfiguration : IEntityTypeConfiguration<CertificateTemplate>
{
    public void Configure(EntityTypeBuilder<CertificateTemplate> builder)
    {
        var types = string.Join(", ", CertificateTemplate.ImageContentTypes.Select(t => $"'{t}'"));
        builder.ToTable("certificate_templates", t =>
        {
            t.HasCheckConstraint("ck_certificate_templates_single_row", $"id = {CertificateTemplate.SingletonId}");
            t.HasCheckConstraint("ck_certificate_templates_settings_object", "jsonb_typeof(settings) = 'object'");
            t.HasCheckConstraint(
                "ck_certificate_templates_logo",
                $"(logo_image IS NULL AND logo_content_type IS NULL) OR (logo_image IS NOT NULL AND logo_content_type IN ({types}) AND octet_length(logo_image) BETWEEN 1 AND {CertificateTemplate.MaxImageBytes})");
            t.HasCheckConstraint(
                "ck_certificate_templates_signature",
                $"(signature_image IS NULL AND signature_content_type IS NULL) OR (signature_image IS NOT NULL AND signature_content_type IN ({types}) AND octet_length(signature_image) BETWEEN 1 AND {CertificateTemplate.MaxImageBytes})");
        });
        builder.HasKey(c => c.Id);
        builder.Property(c => c.Id).ValueGeneratedNever();
        builder.Property(c => c.Settings).HasColumnType("jsonb");
        builder.Property(c => c.LogoContentType).HasMaxLength(32);
        builder.Property(c => c.SignatureContentType).HasMaxLength(32);
    }
}
