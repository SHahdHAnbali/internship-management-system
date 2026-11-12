using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AssignmentExtensions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "assignment_extensions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                    previous_end_date = table.Column<DateOnly>(type: "date", nullable: false),
                    new_end_date = table.Column<DateOnly>(type: "date", nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    extended_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                    extended_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_assignment_extensions", x => x.id);
                    table.CheckConstraint("ck_assignment_extensions_later", "new_end_date > previous_end_date");
                    table.CheckConstraint("ck_assignment_extensions_reason", "btrim(reason) <> ''");
                    table.ForeignKey(
                        name: "fk_assignment_extensions_assignments_assignment_id",
                        column: x => x.assignment_id,
                        principalTable: "assignments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_assignment_extensions_employees_extended_by_id",
                        column: x => x.extended_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_assignment_extensions_assignment_id",
                table: "assignment_extensions",
                column: "assignment_id");

            migrationBuilder.CreateIndex(
                name: "ix_assignment_extensions_extended_by_id",
                table: "assignment_extensions",
                column: "extended_by_id");

            // Audit every change and never delete (docs/architecture.md): audit, no-delete and no-truncate triggers.
            migrationBuilder.Sql("SELECT ims_protect_table('assignment_extensions');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "assignment_extensions");
        }
    }
}
