using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AssignmentTransfers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "assignment_transfers",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    from_assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    to_assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    transferred_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                    transferred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_assignment_transfers", x => x.id);
                    table.CheckConstraint("ck_assignment_transfers_distinct", "from_assignment_id <> to_assignment_id");
                    table.ForeignKey(
                        name: "fk_assignment_transfers_assignments_from_assignment_id",
                        column: x => x.from_assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_assignment_transfers_assignments_to_assignment_id",
                        column: x => x.to_assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_assignment_transfers_employees_transferred_by_id",
                        column: x => x.transferred_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_assignment_transfers_transferred_by_id",
                table: "assignment_transfers",
                column: "transferred_by_id");

            migrationBuilder.CreateIndex(
                name: "ux_assignment_transfers_from_assignment_id",
                table: "assignment_transfers",
                column: "from_assignment_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_assignment_transfers_to_assignment_id",
                table: "assignment_transfers",
                column: "to_assignment_id",
                unique: true);

            // Audit every change and never delete (docs/architecture.md): audit, no-delete and no-truncate triggers.
            migrationBuilder.Sql("SELECT ims_protect_table('assignment_transfers');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "assignment_transfers");
        }
    }
}
