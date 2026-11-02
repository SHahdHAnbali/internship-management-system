using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class CertificateTemplate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "certificate_templates",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false),
                    settings = table.Column<string>(type: "jsonb", nullable: false),
                    logo_image = table.Column<byte[]>(type: "bytea", nullable: true),
                    logo_content_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    signature_image = table.Column<byte[]>(type: "bytea", nullable: true),
                    signature_content_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_certificate_templates", x => x.id);
                    table.CheckConstraint("ck_certificate_templates_logo", "(logo_image IS NULL AND logo_content_type IS NULL) OR (logo_image IS NOT NULL AND logo_content_type IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length(logo_image) BETWEEN 1 AND 524288)");
                    table.CheckConstraint("ck_certificate_templates_settings_object", "jsonb_typeof(settings) = 'object'");
                    table.CheckConstraint("ck_certificate_templates_signature", "(signature_image IS NULL AND signature_content_type IS NULL) OR (signature_image IS NOT NULL AND signature_content_type IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length(signature_image) BETWEEN 1 AND 524288)");
                    table.CheckConstraint("ck_certificate_templates_single_row", "id = 1");
                });

            // Every table is protected against deletion and audited (see the AdminModule migration).
            migrationBuilder.Sql("SELECT ims_protect_table('certificate_templates');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "certificate_templates");
        }
    }
}
