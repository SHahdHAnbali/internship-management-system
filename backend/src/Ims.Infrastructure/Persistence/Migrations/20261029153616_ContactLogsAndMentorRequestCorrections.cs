using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ContactLogsAndMentorRequestCorrections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ux_mentor_requests_application_id",
                table: "mentor_requests");

            migrationBuilder.CreateTable(
                name: "contact_logs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    author_id = table.Column<Guid>(type: "uuid", nullable: false),
                    contact_date = table.Column<DateOnly>(type: "date", nullable: false),
                    method = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    summary = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    recorded_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_contact_logs", x => x.id);
                    table.CheckConstraint("ck_contact_logs_method", "method IN ('Phone', 'Meeting', 'Email')");
                    table.ForeignKey(
                        name: "fk_contact_logs_employees_author_id",
                        column: x => x.author_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_contact_logs_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_mentor_requests_application_id",
                table: "mentor_requests",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ix_contact_logs_application_id",
                table: "contact_logs",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ix_contact_logs_author_id",
                table: "contact_logs",
                column: "author_id");

            // Every table is protected against deletion and audited (see the AdminModule migration).
            migrationBuilder.Sql("SELECT ims_protect_table('contact_logs');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "contact_logs");

            migrationBuilder.DropIndex(
                name: "ix_mentor_requests_application_id",
                table: "mentor_requests");

            migrationBuilder.CreateIndex(
                name: "ux_mentor_requests_application_id",
                table: "mentor_requests",
                column: "application_id",
                unique: true,
                filter: "status = 'Pending'");
        }
    }
}
