using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PendingReminders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "pending_reminders",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: true),
                    mentor_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    attempted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    recipient_count = table.Column<int>(type: "integer", nullable: false),
                    outcome = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    accepted_count = table.Column<int>(type: "integer", nullable: true),
                    failed_count = table.Column<int>(type: "integer", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pending_reminders", x => x.id);
                    table.CheckConstraint("ck_pending_reminders_kind", "kind IN ('TrainingApplication', 'MentorRequest')");
                    table.CheckConstraint("ck_pending_reminders_outcome", "outcome IN ('Attempting', 'Accepted', 'PartiallyAccepted', 'Failed')");
                    table.CheckConstraint("ck_pending_reminders_recipients", "recipient_count >= 1");
                    table.CheckConstraint("ck_pending_reminders_result", "(outcome = 'Attempting') = (completed_at IS NULL) AND (outcome = 'Attempting') = (accepted_count IS NULL AND failed_count IS NULL) AND (outcome = 'Attempting' OR accepted_count + failed_count = recipient_count)");
                    table.CheckConstraint("ck_pending_reminders_target", "(kind = 'TrainingApplication' AND application_id IS NOT NULL AND mentor_request_id IS NULL) OR (kind = 'MentorRequest' AND mentor_request_id IS NOT NULL AND application_id IS NULL)");
                    table.ForeignKey(
                        name: "fk_pending_reminders_mentor_requests_mentor_request_id",
                        column: x => x.mentor_request_id,
                        principalTable: "mentor_requests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_pending_reminders_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ux_pending_reminders_application_id",
                table: "pending_reminders",
                column: "application_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_pending_reminders_mentor_request_id",
                table: "pending_reminders",
                column: "mentor_request_id",
                unique: true);

            // Audit trigger, no DELETE, no TRUNCATE (like every table).
            migrationBuilder.Sql("SELECT ims_protect_table('pending_reminders');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "pending_reminders");
        }
    }
}
