import { NextResponse } from "next/server";
import { Pool } from "pg";
import { EnvValidationError, getServerEnv } from "@/config/env";

export const dynamic = "force-dynamic";

let pool: Pool | undefined;

/**
 * Liveness + readiness. Returns 200 only when configuration is valid and the database
 * answers. Does not expose connection strings or error details: on invalid configuration it
 * lists only the names of the variables to fix (the names are public in this repository).
 */
export async function GET() {
  let database: "ok" | "unavailable" | "not_configured" = "unavailable";
  let invalid: string[] | undefined;
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
    if (err instanceof EnvValidationError) {
      database = "not_configured";
      invalid = err.variables;
    } else {
      database = "unavailable";
    }
  }
  const ok = database === "ok";
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      database,
      ...(invalid ? { invalid } : {}),
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
