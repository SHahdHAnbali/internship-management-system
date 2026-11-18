using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Automatic, permanent criterion order (owner decisions O1–O5, 2026-11-18; AD-68 G7). Existing criteria are numbered
    /// once, 1, 2, 3…, in the order they are displayed today (sort_order, name_ar, id); only orders that change are written,
    /// and each change is audited. Then: a unique index, and a trigger that gives every new criterion the highest order + 1
    /// (inactive criteria included) under a transaction-scoped advisory lock, and refuses any later change of an order.
    /// </summary>
    public partial class EvaluationCriteriaAutomaticOrder : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // O1: number the existing criteria once, as they are displayed today. Runs before the trigger exists (which
            // would refuse it) and before the unique index (equal orders are allowed until this has run).
            migrationBuilder.Sql("""
                UPDATE evaluation_criteria c
                   SET sort_order = n.position
                  FROM (SELECT id, row_number() OVER (ORDER BY sort_order, name_ar, id)::int AS position
                          FROM evaluation_criteria) n
                 WHERE c.id = n.id AND c.sort_order <> n.position;
                """);

            migrationBuilder.CreateIndex(
                name: "ux_evaluation_criteria_sort_order",
                table: "evaluation_criteria",
                column: "sort_order",
                unique: true);

            // O2–O4: the database assigns the order and keeps it. Creators of criteria wait for each other (the lock is
            // released at commit or rollback, so a rolled-back create uses no number); each statement of the function
            // reads the latest committed rows (READ COMMITTED), so the next creator sees the order just taken. At the
            // integer maximum the + 1 fails (numeric_value_out_of_range): no wrap-around, no duplicate.
            migrationBuilder.Sql("""
                CREATE FUNCTION ims_evaluation_criteria_order() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF TG_OP = 'INSERT' THEN
                        PERFORM pg_advisory_xact_lock(hashtext('ims.evaluation_criteria.sort_order'));
                        SELECT coalesce(max(sort_order), 0) + 1 INTO NEW.sort_order FROM evaluation_criteria;
                    ELSIF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
                        RAISE EXCEPTION 'The order of an evaluation criterion cannot be changed: it is assigned once, when the criterion is created.'
                            USING ERRCODE = 'restrict_violation';
                    END IF;
                    RETURN NEW;
                END;
                $$;

                CREATE TRIGGER evaluation_criteria_order
                    BEFORE INSERT OR UPDATE OF sort_order ON evaluation_criteria
                    FOR EACH ROW EXECUTE FUNCTION ims_evaluation_criteria_order();
                """);
        }

        /// <inheritdoc />
        /// <remarks>Local development only. Keeps every criterion and its current (valid, unique) order.</remarks>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER evaluation_criteria_order ON evaluation_criteria;
                DROP FUNCTION ims_evaluation_criteria_order();
                """);

            migrationBuilder.DropIndex(
                name: "ux_evaluation_criteria_sort_order",
                table: "evaluation_criteria");
        }
    }
}
