using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Ims.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Authentication : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "trainee_sign_in_codes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    token_hash = table.Column<string>(type: "character(64)", fixedLength: true, maxLength: 64, nullable: false),
                    code_hash = table.Column<string>(type: "character(64)", fixedLength: true, maxLength: 64, nullable: false),
                    issued_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    superseded_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    failed_attempts = table.Column<int>(type: "integer", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_trainee_sign_in_codes", x => x.id);
                    table.CheckConstraint("ck_trainee_sign_in_codes_attempts", "failed_attempts BETWEEN 0 AND 5");
                    table.CheckConstraint("ck_trainee_sign_in_codes_expiry", "expires_at > issued_at");
                });

            migrationBuilder.CreateTable(
                name: "trainees",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_trainees", x => x.id);
                    table.CheckConstraint("ck_trainees_email_normalized", "email = lower(btrim(email))");
                });

            migrationBuilder.CreateIndex(
                name: "ix_trainee_sign_in_codes_email_issued_at",
                table: "trainee_sign_in_codes",
                columns: new[] { "email", "issued_at" });

            migrationBuilder.CreateIndex(
                name: "ux_trainee_sign_in_codes_token_hash",
                table: "trainee_sign_in_codes",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_trainees_email",
                table: "trainees",
                column: "email",
                unique: true);

            // Every table is protected against deletion and audited (see the AdminModule migration).
            migrationBuilder.Sql("SELECT ims_protect_table('trainees'); SELECT ims_protect_table('trainee_sign_in_codes');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "trainee_sign_in_codes");

            migrationBuilder.DropTable(
                name: "trainees");
        }
    }
}
