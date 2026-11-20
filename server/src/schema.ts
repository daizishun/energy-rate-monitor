// Drizzle schema for this space.
//
// Tables:
//   snapshots — one row per rate check (research baseline or a CDR refresh).
//     elec_plans / gas_plans hold JSON arrays of the cheapest-per-retailer
//     plans with their full rate steps, so the client can re-price them at
//     any usage level without another server round-trip.
//   settings — single row (id = 1) with the household's annual usage.
//   retailers — the 33 retailers listed by Victorian Energy Compare,
//     seeded once from the research report.
//   addresses — saved household addresses. Each address carries its own
//     electricity / gas distribution networks (which decide which CDR
//     plans apply), its own usage profile, and optionally the annual
//     cost of the plan currently in use there. Snapshots belong to one
//     address (address_id); settings.active_address_id picks the one
//     the page shows. A fresh install has no addresses: the user adds
//     their own (see saveAddress in actions.ts).

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  takenAt: integer("taken_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  source: text("source", { enum: ["research", "cdr", "pdf"] }).notNull(),
  status: text("status", { enum: ["ok", "partial", "error"] }).notNull(),
  elecPlans: text("elec_plans").notNull().default("[]"),
  gasPlans: text("gas_plans").notNull().default("[]"),
  elecBasisKwh: integer("elec_basis_kwh").notNull(),
  gasBasisMj: integer("gas_basis_mj").notNull(),
  brandsOk: integer("brands_ok").notNull().default(0),
  brandsFailed: integer("brands_failed").notNull().default(0),
  // Refresh outcome vs the previous data-bearing snapshot, computed when a
  // CDR refresh is stored: 1 = that fuel's plan data changed （有更新）,
  // 0 = identical （没有更新）, null = not applicable (baseline snapshots,
  // failed runs, or a fuel that returned no plans this run).
  elecChanged: integer("elec_changed"),
  gasChanged: integer("gas_changed"),
  // Display names of the CDR brands that failed during this refresh run
  // (JSON array), so the page can say exactly which sources did not come
  // back. Null on baseline snapshots and pre-migration rows.
  failedBrands: text("failed_brands"),
  // Retailers whose plans in this snapshot were carried over from the
  // previous snapshot because their brand failed this refresh (JSON
  // object { elec: string[], gas: string[] } of plan-entry retailer
  // names). Their rows stay visible, marked 更新失败， instead of the
  // brand vanishing from the ranking. Null on baseline snapshots and
  // pre-migration rows.
  carriedBrands: text("carried_brands"),
  message: text("message"),
  // The address this check was run for. Rows created before the
  // addresses table existed default to 1.
  addressId: integer("address_id").notNull().default(1),
});

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  elecKwh: integer("elec_kwh").notNull(),
  gasMj: integer("gas_mj").notNull(),
  // Annual usage split (kWh/yr): peak / flat / shoulder and solar
  // export. Defaults follow the VDO reference (4,000 kWh/yr split
  // 29/53/18, no solar export); the page derives these from the three
  // daily inputs, so stored values are always overwritten on save.
  elecPeakKwh: integer("elec_peak_kwh").notNull().default(1160),
  elecFlatKwh: integer("elec_flat_kwh").notNull().default(2120),
  elecShoulderKwh: integer("elec_shoulder_kwh").notNull().default(720),
  solarExportKwh: integer("solar_export_kwh").notNull().default(0),
  // Household equipment + the simplified daily usage inputs: only three
  // usage numbers are entered — daily electricity kWh, daily
  // self-generation kWh (solar and/or battery, default 0), daily gas MJ. The annual peak/flat/shoulder columns
  // above are DERIVED from elecDailyKwh with the VDO time-of-use load
  // split (peak 29% / flat 53% / shoulder 18%) and solarExportKwh from
  // selfGenDailyKwh (zero when neither solar nor battery is ticked);
  // they stay as the pricing profile every existing calculation reads.
  // Defaults follow the VDO reference: 4,000 kWh/yr ≈ 11 kWh/day and
  // the AER Victorian gas benchmark 50,743 MJ/yr ≈ 139 MJ/day. No
  // equipment is assumed on a fresh install → 0/0/0.
  hasSolar: integer("has_solar").notNull().default(0),
  hasBattery: integer("has_battery").notNull().default(0),
  hasEv: integer("has_ev").notNull().default(0),
  // The household's meter tariff type: "single" = single-rate meter
  // （单费率）, "tou" = time-of-use meter （分时）. Retailers publish
  // most plans in both variants (the CDR pricingModel pair SINGLE_RATE
  // / TIME_OF_USE — e.g. 1st Energy's Emerald Anytime vs Emerald Time
  // of Use). Root cause verified 2026-11-20: the two variants differ
  // ONLY in rate structure (full recursive CDR diff — eligibility,
  // postcodes, fees, dates identical); each plan's eligibility text
  // defines applicability against the premises' "applicable network
  // tariff and meter configuration", so which variant applies is a
  // property of the address's meter registration, which quote sites
  // read from the address (NMI) — never asked of the user — while
  // this tool cannot read it and stores the user's pick per address
  // instead. Like the equipment flags it is a DISPLAY condition: a
  // refresh stores both variants, the page shows the one matching
  // this type (a plan family published in only one variant shows
  // regardless — e.g. Midday Power Saver, time-of-use only, which is
  // why the meter type matters: a plan family published in only one
  // variant shows regardless — e.g. Midday Power Saver, time-of-use
  // only. Default "single": nothing is assumed about the household's
  // meter until the user picks its type.
  meterType: text("meter_type", { enum: ["single", "tou"] })
    .notNull()
    .default("single"),
  elecDailyKwh: real("elec_daily_kwh").notNull().default(11),
  selfGenDailyKwh: real("self_gen_daily_kwh").notNull().default(0),
  gasDailyMj: real("gas_daily_mj").notNull().default(139),
  // Auto-update interval in days (default
  // one week): 0 = off, 1 = daily, 7 = weekly, 14 = fortnightly,
  // 30 = monthly. A GLOBAL preference (not per-address): the daily
  // scheduled tick calls the autoRefresh action, which runs a real
  // CDR fetch for the active address only when at least this many
  // days have passed since that address's last data-bearing check.
  // Manual 立即刷新 is never gated by it.
  autoRefreshDays: integer("auto_refresh_days").notNull().default(7),
  // Which saved address the page currently shows / refreshes run for.
  // Null until the default address has been ensured.
  activeAddressId: integer("active_address_id"),
});

export const addresses = sqliteTable("addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Short display label, e.g. "12 Smith St" or "家".
  label: text("label").notNull(),
  street: text("street").notNull(),
  suburb: text("suburb").notNull(),
  postcode: text("postcode").notNull(),
  state: text("state").notNull().default("VIC"),
  // Electricity distributor preset id + the label / CDR geography
  // substring captured when the address was saved (so a later preset
  // rename never silently changes what an existing address matches).
  elecDistributorId: text("elec_distributor_id").notNull(),
  elecDistributorLabel: text("elec_distributor_label").notNull(),
  elecMatch: text("elec_match").notNull(),
  // Electricity network candidates from the last CDR postcode probe
  // (JSON array of { id, label, planCount }, sorted by coverage).
  // Null = never probed (pre-migration rows; getDashboard backfills
  // once). "[]" = networks were set explicitly (bill-confirmed default
  // address, or the manual add/update actions), so no probe applies.
  // A postcode genuinely split between two networks (e.g. 3083:
  // AusNet and Jemena cover it about equally) makes the top pick a
  // coin flip — retailer quoting sites resolve the real network from
  // the address itself, so a guessed network makes every price on
  // the page differ from theirs.
  elecCandidates: text("elec_candidates"),
  // 0 = the stored electricity network is an unconfirmed auto-guess
  // between close candidates and the user still has to pick the real
  // one (from their bill) via confirmAddressNetworks; 1 = settled
  // (single candidate, explicit choice, or bill-confirmed).
  networksConfirmed: integer("networks_confirmed").notNull().default(1),
  // Gas distributor preset id ("none" = no gas at this address) + label
  // / CDR match substring (empty for "none").
  gasDistributorId: text("gas_distributor_id").notNull(),
  gasDistributorLabel: text("gas_distributor_label").notNull(),
  gasMatch: text("gas_match").notNull().default(""),
  // Gas pricing zone within the distributor (e.g. AGN "Central"); CDR
  // encodes it only in plan names, so it is matched against plan names.
  gasZone: text("gas_zone").notNull().default(""),
  // This address's own annual usage profile (mirrored into `settings`
  // while the address is the active one).
  elecKwh: integer("elec_kwh").notNull(),
  gasMj: integer("gas_mj").notNull(),
  elecPeakKwh: integer("elec_peak_kwh").notNull().default(1160),
  elecFlatKwh: integer("elec_flat_kwh").notNull().default(2120),
  elecShoulderKwh: integer("elec_shoulder_kwh").notNull().default(720),
  solarExportKwh: integer("solar_export_kwh").notNull().default(0),
  // This address's equipment flags + daily usage inputs (see settings).
  hasSolar: integer("has_solar").notNull().default(0),
  hasBattery: integer("has_battery").notNull().default(0),
  hasEv: integer("has_ev").notNull().default(0),
  // This address's meter tariff type (see settings.meterType).
  meterType: text("meter_type", { enum: ["single", "tou"] })
    .notNull()
    .default("single"),
  elecDailyKwh: real("elec_daily_kwh").notNull().default(11),
  selfGenDailyKwh: real("self_gen_daily_kwh").notNull().default(0),
  gasDailyMj: real("gas_daily_mj").notNull().default(139),
  // Annual cost of the plan currently in use at this address, when
  // known (entered by the user); null = unknown, and the page then
  // shows no 与现在比 comparisons for this address instead of
  // borrowing another address's figures.
  currentElecNetAnnual: integer("current_elec_net_annual"),
  currentGasAnnual: integer("current_gas_annual"),
  currentElecNote: text("current_elec_note").notNull().default(""),
  currentGasNote: text("current_gas_note").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const retailers = sqliteTable("retailers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  offers: text("offers").notNull(),
  website: text("website"),
  sortOrder: integer("sort_order").notNull(),
});
