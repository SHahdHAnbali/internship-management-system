using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TransferDecisions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // AD-65 revised: every executed transfer comes from a decision. No default: assignment_transfers is empty
            // wherever this runs (it was never deployed), and a NOT NULL column without a default fails safely otherwise.
            migrationBuilder.AddColumn<Guid>(
                name: "decision_id",
                table: "assignment_transfers",
                type: "uuid",
                nullable: false);

            migrationBuilder.CreateTable(
                name: "transfer_decisions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    from_assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    incoming_employee_id = table.Column<Guid>(type: "uuid", nullable: false),
                    effective_date = table.Column<DateOnly>(type: "date", nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    decided_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                    decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    resolved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    resolved_by_id = table.Column<Guid>(type: "uuid", nullable: true),
                    resolution_code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    resolution_reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_transfer_decisions", x => x.id);
                    table.CheckConstraint("ck_transfer_decisions_cancelled", "status <> 'Cancelled' OR (resolved_by_id IS NOT NULL AND resolution_reason IS NOT NULL)");
                    table.CheckConstraint("ck_transfer_decisions_resolved", "(status = 'Pending') = (resolved_at IS NULL)");
                    table.CheckConstraint("ck_transfer_decisions_status", "status IN ('Pending', 'Executed', 'Cancelled', 'Void')");
                    table.CheckConstraint("ck_transfer_decisions_void", "status <> 'Void' OR resolution_code IS NOT NULL");
                    table.ForeignKey(
                        name: "fk_transfer_decisions_assignments_from_assignment_id",
                        column: x => x.from_assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_transfer_decisions_employees_decided_by_id",
                        column: x => x.decided_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_transfer_decisions_employees_incoming_employee_id",
                        column: x => x.incoming_employee_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_transfer_decisions_employees_resolved_by_id",
                        column: x => x.resolved_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_transfer_decisions_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ux_assignment_transfers_decision_id",
                table: "assignment_transfers",
                column: "decision_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_transfer_decisions_decided_by_id",
                table: "transfer_decisions",
                column: "decided_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_transfer_decisions_from_assignment_id",
                table: "transfer_decisions",
                column: "from_assignment_id");

            migrationBuilder.CreateIndex(
                name: "ix_transfer_decisions_incoming_employee_id",
                table: "transfer_decisions",
                column: "incoming_employee_id");

            migrationBuilder.CreateIndex(
                name: "ix_transfer_decisions_resolved_by_id",
                table: "transfer_decisions",
                column: "resolved_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_transfer_decisions_status_effective_date",
                table: "transfer_decisions",
                columns: new[] { "status", "effective_date" });

            migrationBuilder.CreateIndex(
                name: "ux_transfer_decisions_application_id",
                table: "transfer_decisions",
                column: "application_id",
                unique: true,
                filter: "status = 'Pending'");

            migrationBuilder.AddForeignKey(
                name: "fk_assignment_transfers_transfer_decisions_decision_id",
                table: "assignment_transfers",
                column: "decision_id",
                principalTable: "transfer_decisions",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            // Audit trigger, no DELETE, no TRUNCATE (like every table).
            migrationBuilder.Sql("SELECT ims_protect_table('transfer_decisions');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_assignment_transfers_transfer_decisions_decision_id",
                table: "assignment_transfers");

            migrationBuilder.DropTable(
                name: "transfer_decisions");

            migrationBuilder.DropIndex(
                name: "ux_assignment_transfers_decision_id",
                table: "assignment_transfers");

            migrationBuilder.DropColumn(
                name: "decision_id",
                table: "assignment_transfers");
        }
    }
}
