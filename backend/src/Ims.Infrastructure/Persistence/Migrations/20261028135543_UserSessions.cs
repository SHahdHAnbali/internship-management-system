using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UserSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "user_sessions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    employee_id = table.Column<Guid>(type: "uuid", nullable: true),
                    trainee_id = table.Column<Guid>(type: "uuid", nullable: true),
                    google_subject = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    revoke_reason = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_sessions", x => x.id);
                    table.CheckConstraint("ck_user_sessions_expiry", "expires_at > created_at");
                    table.CheckConstraint("ck_user_sessions_one_owner", "num_nonnulls(employee_id, trainee_id, google_subject) = 1");
                    table.CheckConstraint("ck_user_sessions_revocation", "(revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)");
                    table.CheckConstraint("ck_user_sessions_revoke_reason", "revoke_reason IN ('SignOut', 'Replaced')");
                    table.ForeignKey(
                        name: "fk_user_sessions_employees_employee_id",
                        column: x => x.employee_id,
                        principalTable: "employees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_user_sessions_trainees_trainee_id",
                        column: x => x.trainee_id,
                        principalTable: "trainees",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_employee_id",
                table: "user_sessions",
                column: "employee_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_google_subject",
                table: "user_sessions",
                column: "google_subject");

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_trainee_id",
                table: "user_sessions",
                column: "trainee_id");

            // Every table is protected against deletion and audited (see the AdminModule migration).
            migrationBuilder.Sql("SELECT ims_protect_table('user_sessions');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_sessions");
        }
    }
}
