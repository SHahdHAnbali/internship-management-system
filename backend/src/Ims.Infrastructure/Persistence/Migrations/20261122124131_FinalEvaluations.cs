using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class FinalEvaluations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // R27, S2.1 (AD-66, AD-68; owner decisions 2026-11-22): three new tables only; no existing table or row changes.
            // No mean or grade column (G8). The Worker's role gets SELECT only (backend-workers/scripts/ims-app-grants.sql).
            migrationBuilder.CreateTable(
                name: "evaluations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    comment = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    hiring_recommendation = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    version = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    submitted_by_id = table.Column<Guid>(type: "uuid", nullable: true),
                    submitted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_evaluations", x => x.id);
                    table.CheckConstraint("ck_evaluations_hiring_recommendation", "hiring_recommendation IN ('Yes', 'Maybe', 'No')");
                    table.CheckConstraint("ck_evaluations_status", "status IN ('Draft', 'Submitted')");
                    table.CheckConstraint("ck_evaluations_submission", "(status = 'Draft' AND submitted_by_id IS NULL AND submitted_at IS NULL) OR (status = 'Submitted' AND submitted_by_id IS NOT NULL AND submitted_at IS NOT NULL)");
                    table.CheckConstraint("ck_evaluations_submitted_content", "status <> 'Submitted' OR (comment IS NOT NULL AND comment ~ '\\S' AND hiring_recommendation IS NOT NULL)");
                    table.CheckConstraint("ck_evaluations_version", "version >= 0");
                    table.ForeignKey(
                        name: "fk_evaluations_assignments_assignment_id",
                        column: x => x.assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_evaluations_employees_submitted_by_id",
                        column: x => x.submitted_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_evaluations_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "evaluation_corrections",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    evaluation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    corrected_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                    corrected_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_evaluation_corrections", x => x.id);
                    table.ForeignKey(
                        name: "fk_evaluation_corrections_employees_corrected_by_id",
                        column: x => x.corrected_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_evaluation_corrections_evaluations_evaluation_id",
                        column: x => x.evaluation_id,
                        principalTable: "evaluations",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "evaluation_scores",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    evaluation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    criterion_id = table.Column<Guid>(type: "uuid", nullable: false),
                    score = table.Column<short>(type: "smallint", nullable: true),
                    frozen_name_ar = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    frozen_name_en = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    frozen_sort_order = table.Column<int>(type: "integer", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_evaluation_scores", x => x.id);
                    table.CheckConstraint("ck_evaluation_scores_frozen_scored", "frozen_sort_order IS NULL OR score IS NOT NULL");
                    table.CheckConstraint("ck_evaluation_scores_score", "score BETWEEN 1 AND 5");
                    table.CheckConstraint("ck_evaluation_scores_snapshot", "(frozen_name_ar IS NULL) = (frozen_name_en IS NULL) AND (frozen_name_ar IS NULL) = (frozen_sort_order IS NULL)");
                    table.ForeignKey(
                        name: "fk_evaluation_scores_evaluation_criteria_criterion_id",
                        column: x => x.criterion_id,
                        principalTable: "evaluation_criteria",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_evaluation_scores_evaluations_evaluation_id",
                        column: x => x.evaluation_id,
                        principalTable: "evaluations",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_evaluation_corrections_corrected_by_id",
                table: "evaluation_corrections",
                column: "corrected_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_evaluation_corrections_evaluation_id",
                table: "evaluation_corrections",
                column: "evaluation_id");

            migrationBuilder.CreateIndex(
                name: "ix_evaluation_scores_criterion_id",
                table: "evaluation_scores",
                column: "criterion_id");

            migrationBuilder.CreateIndex(
                name: "ux_evaluation_scores_evaluation_id_criterion_id",
                table: "evaluation_scores",
                columns: new[] { "evaluation_id", "criterion_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_evaluations_assignment_id",
                table: "evaluations",
                column: "assignment_id");

            migrationBuilder.CreateIndex(
                name: "ix_evaluations_submitted_by_id",
                table: "evaluations",
                column: "submitted_by_id");

            migrationBuilder.CreateIndex(
                name: "ux_evaluations_application_id",
                table: "evaluations",
                column: "application_id",
                unique: true);

            // Audit trigger, no DELETE, no TRUNCATE (like every table).
            migrationBuilder.Sql("SELECT ims_protect_table('evaluations');");
            migrationBuilder.Sql("SELECT ims_protect_table('evaluation_scores');");
            migrationBuilder.Sql("SELECT ims_protect_table('evaluation_corrections');");
        }

        /// <inheritdoc />
        /// <remarks>For local and disposable databases only: production rolls back the code and keeps the (empty) tables.</remarks>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "evaluation_corrections");

            migrationBuilder.DropTable(
                name: "evaluation_scores");

            migrationBuilder.DropTable(
                name: "evaluations");
        }
    }
}
