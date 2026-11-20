// Local database: drizzle + bun:sqlite.
//
// - The SQLite file lives at DATABASE_PATH (default `./app.db` in the
//   project root). It is created empty on first start: the SQL files in
//   `drizzle/` are applied in journal order, which creates the tables
//   but inserts no household data.
// - The VEC retailer list (public data, see RETAILERS in actions.ts)
//   and a settings row with the generic VDO-based defaults are seeded
//   only when their tables are empty, so a restart never overwrites
//   user data.

import { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DAILY,
  deriveAnnualProfile,
  RETAILERS,
} from "./actions";
import * as schema from "./schema";

export type AppDb = BunSQLiteDatabase<typeof schema>;

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? "./app.db");
}

/** Locate the `drizzle/` migrations folder, whether running from source
 * (`bun server/src/index.ts`) or from the bundle (`server/dist/`). */
export function migrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), "drizzle"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "meta", "_journal.json"))) return c;
  }
  return candidates[0] as string;
}

export function initDb(): AppDb {
  const path = databasePath();
  const sqlite = new Database(path);
  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder: migrationsFolder() });

  const existingRetailers = db
    .select({ id: schema.retailers.id })
    .from(schema.retailers)
    .limit(1)
    .all();
  if (existingRetailers.length === 0) {
    for (const [index, retailer] of RETAILERS.entries()) {
      db.insert(schema.retailers)
        .values({
          name: retailer.name,
          offers: retailer.offers,
          website: retailer.website,
          sortOrder: index + 1,
        })
        .run();
    }
  }

  const existingSettings = db.select().from(schema.settings).limit(1).all();
  if (existingSettings.length === 0) {
    const derived = deriveAnnualProfile(DEFAULT_DAILY);
    db.insert(schema.settings)
      .values({
      id: 1,
      elecKwh: derived.elecKwh,
      gasMj: derived.gasMj,
      elecPeakKwh: derived.elecPeakKwh,
      elecFlatKwh: derived.elecFlatKwh,
      elecShoulderKwh: derived.elecShoulderKwh,
      solarExportKwh: derived.solarExportKwh,
      hasSolar: DEFAULT_DAILY.hasSolar ? 1 : 0,
      hasBattery: DEFAULT_DAILY.hasBattery ? 1 : 0,
      hasEv: DEFAULT_DAILY.hasEv ? 1 : 0,
      meterType: DEFAULT_DAILY.meterType,
      elecDailyKwh: DEFAULT_DAILY.elecDailyKwh,
      selfGenDailyKwh: DEFAULT_DAILY.selfGenDailyKwh,
      gasDailyMj: DEFAULT_DAILY.gasDailyMj,
      autoRefreshDays: 7,
      })
      .run();
  }

  return db;
}

/** Keep the settings row's active address pointing at a real address
 * (used after startup; the dashboard itself tolerates a missing one). */
export async function ensureActiveAddress(db: AppDb): Promise<void> {
  const addresses = await db
    .select()
    .from(schema.addresses)
    .orderBy(asc(schema.addresses.sortOrder), asc(schema.addresses.id));
  if (addresses.length === 0) return;
  const settingsRows = await db.select().from(schema.settings);
  const row = settingsRows[0];
  if (!row) return;
  if (
    row.activeAddressId == null ||
    !addresses.some((a) => a.id === row.activeAddressId)
  ) {
    const first = addresses[0];
    if (first) {
      await db
        .update(schema.settings)
        .set({ activeAddressId: first.id })
        .where(eq(schema.settings.id, row.id));
    }
  }
}
