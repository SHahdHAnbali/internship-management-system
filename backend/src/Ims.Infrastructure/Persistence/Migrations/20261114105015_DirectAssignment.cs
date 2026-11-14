using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DirectAssignment : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_notifications_type",
                table: "notifications");

            migrationBuilder.AddColumn<string>(
                name: "rejection_reason",
                table: "mentor_requests",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_notifications_type",
                table: "notifications",
                sql: "type IN ('ApplicationSubmitted', 'MentorRequestSubmitted', 'MentorRequestApproved', 'MentorRequestRejected', 'TraineeDirectlyAssigned')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_mentor_requests_rejection_reason",
                table: "mentor_requests",
                sql: "rejection_reason IS NULL OR status = 'Rejected'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_notifications_type",
                table: "notifications");

            migrationBuilder.DropCheckConstraint(
                name: "ck_mentor_requests_rejection_reason",
                table: "mentor_requests");

            migrationBuilder.DropColumn(
                name: "rejection_reason",
                table: "mentor_requests");

            migrationBuilder.AddCheckConstraint(
                name: "ck_notifications_type",
                table: "notifications",
                sql: "type IN ('ApplicationSubmitted', 'MentorRequestSubmitted', 'MentorRequestApproved', 'MentorRequestRejected')");
        }
    }
}
