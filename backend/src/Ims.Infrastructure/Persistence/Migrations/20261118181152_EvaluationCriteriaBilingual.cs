using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// AD-66 criteria: an Arabic and an English name and an active flag; no weights. Additive: every row, id, order and
    /// legacy value is kept. The legacy `name` (until now the only name) becomes the Arabic name, and the owner's English
    /// names (2026-11-18, G1) are set for the three production criteria, matched by their exact Arabic name. `name` and
    /// `weight` stay as nullable legacy columns. The backfill is one UPDATE, audited by the trigger like any other change.
    /// </summary>
    public partial class EvaluationCriteriaBilingual : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_evaluation_criteria_weight",
                table: "evaluation_criteria");

            migrationBuilder.AlterColumn<decimal>(
                name: "weight",
                table: "evaluation_criteria",
                type: "numeric(9,4)",
                precision: 9,
                scale: 4,
                nullable: true,
                oldClrType: typeof(decimal),
                oldType: "numeric(9,4)",
                oldPrecision: 9,
                oldScale: 4);

            migrationBuilder.AlterColumn<string>(
                name: "name",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200);

            migrationBuilder.AddColumn<bool>(
                name: "is_active",
                table: "evaluation_criteria",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "name_ar",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "name_en",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            // ELSE: only for non-production databases; the production preflight requires all its rows to match.
            migrationBuilder.Sql("""
                UPDATE evaluation_criteria
                   SET name_ar = name,
                       name_en = CASE name
                                     WHEN 'التزام بالمواعيد' THEN 'Punctuality'
                                     WHEN 'التزام بالوقت (تنفيذ المهام)' THEN 'Timely Task Completion'
                                     WHEN 'حضور وغياب' THEN 'Attendance and Absence'
                                     ELSE name
                                 END,
                       is_active = true;
                """);

            migrationBuilder.AlterColumn<string>(
                name: "name_ar",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200,
                oldNullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "name_en",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200,
                oldNullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_evaluation_criteria_weight",
                table: "evaluation_criteria",
                sql: "weight IS NULL OR weight > 0");
        }

        /// <inheritdoc />
        /// <remarks>Local development only: never run in production (it would discard the English names).</remarks>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_evaluation_criteria_weight",
                table: "evaluation_criteria");

            migrationBuilder.Sql("UPDATE evaluation_criteria SET name = coalesce(name, name_ar), weight = coalesce(weight, 1);");

            migrationBuilder.DropColumn(
                name: "is_active",
                table: "evaluation_criteria");

            migrationBuilder.DropColumn(
                name: "name_ar",
                table: "evaluation_criteria");

            migrationBuilder.DropColumn(
                name: "name_en",
                table: "evaluation_criteria");

            migrationBuilder.AlterColumn<decimal>(
                name: "weight",
                table: "evaluation_criteria",
                type: "numeric(9,4)",
                precision: 9,
                scale: 4,
                nullable: false,
                oldClrType: typeof(decimal),
                oldType: "numeric(9,4)",
                oldPrecision: 9,
                oldScale: 4,
                oldNullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "name",
                table: "evaluation_criteria",
                type: "character varying(200)",
                maxLength: 200,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200,
                oldNullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_evaluation_criteria_weight",
                table: "evaluation_criteria",
                sql: "weight > 0");
        }
    }
}
