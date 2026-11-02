using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TraineeApplicationsAndMentoring : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "full_name",
                table: "trainees",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "major",
                table: "trainees",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "phone",
                table: "trainees",
                type: "character varying(50)",
                maxLength: 50,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "study_year",
                table: "trainees",
                type: "character varying(50)",
                maxLength: 50,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "university",
                table: "trainees",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "training_applications",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    trainee_id = table.Column<Guid>(type: "uuid", nullable: false),
                    field_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    available_from = table.Column<DateOnly>(type: "date", nullable: false),
                    available_to = table.Column<DateOnly>(type: "date", nullable: false),
                    hours = table.Column<int>(type: "integer", nullable: false),
                    mandatory_for_university = table.Column<bool>(type: "boolean", nullable: false),
                    submitted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    decided_by_id = table.Column<Guid>(type: "uuid", nullable: true),
                    rejection_reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_training_applications", x => x.id);
                    table.CheckConstraint("ck_training_applications_decision", "(status IN ('Accepted', 'Rejected')) = (decided_at IS NOT NULL AND decided_by_id IS NOT NULL)");
                    table.CheckConstraint("ck_training_applications_hours", "hours > 0");
                    table.CheckConstraint("ck_training_applications_period", "available_to >= available_from");
                    table.CheckConstraint("ck_training_applications_rejection_reason", "(status = 'Rejected') = (rejection_reason IS NOT NULL)");
                    table.CheckConstraint("ck_training_applications_status", "status IN ('Submitted', 'UnderReview', 'Accepted', 'Rejected')");
                    table.ForeignKey(
                        name: "fk_training_applications_employees_decided_by_id",
                        column: x => x.decided_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_training_applications_fields_field_id",
                        column: x => x.field_id,
                        principalTable: "fields",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_training_applications_trainees_trainee_id",
                        column: x => x.trainee_id,
                        principalTable: "trainees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "application_attachments",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    content_type = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character(64)", fixedLength: true, maxLength: 64, nullable: false),
                    storage_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    uploaded_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_attachments", x => x.id);
                    table.CheckConstraint("ck_application_attachments_kind", "kind IN ('Cv', 'UniversityLetter')");
                    table.CheckConstraint("ck_application_attachments_sha256", "sha256 ~ '^[0-9a-f]{64}$'");
                    table.CheckConstraint("ck_application_attachments_size", "size_bytes > 0");
                    table.ForeignKey(
                        name: "fk_application_attachments_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "mentor_requests",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    employee_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    note = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    requested_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    decided_by_id = table.Column<Guid>(type: "uuid", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_mentor_requests", x => x.id);
                    table.CheckConstraint("ck_mentor_requests_decision", "(status IN ('Approved', 'Rejected')) = (decided_at IS NOT NULL AND decided_by_id IS NOT NULL)");
                    table.CheckConstraint("ck_mentor_requests_status", "status IN ('Pending', 'Approved', 'Rejected')");
                    table.ForeignKey(
                        name: "fk_mentor_requests_employees_decided_by_id",
                        column: x => x.decided_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_mentor_requests_employees_employee_id",
                        column: x => x.employee_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_mentor_requests_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "assignments",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    employee_id = table.Column<Guid>(type: "uuid", nullable: false),
                    mentor_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    start_date = table.Column<DateOnly>(type: "date", nullable: false),
                    end_date = table.Column<DateOnly>(type: "date", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    end_reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_assignments", x => x.id);
                    table.CheckConstraint("ck_assignments_period", "end_date >= start_date");
                    table.CheckConstraint("ck_assignments_status", "status IN ('Active', 'Completed', 'EndedEarly', 'Transferred', 'Withdrawn')");
                    table.ForeignKey(
                        name: "fk_assignments_employees_employee_id",
                        column: x => x.employee_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_assignments_mentor_requests_mentor_request_id",
                        column: x => x.mentor_request_id,
                        principalTable: "mentor_requests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_assignments_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "progress_notes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    author_id = table.Column<Guid>(type: "uuid", nullable: false),
                    written_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    text = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_progress_notes", x => x.id);
                    table.ForeignKey(
                        name: "fk_progress_notes_assignments_assignment_id",
                        column: x => x.assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_progress_notes_employees_author_id",
                        column: x => x.author_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_application_attachments_application_id",
                table: "application_attachments",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ux_application_attachments_storage_key",
                table: "application_attachments",
                column: "storage_key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_assignments_employee_id",
                table: "assignments",
                column: "employee_id");

            migrationBuilder.CreateIndex(
                name: "ux_assignments_application_id",
                table: "assignments",
                column: "application_id",
                unique: true,
                filter: "status = 'Active'");

            migrationBuilder.CreateIndex(
                name: "ux_assignments_mentor_request_id",
                table: "assignments",
                column: "mentor_request_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_mentor_requests_decided_by_id",
                table: "mentor_requests",
                column: "decided_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_mentor_requests_employee_id",
                table: "mentor_requests",
                column: "employee_id");

            migrationBuilder.CreateIndex(
                name: "ux_mentor_requests_application_id",
                table: "mentor_requests",
                column: "application_id",
                unique: true,
                filter: "status = 'Pending'");

            migrationBuilder.CreateIndex(
                name: "ix_progress_notes_assignment_id",
                table: "progress_notes",
                column: "assignment_id");

            migrationBuilder.CreateIndex(
                name: "ix_progress_notes_author_id",
                table: "progress_notes",
                column: "author_id");

            migrationBuilder.CreateIndex(
                name: "ix_training_applications_decided_by_id",
                table: "training_applications",
                column: "decided_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_training_applications_field_id",
                table: "training_applications",
                column: "field_id");

            migrationBuilder.CreateIndex(
                name: "ix_training_applications_status",
                table: "training_applications",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_training_applications_trainee_id",
                table: "training_applications",
                column: "trainee_id");

            // Every table is protected against deletion and audited (see the AdminModule migration).
            foreach (var table in new[] { "training_applications", "application_attachments", "mentor_requests", "assignments", "progress_notes" })
            {
                migrationBuilder.Sql($"SELECT ims_protect_table('{table}');");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "application_attachments");

            migrationBuilder.DropTable(
                name: "progress_notes");

            migrationBuilder.DropTable(
                name: "assignments");

            migrationBuilder.DropTable(
                name: "mentor_requests");

            migrationBuilder.DropTable(
                name: "training_applications");

            migrationBuilder.DropColumn(
                name: "full_name",
                table: "trainees");

            migrationBuilder.DropColumn(
                name: "major",
                table: "trainees");

            migrationBuilder.DropColumn(
                name: "phone",
                table: "trainees");

            migrationBuilder.DropColumn(
                name: "study_year",
                table: "trainees");

            migrationBuilder.DropColumn(
                name: "university",
                table: "trainees");
        }
    }
}
