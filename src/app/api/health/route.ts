import { NextResponse } from "next/server";
import { Pool } from "pg";
import { EnvValidationError, getServerEnv } from "@/config/env";

export const dynamic = "force-dynamic";

let pool: Pool | undefined;

/**
 * Liveness + readiness. Returns 200 only when configuration is valid and the database
 * answers. Does not expose connection strings or error details.
 */
export async function GET() {
  let database: "ok" | "unavailable" | "not_configured" = "unavailable";
  try {
    const env = getServerEnv();
    pool ??= new Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    await pool.query("select 1");
    database = "ok";
  } catch (err) {
    database = err instanceof EnvValidationError ? "not_configured" : "unavailable";
  }
  const ok = database === "ok";
  return NextResponse.json(
    { status: ok ? "ok" : "degraded", database, time: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
