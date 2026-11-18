using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// A criterion's order is a whole number of 1 or more (owner decision, 2026-11-18); not necessarily unique or
    /// consecutive. Additive: no row is changed (every existing order is already at least 1).
    /// </summary>
    public partial class EvaluationCriteriaSortOrderPositive : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddCheckConstraint(
                name: "ck_evaluation_criteria_sort_order",
                table: "evaluation_criteria",
                sql: "sort_order >= 1");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_evaluation_criteria_sort_order",
                table: "evaluation_criteria");
        }
    }
}
