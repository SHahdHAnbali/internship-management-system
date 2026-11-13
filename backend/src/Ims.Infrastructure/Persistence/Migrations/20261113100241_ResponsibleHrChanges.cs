using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ResponsibleHrChanges : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "responsible_hr_changes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sequence = table.Column<int>(type: "integer", nullable: false),
                    hr_id = table.Column<Guid>(type: "uuid", nullable: false),
                    changed_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                    changed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_responsible_hr_changes", x => x.id);
                    table.CheckConstraint("ck_responsible_hr_changes_sequence", "sequence >= 1");
                    table.ForeignKey(
                        name: "fk_responsible_hr_changes_employees_changed_by_id",
                        column: x => x.changed_by_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_responsible_hr_changes_employees_hr_id",
                        column: x => x.hr_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_responsible_hr_changes_training_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "training_applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_responsible_hr_changes_changed_by_id",
                table: "responsible_hr_changes",
                column: "changed_by_id");

            migrationBuilder.CreateIndex(
                name: "ix_responsible_hr_changes_hr_id",
                table: "responsible_hr_changes",
                column: "hr_id");

            migrationBuilder.CreateIndex(
                name: "ux_responsible_hr_changes_application_id_sequence",
                table: "responsible_hr_changes",
                columns: new[] { "application_id", "sequence" },
                unique: true);

            // Audit every change and never delete (docs/architecture.md): audit, no-delete and no-truncate triggers.
            migrationBuilder.Sql("SELECT ims_protect_table('responsible_hr_changes');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "responsible_hr_changes");
        }
    }
}
