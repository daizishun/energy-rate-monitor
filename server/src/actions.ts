// Actions for 电费气费监测 (Victorian electricity & gas rate monitor).
//
// Data sources:
//  - Live refresh: the AER Consumer Data Right (CDR) Product Reference Data
//    API at cdr.energymadeeasy.gov.au — the same feed that powers Victorian
//    Energy Compare. Unauthenticated. Plan list needs header x-v: 1, plan
//    detail needs x-v: 3. Rates in the feed are ex-GST; ×1.1 for inc-GST.
//    Plans are matched by distribution network, NOT postcode: the CDR
//    `includedPostcodes` lists do not reliably contain every postcode even
//    for the correct plans (verified by probing the live feed).
//  - Reference data: the Victorian Default Offer (VDO) figures for the
//    AusNet Services zone, and the 33 retailers listed by Victorian
//    Energy Compare (see RETAILERS below, seeded into the local database
//    on first start). No household data is bundled: the database starts
//    empty and the user adds their own address and usage.
//
// This file is the standalone (non-SDK) build: actions are plain
// `{ request, response, handler }` definitions (see ./sdk.ts) served
// over HTTP by ./index.ts, with drizzle + bun:sqlite as the store.

import { defineAction, z, type ActionsModule, type Ctx } from "./sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const rateStep = z.object({
  // Daily allowance covered by this step (kWh/day or MJ/day); null = the rest.
  upToPerDay: z.number().nullable(),
  // Inc-GST rate: c/kWh for electricity, c/MJ for gas.
  rateC: z.number(),
});

const touRates = z.object({
  peakC: z.number(),
  flatC: z.number(),
  shoulderC: z.number(),
});

const planEntry = z.object({
  retailer: z.string(),
  planName: z.string(),
  planId: z.string().nullable(),
  // Inc-GST daily supply charge, cents/day.
  supplyCPerDay: z.number(),
  // Single-rate / gas step rates (widths per day); empty for TOU elec plans.
  steps: z.array(rateStep),
  // Time-of-use electricity rates (c/kWh, inc-GST); null for single-rate.
  tou: touRates.nullable().default(null),
  // Solar feed-in tariff, c/kWh inc-GST (may be negative, e.g. Dodo -0.04c).
  feedInC: z.number().default(0),
  // Daily cap (kWh/day) the headline feed-in rate applies to; null = uncapped.
  feedInCapPerDay: z.number().nullable().default(null),
  // Feed-in rate above the cap; null = same as feedInC, 0 = nothing above cap.
  feedInAboveCapC: z.number().nullable().default(null),
  feedInNote: z.string().default(""),
  // Estimated annual cost (AUD) at the snapshot's basis usage. For
  // electricity this is the NET cost after the solar feed-in credit.
  annualAtBasis: z.number(),
  conditions: z.string(),
});

type PlanEntry = z.infer<typeof planEntry>;
type RateStep = z.infer<typeof rateStep>;

const snapshotOut = z.object({
  id: z.number(),
  takenAt: z.string(),
  source: z.enum(["research", "cdr", "pdf"]),
  status: z.enum(["ok", "partial", "error"]),
  elecPlans: z.array(planEntry),
  gasPlans: z.array(planEntry),
  elecBasisKwh: z.number(),
  gasBasisMj: z.number(),
  brandsOk: z.number(),
  brandsFailed: z.number(),
  // Whether this refresh changed that fuel's plan data vs the previous
  // data-bearing snapshot (true = 有更新， false = 没有更新）; null when
  // not applicable (baseline, failed run, or no plans for that fuel).
  elecChanged: z.boolean().nullable(),
  gasChanged: z.boolean().nullable(),
  // Display names of the brands that failed during this refresh run, so
  // the page can name exactly which sources did not come back.
  failedBrands: z.array(z.string()),
  // Retailer names (as they appear in the plan entries) whose plans in
  // this snapshot were carried over from the previous snapshot because
  // their brand failed this refresh; the page keeps those rows visible
  // and marks them 更新失败 instead of dropping the brand entirely.
  carriedOver: z.object({
    elec: z.array(z.string()),
    gas: z.array(z.string()),
  }),
  message: z.string().nullable(),
});

type SnapshotRow = typeof schema.snapshots.$inferSelect;

function parsePlans(json: string): PlanEntry[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const result = z.array(planEntry).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

function parseFailedBrands(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    const result = z.array(z.string()).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

const carriedBrandsShape = z.object({
  elec: z.array(z.string()),
  gas: z.array(z.string()),
});

function parseCarriedBrands(
  json: string | null,
): z.infer<typeof carriedBrandsShape> {
  if (!json) return { elec: [], gas: [] };
  try {
    const parsed: unknown = JSON.parse(json);
    const result = carriedBrandsShape.safeParse(parsed);
    return result.success ? result.data : { elec: [], gas: [] };
  } catch {
    return { elec: [], gas: [] };
  }
}

function toSnapshotOut(
  row: SnapshotRow,
  opts?: { fullDetail?: boolean; elecPlans?: PlanEntry[]; gasPlans?: PlanEntry[] },
): z.infer<typeof snapshotOut> {
  const fullDetail = opts?.fullDetail ?? true;
  let elecPlans = opts?.elecPlans ?? parsePlans(row.elecPlans);
  let gasPlans = opts?.gasPlans ?? parsePlans(row.gasPlans);
  if (!fullDetail) {
    // History-only snapshots: the page re-prices these for the trend
    // chart, which needs every rate field, but it never renders their
    // notes. The conditions / feed-in note strings are the bulkiest
    // text in the payload (hundreds of characters per plan, hundreds
    // of plans per snapshot), so they are blanked here — plan counts
    // and all pricing fields stay identical.
    const slim = (p: PlanEntry): PlanEntry => ({
      ...p,
      conditions: "",
      feedInNote: "",
    });
    elecPlans = elecPlans.map(slim);
    gasPlans = gasPlans.map(slim);
  }
  return {
    id: row.id,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    status: row.status,
    elecPlans,
    gasPlans,
    elecBasisKwh: row.elecBasisKwh,
    gasBasisMj: row.gasBasisMj,
    brandsOk: row.brandsOk,
    brandsFailed: row.brandsFailed,
    elecChanged: row.elecChanged == null ? null : row.elecChanged !== 0,
    gasChanged: row.gasChanged == null ? null : row.gasChanged !== 0,
    failedBrands: parseFailedBrands(row.failedBrands),
    carriedOver: parseCarriedBrands(row.carriedBrands),
    message: row.message,
  };
}

/** Key-order-insensitive JSON form, so plan lists built by different code
 * paths (PDF seed vs CDR extraction) compare by content, not key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value != null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function plansChanged(next: PlanEntry[], previous: PlanEntry[] | null): boolean {
  if (previous == null) return true;
  // CDR republishes the same offer under alternating plan ids (meter /
  // channel variants with identical name and pricing — e.g. OVO's One
  // Plan TOU appears as …734 on one run and …735 on the next). The id is
  // not a price change, so it is excluded from the comparison; counting
  // it made every refresh report 有更新 even when nothing had moved.
  const strip = (plans: PlanEntry[]) => plans.map((p) => ({ ...p, planId: null }));
  return canonical(strip(next)) !== canonical(strip(previous));
}

/** Estimated annual cost in AUD from inc-GST supply + daily step rates. */
function annualCost(
  supplyCPerDay: number,
  steps: RateStep[],
  annualUsage: number,
): number {
  const daily = annualUsage / 365;
  let remaining = daily;
  let usageCPerDay = 0;
  for (const step of steps) {
    if (remaining <= 0) break;
    const vol =
      step.upToPerDay == null ? remaining : Math.min(remaining, step.upToPerDay);
    usageCPerDay += vol * step.rateC;
    remaining -= vol;
  }
  return ((supplyCPerDay + usageCPerDay) * 365) / 100;
}

export interface UsageProfile {
  elecPeakKwh: number;
  elecFlatKwh: number;
  elecShoulderKwh: number;
  solarExportKwh: number;
  gasMj: number;
}

// Generic reference usage profile (VDO / AER benchmarks, not any
// household's actual usage): 4,000 kWh/yr electricity split by the VDO
// time-of-use load curve (peak 29% / flat 53% / shoulder 18%), no solar
// export by default, and the AER Victorian residential gas benchmark
// 50,743 MJ/yr. Kept for code that still reads an annual profile; the
// page itself prices from the three daily inputs (see DEFAULT_DAILY).
export const DEFAULT_USAGE: UsageProfile & { elecKwh: number } = {
  elecKwh: 4000,
  elecPeakKwh: 1160,
  elecFlatKwh: 2120,
  elecShoulderKwh: 720,
  solarExportKwh: 0,
  gasMj: 50743,
};

/** Solar feed-in credit (AUD/year) with the plan's daily cap applied. */
export function feedInCreditAud(plan: PlanEntry, solarExportKwh: number): number {
  if (plan.feedInC === 0 && plan.feedInAboveCapC == null) return 0;
  if (plan.feedInCapPerDay == null) return (solarExportKwh * plan.feedInC) / 100;
  const cappedKwh = Math.min(solarExportKwh, plan.feedInCapPerDay * 365);
  const aboveRate = plan.feedInAboveCapC ?? 0;
  return (
    (cappedKwh * plan.feedInC + (solarExportKwh - cappedKwh) * aboveRate) / 100
  );
}

/**
 * Net annual electricity cost (AUD) at a TOU usage profile: supply +
 * peak/flat/shoulder usage charges − solar feed-in credit. TOU plans price
 * each period separately; single-rate plans price total usage via steps.
 */
export function elecNetAnnual(plan: PlanEntry, u: UsageProfile): number {
  const supplyAud = (plan.supplyCPerDay * 365) / 100;
  let usageAud: number;
  if (plan.tou) {
    usageAud =
      (u.elecPeakKwh * plan.tou.peakC +
        u.elecFlatKwh * plan.tou.flatC +
        u.elecShoulderKwh * plan.tou.shoulderC) /
      100;
  } else {
    const total = u.elecPeakKwh + u.elecFlatKwh + u.elecShoulderKwh;
    usageAud = annualCost(0, plan.steps, total) - 0;
  }
  return supplyAud + usageAud - feedInCreditAud(plan, u.solarExportKwh);
}

// ---------------------------------------------------------------------------
// No bundled baseline snapshot: earlier builds shipped a research
// baseline seeded from a household comparison. The open-source build
// starts with an empty database; live data comes from CDR refreshes.


// No bundled PDF baseline: earlier builds shipped a household
// comparison (59 electricity plans + 20 gas offers) collected for one
// address. The open-source build starts with an empty database; live
// data comes from CDR refreshes for the user's own address.

// The 33 retailers on https://compare.energy.vic.gov.au/retailers as verified
// 19 Nov 2026. `offers` is the offer list as shown on that page. Websites are
// the retailers' main sites as listed by EnergySorted (the VEC page itself
// publishes URLs only inside per-retailer pop-ups; only AGL's was opened, and
// it is the exact URL below). Four retailers had no obtainable website and
// are stored with website = null — shown without a link, never invented.
export const RETAILERS: { name: string; offers: string; website: string | null }[] = [
  { name: "1st Energy", offers: "Elec, Res, Gas, Bus", website: "https://1stenergy.com.au" },
  { name: "1st Energy (EL Retail Energy)", offers: "Elec, Res, Gas, Bus", website: "https://1stenergy.com.au" },
  { name: "AGL", offers: "Elec, Res, Gas, Bus", website: "https://www.agl.com.au/viccompare" },
  { name: "Alinta Energy", offers: "Elec, Res, Gas, Bus", website: "https://alintaenergy.com.au" },
  { name: "Amber Electric", offers: "Elec, Res, Bus", website: "https://amber.com.au" },
  { name: "Arcline by RACV - Energy", offers: "Elec, Res, Gas", website: null },
  { name: "Blue NRG Pty Ltd", offers: "Elec, Res, Bus", website: "https://bluenrg.com.au" },
  { name: "CovaU", offers: "Elec, Res, Gas, Bus", website: "https://covau.com.au" },
  { name: "Diamond Energy Pty Ltd", offers: "Elec, Res, Bus", website: "https://diamondenergy.com.au" },
  { name: "Dodo Power & Gas", offers: "Elec, Res, Gas, Bus", website: "https://dodo.com" },
  { name: "Energy Locals Urban", offers: "Elec, Res, Bus", website: "https://energylocals.com.au" },
  { name: "EnergyAustralia", offers: "Elec, Res, Gas, Bus", website: "https://energyaustralia.com.au" },
  { name: "ENGIE", offers: "Elec, Res, Gas, Bus", website: "https://engie.com.au" },
  { name: "Flipped Energy", offers: "Elec, Res, Bus", website: "https://flipped.energy" },
  { name: "Flow Power", offers: "Elec, Res, Bus", website: "https://flowpower.com.au" },
  { name: "GloBird Energy", offers: "Elec, Res, Gas, Bus", website: "https://globirdenergy.com.au" },
  { name: "Indigo Power", offers: "Elec, Res, Bus", website: null },
  { name: "Kogan Energy", offers: "Elec, Res, Gas", website: "https://koganenergy.com.au" },
  { name: "Lumo Energy", offers: "Elec, Res, Gas, Bus", website: "https://lumoenergy.com.au" },
  { name: "Momentum Energy", offers: "Elec, Res, Gas, Bus", website: "https://momentumenergy.com.au" },
  { name: "Nectr", offers: "Elec, Res, Bus", website: "https://nectr.com.au" },
  { name: "Next Business Energy Pty Ltd", offers: "Elec, Res, Bus", website: "https://nextbusinessenergy.com.au" },
  { name: "Origin Energy", offers: "Elec, Res, Gas, Bus", website: "https://originenergy.com.au" },
  { name: "OVO Energy", offers: "Elec, Res, Bus", website: "https://ovoenergy.com.au" },
  { name: "Pacific Blue Retail", offers: "Elec, Res, Bus", website: null },
  { name: "Perpetual Energy Pty Ltd", offers: "Gas, Bus only", website: null },
  { name: "Powershop Australia", offers: "Elec, Res, Gas, Bus", website: "https://powershop.com.au" },
  { name: "Real Utilities", offers: "Elec, Res, Bus", website: "https://realutilities.com.au" },
  { name: "Red Energy", offers: "Elec, Res, Gas, Bus", website: "https://redenergy.com.au" },
  { name: "SmartestEnergy", offers: "Elec, Bus only", website: "https://smartestenergy.com" },
  { name: "Solstice Energy Retail Pty Ltd", offers: "Res, Gas, Bus", website: "https://solsticeenergy.com.au" },
  { name: "Sumo", offers: "Elec, Res, Gas, Bus", website: "https://sumo.com.au" },
  { name: "Tango Energy", offers: "Elec, Res, Gas, Bus", website: "https://tangoenergy.com.au" },
];

// ---------------------------------------------------------------------------
// CDR live refresh
// ---------------------------------------------------------------------------

const CDR_BASE = "https://cdr.energymadeeasy.gov.au";

// Brand slugs on the CDR host (electricity and gas brands are separate for
// Sumo). The first 18 were verified HTTP 200 against the live feed on
// 2026-11-19. Later that day the list was expanded retailer-by-retailer
// against the full 33-row Victorian Energy Compare table (the user's
// 「扩到33家，逐家探查补上」): every VEC retailer was probed on this host,
// and the 8 slugs below were added because each publishes residential
// plans for this address's networks (AusNet electricity / AGN gas) in a
// pricing model extractEntry can price. The retailers probed but NOT
// added, with the live-probe result for each (2026-11-19):
//  - Arcline by RACV: 0 plan records under every slug variant tried.
//  - Pacific Blue Retail: 0 plan records (and it does not serve metropolitan Melbourne postcodes).
//  - Perpetual Energy ("perpetual"): 24 gas plans, ALL business — VEC
//    lists it as Gas/Bus only; no residential plans exist to poll.
//  - SmartestEnergy ("smartestenergy"): 5 plans, all business (VEC:
//    Bus only).
//  - Energy Locals Urban ("energy-locals-urban"): 14 plans, but its
//    distributors are interstate networks only (embedded networks) —
//    nothing on AusNet.
//  - Real Utilities ("real-utilities"): its only residential standing
//    offer is for United Energy, not AusNet (embedded networks).
//  - Solstice Energy Retail: the CDR "solstice" brand is TasNetworks
//    (Tasmania) electricity — a different market, not the Victorian
//    rural-gas retailer, which publishes nothing for AGN here.
//  - 1st Energy (EL Retail Energy): a second VEC listing of the 1st
//    Energy group; its plans ride on the "energy-locals" slug (below)
//    but none match AusNet residential / AGN residential.
// The "energy-locals" slug itself is Energy Locals' CDR channel, which
// also publishes Indigo Power's plans — all 17 of its AusNet residential
// electricity matches carry brandName "Indigo Power", and Indigo has no
// slug of its own on this host (0 records), so this slug is how Indigo
// is covered.
const CDR_BRANDS = [
  "globird",
  "1st-energy",
  "sumo-power",
  "sumo-gas",
  "ovo-energy",
  "tango",
  "alinta",
  "dodo",
  "kogan",
  "momentum",
  "agl",
  "origin",
  "energyaustralia",
  "red-energy",
  "powershop",
  "lumo",
  "engie",
  "covau",
  "amber",
  "blue-nrg",
  "diamond",
  "energy-locals",
  "flipped",
  "flow-power",
  "nectr",
  "next-business",
];

const MAX_DETAIL_FETCHES_PER_BRAND = 80;
const DETAIL_CONCURRENCY = 8;

// Display names for the CDR brand slugs above (retailer names as listed
// by Victorian Energy Compare), used to tell the user exactly which
// sources failed during a refresh.
const CDR_BRAND_NAMES: Record<string, string> = {
  globird: "GloBird Energy",
  "1st-energy": "1st Energy",
  "sumo-power": "Sumo（电）",
  "sumo-gas": "Sumo（气）",
  "ovo-energy": "OVO Energy",
  tango: "Tango Energy",
  alinta: "Alinta Energy",
  dodo: "Dodo Power & Gas",
  kogan: "Kogan Energy",
  momentum: "Momentum Energy",
  agl: "AGL",
  origin: "Origin Energy",
  energyaustralia: "EnergyAustralia",
  "red-energy": "Red Energy",
  powershop: "Powershop",
  lumo: "Lumo Energy",
  engie: "ENGIE",
  covau: "CovaU",
  amber: "Amber Electric",
  "blue-nrg": "Blue NRG",
  diamond: "Diamond Energy",
  // The plans this slug returns for this address are Indigo Power's.
  "energy-locals": "Indigo Power",
  flipped: "Flipped Energy",
  "flow-power": "Flow Power",
  nectr: "Nectr",
  "next-business": "Next Business Energy",
};

// Retailer-name keys (lowercased) each CDR brand publishes its plans
// under — the `brandName` values seen live in CDR plan details ("OVO
// Energy", "GloBird Energy", "EnergyAustralia", "Powershop", "Sumo", …).
// Used to find a failed brand's plans in the previous snapshot so they
// can be carried over instead of vanishing from the ranking.
const CDR_BRAND_RETAILER_KEYS: Record<string, string[]> = {
  globird: ["globird"],
  "1st-energy": ["1st energy"],
  "sumo-power": ["sumo"],
  "sumo-gas": ["sumo"],
  "ovo-energy": ["ovo"],
  tango: ["tango"],
  alinta: ["alinta"],
  dodo: ["dodo"],
  kogan: ["kogan"],
  momentum: ["momentum"],
  agl: ["agl"],
  origin: ["origin"],
  energyaustralia: ["energyaustralia", "energy australia"],
  "red-energy": ["red energy"],
  powershop: ["powershop"],
  lumo: ["lumo"],
  engie: ["engie"],
  covau: ["covau"],
  amber: ["amber"],
  "blue-nrg": ["blue nrg"],
  diamond: ["diamond"],
  "energy-locals": ["indigo"],
  flipped: ["flipped"],
  "flow-power": ["flow power"],
  nectr: ["nectr"],
  "next-business": ["next business"],
};

function retailerMatchesBrand(retailer: string, brandSlug: string): boolean {
  const norm = retailer.toLowerCase().replace(/\s+/g, " ").trim();
  return (CDR_BRAND_RETAILER_KEYS[brandSlug] ?? []).some(
    (k) => norm === k || norm.startsWith(`${k} `),
  );
}

interface CdrPlanSummary {
  planId?: string;
  type?: string;
  fuelType?: string;
  brandName?: string;
  displayName?: string;
  customerType?: string;
  geography?: { distributors?: string[]; includedPostcodes?: string[] };
}

interface CdrRate {
  volume?: number;
  unitPrice?: string;
}

interface CdrTouRate {
  // PEAK / OFF_PEAK / SHOULDER on paper — but in the live feed nearly
  // every period is labelled SHOULDER (verified for OVO, AGL, Tango,
  // Alinta and GloBird on 2026-11-19); the time windows are the truth.
  type?: string;
  rates?: CdrRate[];
  timeOfUse?: { days?: string[]; startTime?: string; endTime?: string }[];
}

interface CdrTimeVariation {
  days?: string[];
  startTime?: string;
  endTime?: string;
}

interface CdrFeedInVariation {
  type?: string;
  rates?: CdrRate[];
  // The live feed names a feed-in variation's windows `timeVariations`
  // (usage TOU rates use `timeOfUse` instead); accept both.
  timeVariations?: CdrTimeVariation[];
  timeOfUse?: CdrTimeVariation[];
}

interface CdrSolarTariff {
  singleTariff?: { rates?: CdrRate[] };
  timeVaryingTariffs?:
    | { timeVaryingTariff?: CdrFeedInVariation[] }
    | CdrFeedInVariation[];
}

interface CdrTariffPeriod {
  startDate?: string;
  endDate?: string;
  dailySupplyCharge?: string;
  rateBlockUType?: string;
  singleRate?: { rates?: CdrRate[] };
  timeOfUseRates?: CdrTouRate[];
}

interface CdrContract {
  pricingModel?: string;
  tariffPeriod?: CdrTariffPeriod[];
  // The live feed returns an ARRAY of tariff objects; reading it as a
  // single object (as this code originally did) silently yields no
  // feed-in rate at all.
  solarFeedInTariff?: CdrSolarTariff | CdrSolarTariff[];
  // Descriptive fields the retailer itself publishes about how the
  // plan is priced and who it is for. `variation` explains variable /
  // wholesale pricing mechanisms, `eligibility` carries restrictions
  // and estimate bases (text rides in `information` for most brands,
  // in `description` for Amber), and `discounts` carries conditional
  // offers (sign-up credits and the like) that the annual figure does
  // NOT price in. All three were discarded before 2026-11-20, which is
  // why a wholesale-estimate plan read like a fixed tariff on the page.
  variation?: string;
  eligibility?: { type?: string; information?: string; description?: string }[];
  discounts?: { type?: string; displayName?: string; description?: string }[];
}

interface CdrPlanDetail extends CdrPlanSummary {
  electricityContract?: CdrContract;
  gasContract?: CdrContract;
}

async function fetchJson<T>(url: string, version: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "x-v": version, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** "HH:MM" → minutes since midnight; null when unparseable. */
function parseHhMm(value: string | undefined): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  if (h == null || m == null || !Number.isFinite(h) || !Number.isFinite(m)) {
    return null;
  }
  return h * 60 + m;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** "MM-DD" range check for a tariff period; periods wrap over New Year. */
function periodCoversToday(tp: CdrTariffPeriod, todayMmDd: string): boolean {
  const start = tp.startDate ?? "01-01";
  const end = tp.endDate ?? "12-31";
  if (start <= end) return todayMmDd >= start && todayMmDd <= end;
  return todayMmDd >= start || todayMmDd <= end;
}

function extractEntry(
  detail: CdrPlanDetail,
  fuel: "ELECTRICITY" | "GAS",
  usage: UsageProfile,
): PlanEntry | null {
  const contract =
    fuel === "ELECTRICITY" ? detail.electricityContract : detail.gasContract;
  if (!contract) return null;
  const name = detail.displayName ?? "";
  // Skip controlled-load variants (the no-CL household in scope has no CL
  // meter); "Without Controlled Load" plans are kept.
  if (/with controlled load/i.test(name)) return null;
  if (/\bwith cl\b/i.test(name) && !/without/i.test(name)) return null;
  // Battery and EV plans are extracted and STORED like every other plan
  // (user request 2026-11-20: a refresh fetches ALL of the address's
  // data; only an address change re-fetches). Whether they apply is a
  // DISPLAY condition, not a fetch condition: the page hides
  // battery-named plans unless 电池 is ticked and EV-named plans unless
  // 电车 is ticked, so toggling a checkbox re-displays the already
  // fetched data instead of triggering a new fetch. (Before this, the
  // exclusion happened here at extraction time — 2026-11-19: with no
  // battery, Origin Battery Earner ranked #1 at $645/yr on a 26.5c
  // evening battery-discharge feed-in the household could not earn.)

  const periods = contract.tariffPeriod ?? [];
  const now = new Date();
  const mmDd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const toC = (unitPrice: string | undefined): number | null => {
    const unit = Number(unitPrice);
    if (!Number.isFinite(unit)) return null;
    return Math.round(unit * 110 * 10000) / 10000; // $ ex-GST → c inc-GST
  };

  // Solar feed-in (electricity only), from the contract's feed-in tariff.
  // The unit price is the rate as paid ("incl. GST if any" — residential
  // feed-in carries no GST), so it converts at ×100 to cents WITHOUT the
  // ×1.1 GST uplift applied to usage rates. Verified against retailer
  // quotes on 2026-11-19: OVO 0.014 = the 1.4c/kWh on OVO's website
  // quote for this address, AGL 0.005 = its published 0.5c, Tango and
  // Alinta 0.0004 = 0.04c — all matching the user's PDF baseline.
  //
  // Two feed-in structures the first version of this parser priced
  // wrong (user report 2026-11-19; every figure below verified against
  // the raw CDR detail payloads that day):
  //  - Tiered single tariffs: rates[0].volume is a DAILY cap in kWh and
  //    rates[1] is the rate above it. EnergyAustralia Solar Max pays 8c
  //    for the first 10 kWh/day, then 1.5c; crediting 8c on all 6,025
  //    kWh of export overstated the credit by ~$154/yr.
  //  - Time-varying tariffs: the first variation's rate often applies
  //    only to an evening window, when solar panels export ~nothing.
  //    Origin Battery Earner: 26.5c at 17:00–21:00, 1c otherwise (a
  //    battery plan — stored like the rest, shown only when 电池 is
  //    ticked). CovaU SolarMax: 15c
  //    at 18:00–21:00, 5c otherwise. GloBird FULLHOUSE: 3c at
  //    16:00–21:00 but ~0c at 10:00–14:00, the peak export hours.
  //    Applying those headline rates to all export overstated credits
  //    by $130–$1,500/yr and put these plans on top of the ranking.
  //    Solar export happens in daylight, so a time-varying tariff is
  //    priced as its average rate over the export hours 07:00–19:00.
  let feedInC = 0;
  let feedInCapPerDay: number | null = null;
  let feedInAboveCapC: number | null = null;
  let feedInNote = "";
  if (fuel === "ELECTRICITY" && contract.solarFeedInTariff) {
    const tariffs = Array.isArray(contract.solarFeedInTariff)
      ? contract.solarFeedInTariff
      : [contract.solarFeedInTariff];
    const toFeedC = (unitPrice: string | undefined): number | null => {
      const dollars = Number(unitPrice);
      return Number.isFinite(dollars) ? round4(dollars * 100) : null;
    };
    // Prefer a flat (single) tariff when the plan publishes one, keeping
    // its daily tier cap when present.
    for (const t of tariffs) {
      const rates = t.singleTariff?.rates ?? [];
      const first = rates[0];
      if (!first) continue;
      const rateC = toFeedC(first.unitPrice);
      if (rateC == null) continue;
      feedInC = rateC;
      if (typeof first.volume === "number" && first.volume > 0) {
        feedInCapPerDay = first.volume;
        feedInAboveCapC = toFeedC(rates[1]?.unitPrice) ?? 0;
      }
      break;
    }
    if (feedInCapPerDay == null && feedInC === 0) {
      // No flat tariff published — average the time-varying rates over
      // the solar export hours (07:00–19:00) instead of taking the
      // first (evening-premium) variation at face value.
      const variations: CdrFeedInVariation[] = [];
      for (const t of tariffs) {
        const varying = t.timeVaryingTariffs;
        if (Array.isArray(varying)) variations.push(...varying);
        else if (varying?.timeVaryingTariff) {
          variations.push(...varying.timeVaryingTariff);
        }
      }
      const windows: { start: number; end: number; rateC: number }[] = [];
      for (const v of variations) {
        const rateC = toFeedC(v.rates?.[0]?.unitPrice);
        if (rateC == null) continue;
        for (const w of v.timeVariations ?? v.timeOfUse ?? []) {
          const start = parseHhMm(w.startTime);
          const end = parseHhMm(w.endTime);
          if (start == null || end == null || start === end) continue;
          windows.push({ start, end, rateC });
        }
      }
      if (windows.length > 0) {
        let sum = 0;
        let covered = 0;
        for (let minute = 420; minute < 1140; minute += 1) {
          const rate = windows.find((w) =>
            w.start < w.end
              ? minute >= w.start && minute < w.end
              : minute >= w.start || minute < w.end,
          )?.rateC;
          if (rate == null) continue;
          sum += rate;
          covered += 1;
        }
        if (covered >= 360) {
          feedInC = round4(sum / covered);
          const shown = String(Math.round(feedInC * 100) / 100);
          feedInNote = `分时回购，白天出线时段（7–19 点）均价约 ${shown}c/kWh（晚间高价时段太阳能不出线，未按晚间价计）`;
        } else {
          // The windows barely cover the export hours; fall back to the
          // first published rate rather than dropping the tariff.
          feedInC = toFeedC(variations[0]?.rates?.[0]?.unitPrice) ?? 0;
        }
      }
    }
  }

  // Plan notes, built from the contract's own descriptive fields (user
  // request 2026-11-20: 就算勾了电池，是批发价这种情况要注明详细，其他
  // 套餐有特殊说明也要注明）. Wholesale / variable-priced plans — Flow
  // Power "Variable Prices (estimate)", Amber "Variable Wholesale
  // Prices (estimate)" — publish only ESTIMATE rates in CDR: the real
  // price floats with the wholesale market, so the annual figure below
  // is an estimate at the published rates, not a fixed-tariff quote.
  // Those rows get a Chinese explanation of the mechanism. For
  // wholesale plans the substantive eligibility facts (solar /
  // battery / smart meter requirements, the system size an estimate
  // is based on) and discount terms (NOT priced into the annual
  // figure) are extracted from the retailer's text and restated as
  // Chinese summaries (see eligibilitySummaryZh / discountSummaryZh
  // below); other plans' retailer text is translated to Chinese in
  // runRefresh before storage. Either way the visible note is
  // Chinese; the retailer's English original is stored separately
  // as 原文｜ lines and shown collapsed behind an expand toggle
  // (user request 2026-11-20: 有备注的原文都翻译一下，且隐藏原文
  // 用类似向下箭头点击可展开 — supersedes the same day's earlier
  // "hide wholesale originals entirely").
  // Boilerplate is filtered out: nearly every market offer publishes a
  // "rates may vary … in accordance with the terms" variation line and
  // an "available to all customers / contact us" eligibility line
  // (verified live 2026-11-20 for OVO, AGL, GloBird), which would bury
  // the signal the user asked for.
  const cleanText = (s: string | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();
  const variation = cleanText(contract.variation);
  // Amber's FIXED standing offers mention wholesale only to deny it
  // ("This is a fixed tariff. You will not get access to the wholesale
  // rate.") — that vetoes the wholesale match below.
  const fixedTariffNote =
    /this is a fixed tariff|not get access to the wholesale|no access to the wholesale/i.test(
      variation,
    );
  const variablePriced =
    fuel === "ELECTRICITY" &&
    !fixedTariffNote &&
    (/wholesale/i.test(name) ||
      /wholesale/i.test(variation) ||
      (/variable/i.test(name) && /estimate/i.test(name)) ||
      /price efficiency adjustment/i.test(variation) ||
      (/not fixed/i.test(variation) && /estimate/i.test(variation)) ||
      /spot price|pass[- ]through/i.test(variation));
  // Chinese summaries of a wholesale plan's eligibility / discount
  // text: the facts are extracted from the retailer's own words —
  // equipment the offer requires, the system sizes the published
  // estimate is based on, a discount's amount and its new-customer /
  // minimum-stay terms — and restated in Chinese, so the visible note
  // stays detailed; the verbatim English rides along separately as
  // 原文｜ lines for the expandable block. A line with no extractable
  // fact yields "" and its visible line is dropped.
  const eligibilitySummaryZh = (text: string): string => {
    const parts: string[] = [];
    const needs: string[] = [];
    if (/solar/i.test(text)) needs.push("太阳能");
    if (/battery/i.test(text)) needs.push("电池");
    if (/\bEV\b|electric vehicle/i.test(text)) needs.push("电动车");
    if (/smart meter/i.test(text)) needs.push("智能电表");
    if (needs.length > 0 && /only available|must|require/i.test(text)) {
      parts.push(`仅限有${needs.join("、")}的客户`);
    }
    const basis: string[] = [];
    const solarKw = /solar system of ([\d.]+)\s*kW/i.exec(text)?.[1];
    if (solarKw) basis.push(`太阳能 ${solarKw}kW`);
    const batteryKwh = /battery system of ([\d.]+)\s*kWh/i.exec(text)?.[1];
    if (batteryKwh) basis.push(`电池 ${batteryKwh}kWh`);
    const evKm = /driving distance of ([\d,]+)\s*km/i.exec(text)?.[1];
    if (evKm) basis.push(`电动车年行驶 ${evKm} 公里`);
    const conv = /conversion of ([\d.]+)\s*kWh per 100\s*km/i.exec(text)?.[1];
    if (conv) basis.push(`按 ${conv}kWh/100 公里换算`);
    if (basis.length > 0 && /estimate/i.test(text)) {
      parts.push(`公布的估算价基于${basis.join("、")}`);
    }
    return parts.join("；");
  };
  const discountSummaryZh = (label: string, text: string): string => {
    const parts: string[] = [];
    const amount =
      /\$([\d,]+(?:\.\d+)?)/.exec(text)?.[1] ??
      /\$([\d,]+(?:\.\d+)?)/.exec(label)?.[1];
    if (amount) {
      const inclGst =
        /incl\.?\s*gst/i.test(text) || /incl\.?\s*gst/i.test(label);
      parts.push(`$${amount} 优惠${inclGst ? "（含税）" : ""}`);
    }
    if (/new\b[^.]*customers only/i.test(text)) parts.push("仅限新客户");
    const months = /stay[^.]*for (\d+) months/i.exec(text)?.[1];
    if (months) parts.push(`需连续使用 ${months} 个月`);
    const perBill = /\$([\d.]+) credit[^.]*first (\w+) \w* bills/i.exec(text);
    if (perBill?.[1] && perBill[2]) {
      const word = perBill[2].toLowerCase();
      const count = word === "six" ? "6" : word === "twelve" ? "12" : word;
      parts.push(`前 ${count} 张账单每张抵 $${perBill[1]}`);
    }
    return parts.join("，");
  };
  const noteParts: string[] = [];
  // The retailer's original English segments, kept apart from the
  // visible note: each is stored as an extra conditions line prefixed
  // 原文｜, and the page renders those lines collapsed behind a
  // 「零售商原文 ▾」 toggle (user request 2026-11-20: 有备注的原文都
  // 翻译一下，且隐藏原文用类似向下箭头点击可展开）. The visible note
  // shows Chinese only — for wholesale plans the summaries below, for
  // other plans a translation produced in runRefresh
  // (translateNoteOriginals), which rewrites the （零售商原文） lines
  // before the snapshot is stored.
  const originalParts: string[] = [];
  if (variablePriced) {
    noteParts.push(
      "批发可变价（估算）：电价跟着批发市场走、不是固定价，CDR 公布的费率只是估算值，下面的年费按估算费率计算，实际账单会随用电时段和批发价浮动，可能明显高于或低于这个数",
    );
    // The wholesale mechanism line above carries the substance in
    // Chinese; the retailer's own pricing text still goes to the
    // expandable original block, like every other plan's.
    if (variation) originalParts.push(`价格说明：${variation}`);
  } else if (
    variation &&
    // A non-variable plan's variation line is shown only when it says
    // something specific — a fixed-until date, an annual review tied
    // to network tariffs, rates stated as not fixed, a free window.
    // The generic "we may vary your rates in line with our terms /
    // subject to change with notice" clause nearly every retailer
    // publishes (32 AGL-style variants in one refresh) is not.
    /not fixed|fixed until|fixed for|review|adjustment|index|spot price|0c\/kWh/i.test(
      variation,
    )
  ) {
    noteParts.push(`价格说明（零售商原文）：${variation}`);
    originalParts.push(`价格说明：${variation}`);
  }
  for (const e of contract.eligibility ?? []) {
    const text = cleanText(e.information ?? e.description);
    if (!text) continue;
    // Only restrictions / estimate bases are signal; "available to all
    // customers" and "contact us for eligibility" lines are not.
    if (!/only available|must|require|estimate based|smart meter/i.test(text)) {
      continue;
    }
    if (variablePriced) {
      // Wholesale plan: Chinese summary of the facts in the visible
      // note; the retailer's text itself goes to the expandable
      // original block. Nothing extractable → the visible line is
      // omitted (the original is still one tap away).
      originalParts.push(`适用条件：${text}`);
      const summary = eligibilitySummaryZh(text);
      const line = summary ? `适用条件：${summary}` : "";
      if (line && !noteParts.includes(line)) noteParts.push(line);
    } else {
      noteParts.push(`适用条件（零售商原文）：${text}`);
      originalParts.push(`适用条件：${text}`);
    }
  }
  for (const d of contract.discounts ?? []) {
    const text = cleanText(d.description);
    if (!text) continue;
    const label = cleanText(d.displayName);
    if (variablePriced) {
      // Wholesale plan: Chinese summary (amount / new-customer /
      // minimum-stay facts); the not-priced-in signal is kept even
      // when no specific fact can be extracted.
      originalParts.push(
        `优惠条件：${label ? `${label} — ` : ""}${text}`,
      );
      const summary = discountSummaryZh(label, text);
      const line = summary
        ? `优惠条件（年费未计此优惠）：${summary}`
        : "优惠条件：有未计入年费的优惠，细则见零售商套餐说明";
      if (!noteParts.includes(line)) noteParts.push(line);
    } else {
      noteParts.push(
        `优惠条件（年费未计此优惠，零售商原文）：${label ? `${label} — ` : ""}${text}`,
      );
      originalParts.push(
        `优惠条件：${label ? `${label} — ` : ""}${text}`,
      );
    }
  }
  const conditions = [
    ...noteParts,
    ...originalParts.map((p) => `原文｜${p}`),
  ]
    .map((p) => (p.length > 700 ? `${p.slice(0, 700)}…` : p))
    .join("\n");

  const base = {
    retailer: detail.brandName ?? "Unknown",
    planName: name,
    planId: detail.planId ?? null,
    feedInC,
    feedInCapPerDay,
    feedInAboveCapC,
    feedInNote,
    conditions,
  };

  if (
    contract.pricingModel === "SINGLE_RATE" ||
    contract.pricingModel === "SINGLE_RATE_CONT_LOAD"
  ) {
    const period =
      periods.find(
        (tp) => tp.rateBlockUType === "singleRate" && periodCoversToday(tp, mmDd),
      ) ??
      periods.find((tp) => tp.rateBlockUType === "singleRate") ??
      periods[0];
    if (!period || !period.singleRate?.rates?.length) return null;
    const supplyRaw = Number(period.dailySupplyCharge);
    if (!Number.isFinite(supplyRaw)) return null;
    const steps: RateStep[] = [];
    for (const rate of period.singleRate.rates) {
      const rateC = toC(rate.unitPrice);
      if (rateC == null) return null;
      steps.push({
        upToPerDay: typeof rate.volume === "number" ? rate.volume : null,
        rateC,
      });
    }
    const supplyCPerDay = Math.round(supplyRaw * 110 * 100) / 100;
    const entry: PlanEntry = {
      ...base,
      supplyCPerDay,
      steps,
      tou: null,
      annualAtBasis: 0,
    };
    entry.annualAtBasis = Math.round(
      fuel === "ELECTRICITY"
        ? elecNetAnnual(entry, usage)
        : annualCost(supplyCPerDay, steps, usage.gasMj),
    );
    return entry;
  }

  // Time-of-use electricity: map the plan's TOU rates onto the household's
  // peak / flat / shoulder split (see the window-pricing note below).
  // Controlled-load variants share the same main rates and this household
  // has no controlled-load usage to price, so they are extracted the same
  // way; the cheapest variant per retailer wins later. Gas TOU is not
  // priced.
  if (
    fuel === "ELECTRICITY" &&
    (contract.pricingModel === "TIME_OF_USE" ||
      contract.pricingModel === "TIME_OF_USE_CONT_LOAD")
  ) {
    const period =
      periods.find(
        (tp) => tp.rateBlockUType === "timeOfUseRates" && periodCoversToday(tp, mmDd),
      ) ??
      periods.find((tp) => tp.rateBlockUType === "timeOfUseRates") ??
      periods.find((tp) => (tp.timeOfUseRates ?? []).length > 0);
    const touRates = period?.timeOfUseRates ?? [];
    if (!period || touRates.length === 0) return null;
    const supplyRaw = Number(period.dailySupplyCharge);
    if (!Number.isFinite(supplyRaw)) return null;
    // Price each minute of the day from the TOU window covering it, then
    // average within the household's periods — peak 16–21, shoulder
    // 11–16, flat 21–11 (usage assumed uniform inside a period). Keying
    // off the CDR `type` field instead was the bug the user caught on
    // 2026-11-19: nearly every period is labelled SHOULDER in the live
    // feed, so OVO's One Plan time-of-use variant (supply 102.586c,
    // 38.104 / 18.073 / 9.9c, exactly OVO's website quote for this
    // address) collapsed to one rate, failed extraction, and only its
    // single-rate variant (100.02c + 24.94c) was shown, overstating
    // OVO by $233/yr. First-tier rates are used (rates[0]); this
    // household uses only a few kWh/day in any one period, inside the
    // first tier of every probed plan.
    const windowRates: { start: number; end: number; rateC: number }[] = [];
    for (const tr of touRates) {
      const rateC = toC(tr.rates?.[0]?.unitPrice);
      if (rateC == null) return null;
      for (const w of tr.timeOfUse ?? []) {
        const start = parseHhMm(w.startTime);
        const end = parseHhMm(w.endTime);
        if (start == null || end == null || start === end) continue;
        windowRates.push({ start, end, rateC });
      }
    }
    let tou: { peakC: number; flatC: number; shoulderC: number } | null = null;
    if (windowRates.length > 0) {
      const sums = { peak: 0, flat: 0, shoulder: 0 };
      const counts = { peak: 0, flat: 0, shoulder: 0 };
      for (let minute = 0; minute < 1440; minute += 1) {
        const rate = windowRates.find((w) =>
          w.start < w.end
            ? minute >= w.start && minute < w.end
            : minute >= w.start || minute < w.end,
        )?.rateC;
        if (rate == null) continue;
        const periodKey =
          minute >= 960 && minute < 1260
            ? "peak"
            : minute >= 660 && minute < 960
              ? "shoulder"
              : "flat";
        sums[periodKey] += rate;
        counts[periodKey] += 1;
      }
      // Household periods run 300 / 300 / 840 minutes; require ≥80%
      // window coverage of each, else the plan cannot be priced
      // honestly against this household's split.
      if (counts.peak >= 240 && counts.shoulder >= 240 && counts.flat >= 672) {
        tou = {
          peakC: round4(sums.peak / counts.peak),
          flatC: round4(sums.flat / counts.flat),
          shoulderC: round4(sums.shoulder / counts.shoulder),
        };
      }
    }
    if (!tou) {
      // Fallback for a feed that labels periods by type, without windows.
      const byType = new Map<string, number>();
      for (const tr of touRates) {
        const rateC = toC(tr.rates?.[0]?.unitPrice);
        if (rateC == null || !tr.type) return null;
        byType.set(tr.type.toUpperCase(), rateC);
      }
      const peakC = byType.get("PEAK");
      const flatC = byType.get("OFF_PEAK") ?? byType.get("FLAT");
      const shoulderC = byType.get("SHOULDER") ?? flatC;
      if (peakC == null || flatC == null || shoulderC == null) return null;
      tou = { peakC, flatC, shoulderC };
    }
    // Free-window tariffs (1st Energy / Flow Power Midday Power
    // Saver: a midday window at 0c up to a daily cap, then a paid
    // rate) minute-average into a blended bucket rate above — 7.904c
    // for the shoulder bucket — that appears in NO fact sheet, and
    // the plan's defining feature (the free window) was invisible on
    // the page, so a user checking the plan against its official
    // fact sheet saw a rate that does not exist and concluded the
    // data was wrong (user report 2026-11-20, with the 1ST804532SR
    // fact sheet: 11:00–14:00 free for the first 24 kWh/day, then
    // 19.76c; 14:00–16:00 at 19.76c — CDR rates verified identical).
    // Restate the real window structure as a Chinese note on the
    // entry, unless the retailer's own text already describes it
    // (Flow Power's variation line does; 1st Energy's is boilerplate
    // and was filtered out above, leaving its Midday row bare).
    let touConditions = conditions;
    if (!/免费时段|0c\/kWh/i.test(conditions)) {
      const freeParts: string[] = [];
      for (const tr of touRates) {
        const first = tr.rates?.[0];
        if (!first || Number(first.unitPrice) !== 0) continue;
        const wins = (tr.timeOfUse ?? [])
          .map((w) => `${w.startTime ?? ""}–${w.endTime ?? ""}`)
          .filter((s) => s.length > 1);
        if (wins.length === 0) continue;
        let part = `免费时段：每天 ${wins.join("、")} 用电免费`;
        if (typeof first.volume === "number" && first.volume > 0) {
          part += `（前 ${first.volume} 度）`;
        }
        const aboveC = toC(tr.rates?.[1]?.unitPrice);
        if (aboveC != null) {
          part += `，超出按 ${String(Math.round(aboveC * 100) / 100)}c/kWh 计`;
        }
        freeParts.push(part);
      }
      if (freeParts.length > 0) {
        const note = `${freeParts.join("；")}。本页分时价是把免费时段摊进所在时段后的均价，所以比费率单上的付费价低`;
        touConditions = conditions ? `${conditions}\n${note}` : note;
      }
    }
    const supplyCPerDay = Math.round(supplyRaw * 110 * 100) / 100;
    const entry: PlanEntry = {
      ...base,
      conditions: touConditions,
      supplyCPerDay,
      steps: [],
      tou,
      annualAtBasis: 0,
    };
    entry.annualAtBasis = Math.round(elecNetAnnual(entry, usage));
    return entry;
  }
  return null;
}

interface BrandResult {
  elec: PlanEntry[];
  gas: PlanEntry[];
}

/** Distribution networks of the address a refresh runs for: CDR
 * geography substrings (lowercase) per fuel. An empty gas match means
 * the address has no gas connection, so no gas plans are polled. */
export interface AddressNetworks {
  elecMatch: string;
  gasMatch: string;
}

/**
 * Zone-sibling rule (bug found 2026-11-20, user report 数据还是不对）:
 * a retailer often publishes several variants of the SAME plan name
 * for the SAME distributor, one per pricing zone, distinguishable
 * only by their includedPostcodes lists — e.g. Sumo's gas "Online
 * Saver Plus" on Australian Gas Networks: SUM814842MR lists the
 * Melbourne postcodes, SUM814843MR lists regional
 * Victoria only (Shepparton / Echuca …). Matching
 * by distributor name alone kept both, and at the page's gas usage
 * the regional variant priced $16/yr cheaper, so the ranking's #1
 * gas plan — and the 最优组合 — was a plan this address cannot buy.
 * The zone filter by plan NAME (preferGasZone) cannot catch these:
 * Sumo's names carry no zone word.
 *
 * Rule, deliberately narrow so it cannot reproduce the rejected
 * blanket postcode filter (a plan with no same-name sibling is
 * never dropped, even when its own list omits the postcode — see
 * DATA-PLAN): within a same-name group, drop a variant only when a
 * sibling variant's list DOES contain the address postcode while
 * this variant's non-empty list does NOT. A variant that explicitly
 * lists the postcode is definitionally offered there, and the
 * same-name siblings are the same offer's other zones. (An earlier
 * version also required the two lists to be fully disjoint; Sumo's
 * lists share one edge postcode — 3757 — so that condition never
 * fired. Overlap size does not change which variant covers THIS
 * address.) When no sibling covers the postcode, everything is
 * kept, exactly as before.
 */
function dropNonCoveringZoneSiblings(
  plans: CdrPlanSummary[],
  postcode: string,
): CdrPlanSummary[] {
  const groups = new Map<string, CdrPlanSummary[]>();
  for (const p of plans) {
    const key = (p.displayName ?? "").toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  return plans.filter((p) => {
    const group = groups.get((p.displayName ?? "").toLowerCase()) ?? [];
    if (group.length < 2) return true;
    const mine = p.geography?.includedPostcodes ?? [];
    if (mine.length === 0 || mine.includes(postcode)) return true;
    return !group.some(
      (q) =>
        q !== p &&
        (q.geography?.includedPostcodes ?? []).includes(postcode),
    );
  });
}

/** A brand's full plan list. Page 1 comes first (it carries
 * totalPages); the remaining pages are then fetched IN PARALLEL —
 * they used to be fetched one after another, and a big brand's list
 * alone (AGL: 6 pages ≈ 2 s each) cost ~12 s of every refresh. A
 * failed page rejects the whole list, exactly as the sequential
 * version did, so the brand-level retry still applies. */
async function fetchPlanSummaries(
  brand: string,
  maxPages: number,
): Promise<CdrPlanSummary[]> {
  const fetchPage = (page: number) =>
    fetchJson<{
      data: { plans: CdrPlanSummary[] };
      meta?: { totalPages?: number };
    }>(
      `${CDR_BASE}/${brand}/cds-au/v1/energy/plans?page=${page}&page-size=200`,
      "1",
    );
  const first = await fetchPage(1);
  const summaries = [...(first.data?.plans ?? [])];
  const totalPages = Math.min(first.meta?.totalPages ?? 1, maxPages);
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)),
    );
    for (const r of rest) summaries.push(...(r.data?.plans ?? []));
  }
  return summaries;
}

async function pollBrand(
  brand: string,
  usage: UsageProfile,
  networks: AddressNetworks,
  postcode: string,
): Promise<BrandResult> {
  const result: BrandResult = { elec: [], gas: [] };
  const summaries = await fetchPlanSummaries(brand, 10);

  const matches = (p: CdrPlanSummary, fuel: string, network: string) => {
    if (p.fuelType !== fuel) return false;
    if (p.type !== "MARKET" && p.type !== "STANDING") return false;
    if (p.customerType && p.customerType !== "RESIDENTIAL") return false;
    if (!p.customerType && /business/i.test(p.displayName ?? "")) return false;
    return (p.geography?.distributors ?? []).some((d) =>
      d.toLowerCase().includes(network),
    );
  };
  // Networks come from the active address (originally AusNet Services
  // electricity + AGN gas for the address). Detail-fetch order no longer prefers single-rate plans:
  // every tariff variant of a plan is worth fetching (each retailer's
  // variants are all stored, cheapest first, by groupedByRetailer) — preferring single-rate
  // names was a leftover from when only single-rate plans were priced.
  // Only explicit controlled-load variants go last, since a no-CL
  // sibling with the same main rates usually exists.
  const nameScore = (p: CdrPlanSummary) => {
    const n = (p.displayName ?? "").toLowerCase();
    if (/controlled load|\+ *cl\b/.test(n)) return 1;
    return 0;
  };
  const byScore = (a: CdrPlanSummary, b: CdrPlanSummary) =>
    nameScore(a) - nameScore(b);
  const candidates = [
    ...dropNonCoveringZoneSiblings(
      summaries.filter((p) => matches(p, "ELECTRICITY", networks.elecMatch)),
      postcode,
    )
      .sort(byScore)
      .map((p) => ({ p, fuel: "ELECTRICITY" as const })),
    ...(networks.gasMatch
      ? dropNonCoveringZoneSiblings(
          summaries.filter((p) => matches(p, "GAS", networks.gasMatch)),
          postcode,
        )
          .sort(byScore)
          .map((p) => ({ p, fuel: "GAS" as const }))
      : []),
  ];

  let budget = MAX_DETAIL_FETCHES_PER_BRAND;
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor];
      cursor += 1;
      if (!item || !item.p.planId) continue;
      if (budget <= 0) return;
      budget -= 1;
      try {
        const detail = await fetchJson<{ data: CdrPlanDetail }>(
          `${CDR_BASE}/${brand}/cds-au/v1/energy/plans/${encodeURIComponent(item.p.planId)}`,
          "3",
        );
        const entry = extractEntry(detail.data, item.fuel, usage);
        if (entry) {
          (item.fuel === "ELECTRICITY" ? result.elec : result.gas).push(entry);
        }
      } catch {
        // One bad plan detail should not fail the whole brand.
      }
    }
  };
  await Promise.all(
    Array.from({ length: DETAIL_CONCURRENCY }, () => worker()),
  );
  return result;
}

/**
 * pollBrand only throws when the plan-LIST request fails (individual
 * plan-detail failures are swallowed inside), and a single transient
 * failure — a 20 s timeout, a 5xx — used to erase the whole brand from
 * the new snapshot: on 2026-11-19 OVO's list request failed once during
 * the user's refresh, OVO disappeared from the ranking entirely, and the
 * endpoint was answering 200 again seconds later. Retry the brand up to
 * three attempts (short backoff) before counting it failed.
 */
async function pollBrandWithRetry(
  brand: string,
  usage: UsageProfile,
  networks: AddressNetworks,
  postcode: string,
): Promise<BrandResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
    try {
      return await pollBrand(brand, usage, networks, postcode);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "unknown error"));
}

/**
 * Group plans by retailer (cheapest first within each group), rank the
 * groups by their cheapest plan, and keep the cheapest `retailerLimit`
 * retailers with up to `plansPerRetailer` plans each. The page shows one
 * row per retailer — its cheapest plan in full, the rest expandable — so
 * a snapshot must carry more than one plan per retailer; keeping only
 * the cheapest (the old behaviour) left the expand toggle with nothing
 * to expand and it never rendered.
 */
function groupedByRetailer(
  plans: PlanEntry[],
  retailerLimit: number,
  plansPerRetailer: number,
): PlanEntry[] {
  const byRetailer = new Map<string, PlanEntry[]>();
  for (const plan of plans) {
    const key = plan.retailer.toLowerCase();
    const list = byRetailer.get(key) ?? [];
    list.push(plan);
    byRetailer.set(key, list);
  }
  const groups = [...byRetailer.values()].map((list) => {
    // Deterministic order within a group: price, then plan name, then id.
    // Price alone leaves ties (several distinct offers at the same annual
    // cost) in fetch-completion order, which changes run to run and made
    // consecutive snapshots differ — and report 有更新 — when nothing had
    // actually moved.
    const sortedList = [...list].sort(
      (a, b) =>
        a.annualAtBasis - b.annualAtBasis ||
        a.planName.localeCompare(b.planName) ||
        (a.planId ?? "").localeCompare(b.planId ?? ""),
    );
    // CDR often publishes the same offer under several plan ids (meter /
    // channel variants) with identical name and pricing; collapse those
    // so the expandable list shows distinct offers, not duplicates.
    const seen = new Set<string>();
    return sortedList.filter((p) => {
      const signature = JSON.stringify([
        p.planName,
        p.supplyCPerDay,
        p.tou,
        p.steps,
        p.feedInC,
        p.feedInCapPerDay,
        p.feedInAboveCapC,
      ]);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  });
  groups.sort(
    (a, b) =>
      (a[0]?.annualAtBasis ?? Infinity) - (b[0]?.annualAtBasis ?? Infinity) ||
      (a[0]?.retailer ?? "").localeCompare(b[0]?.retailer ?? ""),
  );
  return groups
    .slice(0, retailerLimit)
    .flatMap((list) => list.slice(0, plansPerRetailer));
}

/**
 * Gas pricing zones (e.g. an address in AGN's Central zone) are encoded
 * only in CDR plan names — geography just names the distributor. When the
 * active address has a zone and a retailer publishes a variant for it,
 * drop that retailer's other-zone variants so the price shown is the one
 * this address can get; retailers with no matching variant keep theirs
 * (the zone stays visible in the plan name).
 */
function preferGasZone(plans: PlanEntry[], zone: string): PlanEntry[] {
  const z = zone.trim();
  if (!z) return plans;
  const byRetailer = new Map<string, PlanEntry[]>();
  for (const plan of plans) {
    const key = plan.retailer.toLowerCase();
    const list = byRetailer.get(key) ?? [];
    list.push(plan);
    byRetailer.set(key, list);
  }
  const kept: PlanEntry[] = [];
  for (const list of byRetailer.values()) {
    const inZone = list.filter((p) =>
      p.planName.toLowerCase().includes(z.toLowerCase()),
    );
    kept.push(...(inZone.length > 0 ? inZone : list));
  }
  return kept;
}

const settingsOut = z.object({
  elecKwh: z.number(),
  gasMj: z.number(),
  elecPeakKwh: z.number(),
  elecFlatKwh: z.number(),
  elecShoulderKwh: z.number(),
  solarExportKwh: z.number(),
  // Equipment checkboxes + the three daily usage inputs (2026-11-20
  // redesign). The annual fields above are derived from these.
  hasSolar: z.boolean(),
  hasBattery: z.boolean(),
  hasEv: z.boolean(),
  // Meter tariff type （单费率 "single" / 分时 "tou"): a display
  // condition like the checkboxes — plan families published in both
  // variants show only the one matching the household's meter.
  meterType: z.enum(["single", "tou"]),
  elecDailyKwh: z.number(),
  selfGenDailyKwh: z.number(),
  gasDailyMj: z.number(),
  // Auto-update interval in days (0 = off, 1 = daily, 7 = weekly —
  // the default, 14 = fortnightly, 30 = monthly). Global, not
  // per-address; see the autoRefresh action.
  autoRefreshDays: z.number(),
});
type SettingsOut = z.infer<typeof settingsOut>;

// ---------------------------------------------------------------------------
// Simplified usage model (user redesign 2026-11-20): the page collects
// only three usage numbers — electricity kWh/day, self-generation
// kWh/day (solar generation, or battery discharge; default 10), gas
// MJ/day — plus three equipment checkboxes （太阳能 / 电池 / 电车）.
// Everything else follows the VDO: the reference consumption is
// 4,000 kWh/yr (≈ 11 kWh/day, the default for the electricity input),
// the time-of-use load split used to price TOU plans is the VDO load
// curve — peak 29% / shoulder (solar soak) 18% / off-peak (flat) 53%
// (the split published for VDO-based TOU estimates, e.g. BillHero's
// AusNet page https://billhero.com.au/electricity/eden-park-3757) —
// and the gas default is the AER Victorian residential benchmark
// 50,743 MJ/yr (≈ 139 MJ/day) already used as this page's gas
// reference. Self-generation earns the plans' feed-in rates (it is
// priced exactly like solar export); with neither solar nor battery
// ticked it counts as zero.
// ---------------------------------------------------------------------------

export const VDO_TOU_SPLIT = { peak: 0.29, flat: 0.53, shoulder: 0.18 };

export interface DailyUsage {
  hasSolar: boolean;
  hasBattery: boolean;
  hasEv: boolean;
  meterType: "single" | "tou";
  elecDailyKwh: number;
  selfGenDailyKwh: number;
  gasDailyMj: number;
}

// Generic defaults for a fresh install (VDO / AER benchmarks): 11 kWh/day
// electricity (VDO reference 4,000 kWh/yr), 139 MJ/day gas (AER Victorian
// residential benchmark 50,743 MJ/yr). No equipment is assumed — no solar,
// no battery, no EV — so self-generation defaults to 0 until the user
// ticks solar or battery; the meter defaults to single-rate.
export const DEFAULT_DAILY: DailyUsage = {
  hasSolar: false,
  hasBattery: false,
  hasEv: false,
  meterType: "single",
  elecDailyKwh: 11,
  selfGenDailyKwh: 0,
  gasDailyMj: 139,
};

/** Derives the annual pricing profile (peak/flat/shoulder + export +
 * gas) from the three daily inputs and the equipment checkboxes. */
export function deriveAnnualProfile(d: DailyUsage): UsageProfile & { elecKwh: number } {
  const elecKwh = Math.round(d.elecDailyKwh * 365);
  const peak = Math.round(elecKwh * VDO_TOU_SPLIT.peak);
  const shoulder = Math.round(elecKwh * VDO_TOU_SPLIT.shoulder);
  return {
    elecKwh,
    elecPeakKwh: peak,
    elecFlatKwh: elecKwh - peak - shoulder,
    elecShoulderKwh: shoulder,
    solarExportKwh:
      d.hasSolar || d.hasBattery ? Math.round(d.selfGenDailyKwh * 365) : 0,
    gasMj: Math.round(d.gasDailyMj * 365),
  };
}

async function getSettings(ctx: Ctx): Promise<SettingsOut> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.settings);
  const row = rows[0];
  if (!row) {
    const derived = deriveAnnualProfile(DEFAULT_DAILY);
    return { ...derived, ...DEFAULT_DAILY, autoRefreshDays: 7 };
  }
  const daily: DailyUsage = {
    hasSolar: row.hasSolar !== 0,
    hasBattery: row.hasBattery !== 0,
    hasEv: row.hasEv !== 0,
    meterType: row.meterType,
    elecDailyKwh: row.elecDailyKwh,
    selfGenDailyKwh: row.selfGenDailyKwh,
    gasDailyMj: row.gasDailyMj,
  };
  // The annual profile is always derived from the daily inputs, so a
  // refresh prices exactly what the three boxes + checkboxes say.
  return {
    ...deriveAnnualProfile(daily),
    ...daily,
    autoRefreshDays: row.autoRefreshDays,
  };
}

function usageOf(s: SettingsOut): UsageProfile {
  return {
    elecPeakKwh: s.elecPeakKwh,
    elecFlatKwh: s.elecFlatKwh,
    elecShoulderKwh: s.elecShoulderKwh,
    solarExportKwh: s.solarExportKwh,
    gasMj: s.gasMj,
  };
}

// ---------------------------------------------------------------------------
// Addresses — the user can save more than one address; switching the
// active address re-points everything (rankings, history, refresh
// network filters, usage profile, current-plan comparison) at that
// address's own data. Distributor presets: the five Victorian
// electricity distributors and the three Victorian gas distributors.
// `match` is the lowercase substring looked for in the CDR feed's
// geography.distributors strings (AusNet electricity and AGN verified
// live 2026-11-19; the others are the distributors' own names, matched
// as substrings so capitalisation variants still hit). A postcode
// alone cannot decide the distributor — one postcode by itself is
// split between AusNet and Jemena — so the user picks from their bill.
// ---------------------------------------------------------------------------

export const ELEC_DISTRIBUTORS = [
  { id: "ausnet", label: "AusNet Services", match: "ausnet services (electricity)" },
  { id: "jemena", label: "Jemena", match: "jemena" },
  { id: "powercor", label: "Powercor", match: "powercor" },
  { id: "citipower", label: "CitiPower", match: "citipower" },
  { id: "united-energy", label: "United Energy", match: "united energy" },
] as const;

export const GAS_DISTRIBUTORS = [
  { id: "agn", label: "Australian Gas Networks", match: "australian gas networks" },
  { id: "multinet", label: "Multinet Gas Networks", match: "multinet" },
  { id: "ausnet-gas", label: "AusNet Services（燃气）", match: "ausnet" },
  { id: "none", label: "无燃气 / 不接燃气", match: "" },
] as const;

export type ElecDistributorId = (typeof ELEC_DISTRIBUTORS)[number]["id"];
export type GasDistributorId = (typeof GAS_DISTRIBUTORS)[number]["id"];

// ---------------------------------------------------------------------------
// Network auto-detection by postcode (added 2026-11-20, user request:
// 「只填地址你能不能自己判断属于哪个电网和气网」). There is no public
// address-level distributor API: the Victorian Government's "Find your
// energy distributor" page is a static table + map, and distributor
// boundaries do not follow postcodes exactly. What IS machine-readable
// is the CDR feed this tool already polls: every plan summary carries
// geography.distributors AND geography.includedPostcodes, so scanning
// the plan lists for a postcode reveals which networks publish
// residential plans covering it. Probed live 2026-11-20 (globird + agl
// lists): 3043 → Jemena / AusNet gas; 3146 → United Energy / Multinet;
// metropolitan postcodes in AusNet territory → AusNet elec / AGN gas
// (zone "Central" from plan names);
// 3977 → BOTH United Energy and AusNet elec (a genuinely split
// postcode — both are returned as candidates); 3121 → CitiPower / AGN.
// Limits, stated on the page: the judgement is postcode-level, a
// network whose plans don't enumerate the postcode is missed, and the
// user's bill wins — detection only pre-fills the form's selects,
// which stay editable.
// ---------------------------------------------------------------------------

const DETECT_BRANDS = ["globird", "agl", "origin"];

function elecPresetIdFor(distributor: string): ElecDistributorId | null {
  const d = distributor.toLowerCase();
  if (d.includes("ausnet")) return "ausnet";
  if (d.includes("jemena")) return "jemena";
  if (d.includes("powercor")) return "powercor";
  if (d.includes("citipower")) return "citipower";
  if (d.includes("united energy")) return "united-energy";
  return null;
}

function gasPresetIdFor(distributor: string): GasDistributorId | null {
  const d = distributor.toLowerCase();
  if (d.includes("multinet")) return "multinet";
  if (d.includes("australian gas networks")) return "agn";
  if (d.includes("ausnet")) return "ausnet-gas";
  return null;
}

const networkCandidate = z.object({
  id: z.string(),
  label: z.string(),
  planCount: z.number(),
});

const detectNetworksResponse = z.object({
  postcode: z.string(),
  elec: z.array(networkCandidate),
  gas: z.array(networkCandidate),
  // Most common zone word found in the matched gas plans' names
  // (CDR encodes the zone only there, e.g. "(Central)"), or null.
  gasZone: z.string().nullable(),
  brandsOk: z.number(),
});

type DetectNetworksResponse = z.infer<typeof detectNetworksResponse>;

async function detectNetworksForPostcode(
  postcode: string,
): Promise<DetectNetworksResponse> {
  const elecCounts = new Map<ElecDistributorId, number>();
  const gasCounts = new Map<GasDistributorId, number>();
  const gasZoneTokens = new Map<string, number>();
  let brandsOk = 0;

  const probeBrand = async (brand: string) => {
    const summaries = await fetchPlanSummaries(brand, 12);
    brandsOk += 1;
    for (const p of summaries) {
      if (p.customerType && p.customerType !== "RESIDENTIAL") continue;
      if (!p.customerType && /business/i.test(p.displayName ?? "")) continue;
      if (!(p.geography?.includedPostcodes ?? []).includes(postcode)) continue;
      for (const dist of p.geography?.distributors ?? []) {
        if (p.fuelType === "ELECTRICITY") {
          const id = elecPresetIdFor(dist);
          if (id) elecCounts.set(id, (elecCounts.get(id) ?? 0) + 1);
        } else if (p.fuelType === "GAS") {
          const id = gasPresetIdFor(dist);
          if (id) gasCounts.set(id, (gasCounts.get(id) ?? 0) + 1);
        }
      }
    }
    return summaries;
  };

  const allSummaries = (
    await Promise.all(
      DETECT_BRANDS.map((brand) =>
        probeBrand(brand).catch(() => [] as CdrPlanSummary[]),
      ),
    )
  ).flat();
  if (brandsOk === 0) {
    throw new Error("CDR 数据源暂时无法访问，没能自动判断，请稍后再试或手动选择配电网。");
  }

  // Gas zone: the matched gas plans of the leading gas candidate carry
  // the zone in their names in parentheses ("…Residential(Central)-
  // Australian Gas Networks"). Take the most common such token.
  const topGasId = [...gasCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topGasId) {
    for (const p of allSummaries) {
      if (p.fuelType !== "GAS") continue;
      if (!(p.geography?.includedPostcodes ?? []).includes(postcode)) continue;
      const matched = (p.geography?.distributors ?? []).some(
        (d) => gasPresetIdFor(d) === topGasId,
      );
      if (!matched) continue;
      for (const m of (p.displayName ?? "").matchAll(/\(([^)]+)\)/g)) {
        const token = (m[1] ?? "").trim();
        if (!token || /^(gas|electricity|residential)$/i.test(token)) continue;
        gasZoneTokens.set(token, (gasZoneTokens.get(token) ?? 0) + 1);
      }
    }
  }
  const gasZone =
    [...gasZoneTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const toCandidates = <T extends string>(
    counts: Map<T, number>,
    presets: readonly { id: T; label: string }[],
  ): z.infer<typeof networkCandidate>[] =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, planCount]) => ({
        id,
        label: presets.find((p) => p.id === id)?.label ?? id,
        planCount,
      }));

  return {
    postcode,
    elec: toCandidates(elecCounts, ELEC_DISTRIBUTORS),
    gas: toCandidates(gasCounts, GAS_DISTRIBUTORS),
    gasZone,
    brandsOk,
  };
}

const addressOut = z.object({
  id: z.number(),
  label: z.string(),
  street: z.string(),
  suburb: z.string(),
  postcode: z.string(),
  state: z.string(),
  elecDistributorId: z.string(),
  elecDistributorLabel: z.string(),
  // Electricity network candidates from the CDR postcode probe, and
  // whether the stored network is settled. networksConfirmed = false
  // means the postcode is genuinely split between close candidates
  // and the stored network is only the auto-guess — the page asks the
  // user to pick the real one from their bill before refreshing.
  elecCandidates: z.array(networkCandidate),
  networksConfirmed: z.boolean(),
  gasDistributorId: z.string(),
  gasDistributorLabel: z.string(),
  gasZone: z.string(),
  currentElecNetAnnual: z.number().nullable(),
  currentGasAnnual: z.number().nullable(),
  currentElecNote: z.string(),
  currentGasNote: z.string(),
  hasData: z.boolean(),
});

type AddressRow = typeof schema.addresses.$inferSelect;
type AddressOut = z.infer<typeof addressOut>;

// Address autocomplete (single input + dropdown, 2026-11-20 redesign):
// suggestions come from OpenStreetMap's Nominatim search API
// (countrycodes=au, addressdetails=1). Only the structured parts are
// kept — street / suburb / postcode / state — because saving re-runs
// the CDR postcode probe for the networks anyway.
const addressSuggestion = z.object({
  display: z.string(),
  street: z.string(),
  suburb: z.string(),
  postcode: z.string(),
  state: z.string(),
});

interface NominatimItem {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
  };
}

const STATE_ABBREVIATIONS: Record<string, string> = {
  victoria: "VIC",
  "new south wales": "NSW",
  queensland: "QLD",
  "south australia": "SA",
  "western australia": "WA",
  tasmania: "TAS",
  "northern territory": "NT",
  "australian capital territory": "ACT",
};

function stateAbbreviation(state: string): string {
  const key = state.trim().toLowerCase();
  return STATE_ABBREVIATIONS[key] ?? (state.trim().toUpperCase() || "VIC");
}

// --- Address search fallbacks (2026-11-20 fix) -----------------------
// The user could not find "123 Smith St, Fitzroy VIC 3065" in
// the dropdown: the search was ONE free-form Nominatim request whose
// every failure (timeout, rate limit, no match) collapsed into the
// same silent empty list, and the client rendered nothing at all for
// an empty result. The address itself IS in OpenStreetMap (verified
// live 2026-11-20), so the fix is redundancy + feedback: Nominatim
// free-form search, Nominatim's structured search (street / city /
// postalcode as separate parameters, when the typed query parses
// into parts) and the Photon geocoder (photon.komoot.io, also OSM
// data) all run in parallel and their results are merged — a single
// source's miss or outage can no longer empty the dropdown.

type AddressSuggestionOut = z.infer<typeof addressSuggestion>;

async function fetchJsonOrNull(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "MuseEnergyMonitor/1.0 (personal energy price monitor)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function nominatimSuggestions(items: NominatimItem[]): AddressSuggestionOut[] {
  const suggestions: AddressSuggestionOut[] = [];
  for (const item of items) {
    const a = item.address ?? {};
    const postcode = (a.postcode ?? "").trim();
    if (!/^\d{4}$/.test(postcode)) continue;
    const street =
      [a.house_number, a.road].filter(Boolean).join(" ").trim() ||
      (item.display_name ?? "").split(",")[0]?.trim() ||
      "";
    const suburb = (a.suburb ?? a.city ?? a.town ?? a.village ?? "").trim();
    if (!street || !suburb) continue;
    const state = stateAbbreviation(a.state ?? "");
    suggestions.push({
      display: `${street}, ${suburb} ${state} ${postcode}`,
      street,
      suburb,
      postcode,
      state,
    });
  }
  return suggestions;
}

// Splits a typed query — "123 Smith St, Fitzroy VIC 3065" —
// into the parts Nominatim's structured search takes separately.
// Mirrors the client's parseAddressText; null when it cannot split.
function parseAddressQuery(text: string): {
  street: string;
  suburb: string;
  postcode: string;
} | null {
  const t = text.trim();
  const pc = t.match(/(\d{4})\s*$/);
  const pcMatched = pc?.[0];
  const postcode = pc?.[1];
  if (!pcMatched || !postcode) return null;
  const before = t
    .slice(0, t.length - pcMatched.length)
    .trim()
    .replace(/,+$/, "");
  const stateMatch = before.match(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s*$/i);
  const beforeState = (
    stateMatch ? before.slice(0, before.length - stateMatch[0].length) : before
  )
    .trim()
    .replace(/,+$/, "");
  const parts = beforeState
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const suburb = parts[parts.length - 1] ?? "";
  const street = parts.slice(0, -1).join(", ");
  if (!street || !suburb) return null;
  return { street, suburb, postcode };
}

interface PhotonFeature {
  properties?: {
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
}

function photonSuggestions(data: unknown): AddressSuggestionOut[] {
  const features =
    (data as { features?: PhotonFeature[] } | null)?.features ?? [];
  const suggestions: AddressSuggestionOut[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const p = f.properties ?? {};
    if (p.countrycode !== "AU") continue;
    const postcode = (p.postcode ?? "").trim();
    if (!/^\d{4}$/.test(postcode)) continue;
    // Only real house addresses are useful suggestions: both a house
    // number and a street name must be present.
    if (!p.housenumber || !p.street) continue;
    const street = `${p.housenumber} ${p.street}`.trim();
    const suburb = (p.district ?? p.city ?? "").trim();
    if (!street || !suburb) continue;
    const key = `${street.toLowerCase()}|${postcode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = stateAbbreviation(p.state ?? "");
    suggestions.push({
      display: `${street}, ${suburb} ${state} ${postcode}`,
      street,
      suburb,
      postcode,
      state,
    });
    if (suggestions.length >= 6) break;
  }
  return suggestions;
}

const saveAddressResponse = z.object({
  address: addressOut,
  addresses: z.array(addressOut),
  // Whether the CDR postcode probe found the networks (false = the
  // previous address's networks were kept as a fallback).
  detected: z.boolean(),
  elecLabel: z.string(),
  gasLabel: z.string(),
  gasZone: z.string(),
  elecCandidates: z.number(),
  gasCandidates: z.number(),
  // True when the postcode probe found two electricity networks with
  // close coverage: the stored network is only the coverage leader
  // (a guess) and stays unconfirmed until the user picks the real
  // one from their bill.
  elecAmbiguous: z.boolean(),
});

type ElecCandidate = z.infer<typeof networkCandidate>;

/** Parses the stored elec_candidates JSON; anything unusable reads
 * as "no candidates on file" (the probe simply found none, or the
 * networks were set explicitly). */
function parseElecCandidates(json: string | null): ElecCandidate[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ElecCandidate =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as ElecCandidate).id === "string" &&
        typeof (c as ElecCandidate).label === "string" &&
        typeof (c as ElecCandidate).planCount === "number",
    );
  } catch {
    return [];
  }
}

/** A postcode is genuinely split — the top pick is a guess, not a
 * detection — when a second electricity network covers it with at
 * least half as many residential plans as the leader. a split postcode (e.g. 3083)
 * measured 2026-11-20: AGL 12 AusNet / 12 Jemena, Origin 12 / 13,
 * GloBird 14 / 14, 1st Energy 10 / 10 — a literal coin flip, while
 * 1st Energy's own quoting site resolves the real network from the
 * address, so the tool's guessed-network prices all differed. */
function elecCandidatesAmbiguous(candidates: ElecCandidate[]): boolean {
  const [top, second] = [...candidates].sort(
    (a, b) => b.planCount - a.planCount,
  );
  return (
    top != null && second != null && second.planCount * 2 >= top.planCount
  );
}

function toAddressOut(row: AddressRow, hasData: boolean): AddressOut {
  return {
    id: row.id,
    label: row.label,
    street: row.street,
    suburb: row.suburb,
    postcode: row.postcode,
    state: row.state,
    elecDistributorId: row.elecDistributorId,
    elecDistributorLabel: row.elecDistributorLabel,
    elecCandidates: parseElecCandidates(row.elecCandidates),
    networksConfirmed: row.networksConfirmed === 1,
    gasDistributorId: row.gasDistributorId,
    gasDistributorLabel: row.gasDistributorLabel,
    gasZone: row.gasZone,
    currentElecNetAnnual: row.currentElecNetAnnual,
    currentGasAnnual: row.currentGasAnnual,
    currentElecNote: row.currentElecNote,
    currentGasNote: row.currentGasNote,
    hasData,
  };
}

async function listAddresses(ctx: Ctx): Promise<AddressRow[]> {
  const db = ctx.db<typeof schema>();
  return db
    .select()
    .from(schema.addresses)
    .orderBy(asc(schema.addresses.sortOrder), asc(schema.addresses.id));
}

// The active address, or null when the user has not added one yet.
// A fresh install ships with NO address: nothing is auto-created from
// bundled data, and the page shows an "add your address" prompt until
// the user saves one (see saveAddress).
async function getActiveAddress(ctx: Ctx): Promise<AddressRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await listAddresses(ctx);
  if (rows.length === 0) return null;
  const settingsRows = await db.select().from(schema.settings);
  const activeId = settingsRows[0]?.activeAddressId;
  if (activeId == null) return rows[0] as AddressRow;
  return (rows.find((r) => r.id === activeId) ?? rows[0]) as AddressRow;
}

// Usage profile used when a new address has no previous address to copy
// from: the current settings (VDO-based defaults on a fresh install).
function profileFromSettings(s: SettingsOut): {
  elecKwh: number; gasMj: number; elecPeakKwh: number; elecFlatKwh: number;
  elecShoulderKwh: number; solarExportKwh: number; hasSolar: number;
  hasBattery: number; hasEv: number; meterType: "single" | "tou";
  elecDailyKwh: number; selfGenDailyKwh: number; gasDailyMj: number;
} {
  return {
    elecKwh: s.elecKwh,
    gasMj: s.gasMj,
    elecPeakKwh: s.elecPeakKwh,
    elecFlatKwh: s.elecFlatKwh,
    elecShoulderKwh: s.elecShoulderKwh,
    solarExportKwh: s.solarExportKwh,
    hasSolar: s.hasSolar ? 1 : 0,
    hasBattery: s.hasBattery ? 1 : 0,
    hasEv: s.hasEv ? 1 : 0,
    meterType: s.meterType,
    elecDailyKwh: s.elecDailyKwh,
    selfGenDailyKwh: s.selfGenDailyKwh,
    gasDailyMj: s.gasDailyMj,
  };
}

/** Mirrors an address's usage profile into the settings row, which is
 * what the pricing code reads while that address is active. */
async function mirrorUsageToSettings(
  ctx: Ctx,
  address: AddressRow,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const values = {
    elecKwh: address.elecKwh,
    gasMj: address.gasMj,
    elecPeakKwh: address.elecPeakKwh,
    elecFlatKwh: address.elecFlatKwh,
    elecShoulderKwh: address.elecShoulderKwh,
    solarExportKwh: address.solarExportKwh,
    hasSolar: address.hasSolar,
    hasBattery: address.hasBattery,
    hasEv: address.hasEv,
    meterType: address.meterType,
    elecDailyKwh: address.elecDailyKwh,
    selfGenDailyKwh: address.selfGenDailyKwh,
    gasDailyMj: address.gasDailyMj,
    activeAddressId: address.id,
  };
  const rows = await db.select().from(schema.settings);
  if (rows[0]) {
    await db
      .update(schema.settings)
      .set(values)
      .where(eq(schema.settings.id, rows[0].id));
  } else {
    await db.insert(schema.settings).values({ id: 1, ...values });
  }
}

async function addressHasData(ctx: Ctx, addressId: number): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.addressId, addressId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Translate the retailer-original note segments of the plans about to
 * be stored (user request 2026-11-20: 有备注的原文都翻译一下）. At
 * extraction, a non-wholesale plan's note carries lines like
 * `适用条件（零售商原文）：<English>`; this pass replaces each such
 * line with the same Chinese label plus a Chinese translation, while
 * the English stays stored in the plan's 原文｜ lines, which the page
 * renders collapsed behind a 「零售商原文 ▾」 toggle. Distinct texts
 * are translated once per refresh (the same eligibility text repeats
 * across a retailer's plans), in chunks; a segment whose translation
 * does not come back keeps its label with a pointer to the expandable
 * original instead of the English leaking into the visible note.
 */
/**
 * Harvest reusable translations from the previous snapshot's stored
 * plans: a stored plan pairs each visible Chinese line with its
 * English original in a `原文｜<label>：<English>` line, so when a
 * label appears exactly once on both sides of the same plan, the
 * pairing is unambiguous and the translation can be reused verbatim.
 * Retailer note texts barely change between refreshes (~93 distinct
 * segments, nearly all repeats), and this pass sits at the tail of
 * every refresh — re-translating the same texts each run was a
 * large slice of the refresh time the user complained about
 * (2026-11-20). Wholesale plans are skipped: their visible lines
 * are Chinese SUMMARIES of the originals, not translations.
 */
function harvestTranslations(prior: PlanEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  const labelKey = (label: string) => label.replace(/（[^）]*）/g, "");
  for (const p of prior) {
    if (p.conditions.includes("批发可变价")) continue;
    const visibleByLabel = new Map<string, string[]>();
    const originals: { label: string; text: string }[] = [];
    for (const line of p.conditions.split("\n")) {
      if (line.startsWith("原文｜")) {
        const body = line.slice("原文｜".length);
        const idx = body.indexOf("：");
        if (idx >= 0) {
          originals.push({
            label: labelKey(body.slice(0, idx)),
            text: body.slice(idx + 1),
          });
        }
        continue;
      }
      const idx = line.indexOf("：");
      if (idx < 0) continue;
      const key = labelKey(line.slice(0, idx));
      const list = visibleByLabel.get(key) ?? [];
      list.push(line.slice(idx + 1));
      visibleByLabel.set(key, list);
    }
    const originalCount = new Map<string, number>();
    for (const o of originals) {
      originalCount.set(o.label, (originalCount.get(o.label) ?? 0) + 1);
    }
    for (const o of originals) {
      const visible = visibleByLabel.get(o.label) ?? [];
      if (visible.length !== 1 || originalCount.get(o.label) !== 1) {
        continue;
      }
      const zh = visible[0];
      if (
        !zh ||
        zh === o.text ||
        zh.includes("零售商原文") ||
        zh.includes("译文暂不可用")
      ) {
        continue;
      }
      if (!map.has(o.text)) map.set(o.text, zh);
    }
  }
  return map;
}

async function translateNoteOriginals(
  ctx: Ctx,
  plans: PlanEntry[],
  cache?: Map<string, string>,
): Promise<void> {
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    for (const line of p.conditions.split("\n")) {
      if (!line.includes("零售商原文")) continue;
      const idx = line.indexOf("：");
      const text = idx >= 0 ? line.slice(idx + 1) : "";
      if (text && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
      }
    }
  }
  if (texts.length === 0) return;
  // Reuse the previous snapshot's translations for the texts that
  // did not change; only genuinely new texts go to inference.
  const translations = new Map<string, string>(cache ?? []);
  const missing = texts.filter((t) => !translations.has(t));
  const CHUNK = 20;
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += CHUNK) {
    chunks.push(missing.slice(i, i + CHUNK));
  }
  // Chunks run three at a time, not one after another: this pass sits
  // at the tail of every refresh, and run sequentially it added tens
  // of seconds of pure waiting to the 正在确认结果 state the user
  // complained about (2026-11-20).
  let chunkCursor = 0;
  const chunkWorker = async () => {
    while (chunkCursor < chunks.length) {
      const chunk = chunks[chunkCursor];
      chunkCursor += 1;
      if (!chunk) continue;
      try {
        const res = await ctx.inference.complete(
          `把下面这些澳大利亚能源零售商的套餐说明从英文翻译成简体中文，逐条对应、顺序不变。金额、百分比、日期和单位（如 kWh、MJ、kW）保持原样，语气平实，不要添加原文没有的信息。\n\n${chunk
            .map((t, j) => `${j + 1}. ${t}`)
            .join("\n")}`,
          {
            schema: z.object({ translations: z.array(z.string()) }),
            timeout_secs: 90,
          },
        );
        if (res.translations.length === chunk.length) {
          chunk.forEach((t, j) => {
            const zh = res.translations[j]?.trim();
            if (zh) translations.set(t, zh);
          });
        }
      } catch {
        // Translation is best-effort: untranslated segments fall back to
        // a label + pointer line below; the refresh itself must not fail.
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, () => chunkWorker()));
  for (const p of plans) {
    if (!p.conditions.includes("零售商原文")) continue;
    p.conditions = p.conditions
      .split("\n")
      .map((line) => {
        if (!line.includes("零售商原文")) return line;
        const idx = line.indexOf("：");
        const rawLabel = idx >= 0 ? line.slice(0, idx) : line;
        const text = idx >= 0 ? line.slice(idx + 1) : "";
        const label = rawLabel
          .replace(/，零售商原文/g, "")
          .replace(/（零售商原文）/g, "");
        const zh = translations.get(text);
        return zh
          ? `${label}：${zh}`
          : `${label}：（译文暂不可用，原文见下方展开）`;
      })
      .join("\n");
  }
}

async function runRefresh(ctx: Ctx): Promise<z.infer<typeof snapshotOut>> {
  const db = ctx.db<typeof schema>();
  const address = await getActiveAddress(ctx);
  if (!address) {
    throw new Error("还没有保存地址：请先在页面上方输入地址，保存后再刷新。");
  }
  const settings = await getSettings(ctx);
  const { elecKwh, gasMj } = settings;
  const usage = usageOf(settings);
  const networks: AddressNetworks = {
    elecMatch: address.elecMatch,
    gasMatch: address.gasMatch,
  };
  const elecAll: PlanEntry[] = [];
  const gasAll: PlanEntry[] = [];
  let brandsOk = 0;
  let brandsFailed = 0;
  // Which brands failed and why, so a failed or partial refresh can tell
  // the user exactly what did not come back instead of a bare count.
  const failedBrands: string[] = [];
  const failedBrandSlugs: string[] = [];
  let firstError: string | null = null;

  let brandCursor = 0;
  const brandWorker = async () => {
    while (brandCursor < CDR_BRANDS.length) {
      const brand = CDR_BRANDS[brandCursor];
      brandCursor += 1;
      if (!brand) continue;
      try {
        const res = await pollBrandWithRetry(
          brand,
          usage,
          networks,
          address.postcode,
        );
        elecAll.push(...res.elec);
        gasAll.push(...res.gas);
        brandsOk += 1;
      } catch (e) {
        brandsFailed += 1;
        failedBrands.push(CDR_BRAND_NAMES[brand] ?? brand);
        failedBrandSlugs.push(brand);
        if (firstError == null) {
          firstError = e instanceof Error ? e.message : String(e);
        }
      }
    }
  };
  // Thirteen brands at a time — half the brand list in flight at once
  // (each brand internally fetches plan details eight at a time).
  // Three workers made a full refresh take ~55 s and six measured
  // ~42 s — long enough for the page's refresh request to be cut by
  // the gateway / mobile connection before the response returned,
  // even though the run lands server-side (the user then sat in the
  // 正在确认结果 state). Thirteen workers plus the parallel note
  // translation below trim the run further; the client also
  // reconciles a dropped request by polling for the landed snapshot
  // instead of trusting the error, and shows a progress bar meanwhile.
  await Promise.all(Array.from({ length: 13 }, () => brandWorker()));

  // Previous data-bearing plan lists per fuel: the baseline both for the
  // change comparison below and for carrying over a failed brand's plans.
  let priorElec: PlanEntry[] | null = null;
  let priorGas: PlanEntry[] | null = null;
  if (brandsOk > 0) {
    const priorRows = await db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.addressId, address.id))
      .orderBy(desc(schema.snapshots.id))
      .limit(90);
    priorElec =
      priorRows
        .map((r) => parsePlans(r.elecPlans))
        .find((plans) => plans.length > 0) ?? null;
    priorGas =
      priorRows
        .map((r) => parsePlans(r.gasPlans))
        .find((plans) => plans.length > 0) ?? null;
  }

  // Carry over a failed brand's plans from the previous snapshot. A brand
  // whose CDR endpoint fails for one run must not vanish from the
  // ranking — that is exactly what happened to OVO on 2026-11-19: the
  // new snapshot still had other brands' electricity plans, so the page
  // switched to it and OVO (the user's own current plan, ranked #1) was
  // simply gone, with only a "未返回的品牌" note to explain it. The
  // carried plans are the previous run's figures, unchanged; the
  // snapshot records which retailers were carried (per fuel) so the
  // page marks those rows 更新失败. A fuel the brand did return fresh
  // plans for (e.g. Sumo's separate gas brand) is never carried.
  const carriedOver: { elec: string[]; gas: string[] } = { elec: [], gas: [] };
  const carriedDisplayNames: string[] = [];
  for (const slug of failedBrandSlugs) {
    const carryFuel = (
      prior: PlanEntry[] | null,
      fresh: PlanEntry[],
      carriedNames: string[],
    ): boolean => {
      if (!prior) return false;
      if (fresh.some((p) => retailerMatchesBrand(p.retailer, slug))) {
        return false;
      }
      const carried = prior.filter((p) =>
        retailerMatchesBrand(p.retailer, slug),
      );
      if (carried.length === 0) return false;
      fresh.push(...carried);
      for (const p of carried) {
        if (!carriedNames.includes(p.retailer)) carriedNames.push(p.retailer);
      }
      return true;
    };
    const carriedElec = carryFuel(priorElec, elecAll, carriedOver.elec);
    const carriedGas = carryFuel(priorGas, gasAll, carriedOver.gas);
    if (carriedElec || carriedGas) {
      carriedDisplayNames.push(CDR_BRAND_NAMES[slug] ?? slug);
    }
  }

  // Retailer cap raised 10 → 33 with the 33-retailer expansion
  // (2026-11-19): with 26 brands polled, 25 retailers publish applicable
  // plans for this address, and any lower cut silently drops the most
  // expensive ones — the first expanded run at a cap of 20 stored
  // exactly 20 electricity retailers and cut Amber, Blue NRG, Diamond,
  // Nectr and Next Business Energy (all VDO-priced ≈ $2,000+/yr), even
  // though their brands polled fine and their plans extracted. 33 = the
  // full VEC retailer table, so every retailer with applicable plans is
  // stored and ranked.
  // Electricity keeps up to 10 plans per retailer (gas 6): battery /
  // EV variants are now stored alongside the regular ones (they are
  // filtered on the page by the equipment checkboxes, not at fetch
  // time), and a 6-plan cut could drop exactly the variant a checkbox
  // toggle needs to show.
  const elec = groupedByRetailer(elecAll, 33, 10);
  const gas = groupedByRetailer(preferGasZone(gasAll, address.gasZone), 33, 6);
  // Translate the retailer-original note segments into Chinese before
  // the snapshot is stored and compared, so the stored format is the
  // one the page renders (Chinese visible, originals in 原文｜ lines).
  // Translations from the previous snapshot are harvested and reused
  // — only texts that changed go to inference (see
  // harvestTranslations), which keeps this pass near-instant on a
  // typical run.
  const translationCache = harvestTranslations(priorElec ?? []);
  for (const [k, v] of harvestTranslations(priorGas ?? [])) {
    if (!translationCache.has(k)) translationCache.set(k, v);
  }
  await translateNoteOriginals(ctx, [...elec, ...gas], translationCache);
  const status: "ok" | "partial" | "error" =
    brandsOk === 0
      ? "error"
      : brandsFailed > 0 || elec.length === 0 || gas.length === 0
        ? "partial"
        : "ok";
  const failedFuelNotes: string[] = [];
  if (status !== "error") {
    if (elec.length === 0) failedFuelNotes.push("电费本次没有返回可用套餐");
    if (gas.length === 0) failedFuelNotes.push("燃气本次没有返回可用套餐");
  }
  const message =
    status === "error"
      ? `CDR 数据源本次无法访问：${CDR_BRANDS.length} 个品牌全部请求失败${firstError ? `（示例错误：${firstError}）` : ""}，未更新任何数据`
      : status === "partial"
        ? [
            failedBrands.length > 0
              ? `未返回的品牌：${failedBrands.join("、")}（成功 ${brandsOk} / 共 ${CDR_BRANDS.length} 个品牌）`
              : `部分数据未返回（成功 ${brandsOk} / 共 ${CDR_BRANDS.length} 个品牌）`,
            ...(carriedDisplayNames.length > 0
              ? [
                  `${carriedDisplayNames.join("、")} 本次未返回，排名里沿用上一次的套餐数据（标记为更新失败）`,
                ]
              : []),
            ...failedFuelNotes,
          ].join("；")
        : null;

  // Compare against the previous data-bearing snapshot per fuel, so the
  // page can show 有更新 / 没有更新 after every refresh (auto or manual).
  // A failed run, or a fuel that returned no plans, gets null (the run's
  // status already reports the failure / partial coverage). Carried-over
  // plans are identical to the previous snapshot's, so they never fake
  // a change here.
  let elecChanged: number | null = null;
  let gasChanged: number | null = null;
  if (status !== "error") {
    if (elec.length > 0) {
      elecChanged = plansChanged(elec, priorElec) ? 1 : 0;
    }
    if (gas.length > 0) {
      gasChanged = plansChanged(gas, priorGas) ? 1 : 0;
    }
  }

  const inserted = await db
    .insert(schema.snapshots)
    .values({
      source: "cdr",
      status,
      elecPlans: JSON.stringify(elec),
      gasPlans: JSON.stringify(gas),
      elecBasisKwh: elecKwh,
      gasBasisMj: gasMj,
      brandsOk,
      brandsFailed,
      elecChanged,
      gasChanged,
      failedBrands: JSON.stringify(failedBrands),
      carriedBrands: JSON.stringify(carriedOver),
      message,
      addressId: address.id,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("refreshRates: snapshot insert returned no rows");
  ctx.invalidateQueries();
  return toSnapshotOut(row);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const dashboardResponse = z.object({
  settings: settingsOut,
  snapshots: z.array(snapshotOut),
  // Saved addresses + which one is active. All snapshots/settings in
  // this response belong to the ACTIVE address only.
  addresses: z.array(addressOut),
  activeAddress: addressOut.nullable(),
  distributorOptions: z.object({
    elec: z.array(z.object({ id: z.string(), label: z.string() })),
    gas: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  retailers: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      offers: z.string(),
      website: z.string().nullable(),
    }),
  ),
  reference: z.object({
    elecDistributor: z.string(),
    gasDistributor: z.string(),
    // The active address's current-plan annual costs, when known
    // (entered by the user for that address). For an address whose
    // current costs were never entered, `known` is false and the money
    // fields are null — the page then shows no 与现在比 comparisons
    // rather than another address's figures.
    current: z.object({
      known: z.boolean(),
      elecGrossAnnual: z.number().nullable(),
      feedInCreditAnnual: z.number().nullable(),
      elecNetAnnual: z.number().nullable(),
      gasAnnual: z.number().nullable(),
      netTotalAnnual: z.number().nullable(),
      elecPlanNote: z.string(),
      gasPlanNote: z.string(),
    }),
    // AusNet VDO only — the one zone with verified figures. Null for
    // other distributors (no verified VDO on file; never borrowed).
    vdo: z
      .object({
        supplyCPerDay: z.number(),
        rateCKwh: z.number(),
        annualAt4000: z.number(),
        controlledLoadCKwh: z.number().nullable(),
        periodLabel: z.string(),
        tou: touRates,
        touNetAtActualUsage: z.number(),
      })
      .nullable(),
  }),
});

export const Actions = {
  getDashboard: defineAction({
    description:
      "Returns the active address (plus all saved addresses and distributor options), that address's usage settings and rate-check snapshots (newest first), the VEC retailer list, and reference data (current-plan costs when known for that address; the AusNet VDO only when the address is on AusNet).",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<z.infer<typeof dashboardResponse>> {
      const db = ctx.db<typeof schema>();
      // One-time backfill (2026-11-20): addresses saved before the
      // elec_candidates / networks_confirmed columns existed carry no
      // candidate record — their stored network may be a coin-flip
      // guess on a split postcode (a split-postcode report: the tool
      // picked Jemena by coverage count while 1st Energy's site
      // resolves the address's real network, so every price
      // differed). Probe each such postcode once, store the
      // candidates, and flag genuinely split postcodes unconfirmed so
      // the page asks the user to pick from their bill. A failed
      // probe leaves the row untouched and retries on a later load.
      {
        const rows = await listAddresses(ctx);
        const unprobed = rows.filter((a) => a.elecCandidates == null);
        const postcodes = [...new Set(unprobed.map((a) => a.postcode))];
        for (const postcode of postcodes) {
          try {
            const det = await detectNetworksForPostcode(postcode);
            const candidatesJson = JSON.stringify(det.elec);
            const confirmed = elecCandidatesAmbiguous(det.elec) ? 0 : 1;
            for (const a of unprobed.filter(
              (x) => x.postcode === postcode,
            )) {
              await db
                .update(schema.addresses)
                .set({
                  elecCandidates: candidatesJson,
                  networksConfirmed: confirmed,
                })
                .where(eq(schema.addresses.id, a.id));
            }
          } catch {
            // Probe unreachable — leave unprobed, retry next load.
          }
        }
      }
      const active = await getActiveAddress(ctx);
      const [settings, retailerRows, allAddresses] = await Promise.all([
        getSettings(ctx),
        db.select().from(schema.retailers).orderBy(asc(schema.retailers.sortOrder)),
        listAddresses(ctx),
      ]);
      const snapshotRows = active
        ? await db
            .select()
            .from(schema.snapshots)
            .where(eq(schema.snapshots.addressId, active.id))
            .orderBy(desc(schema.snapshots.id))
            .limit(10)
        : [];
      const dataFlags = new Map<number, boolean>();
      for (const a of allAddresses) {
        dataFlags.set(a.id, await addressHasData(ctx, a.id));
      }
      const elecNetStored = active?.currentElecNetAnnual ?? null;
      const gasCurStored = active?.currentGasAnnual ?? null;
      const currentKnown = elecNetStored != null && gasCurStored != null;
      // Current-plan comparison figures, exactly as stored for this
      // address (entered by the user when the address was added, or
      // left unknown). No re-pricing against another plan: the stored
      // annuals are only compared against rankings priced at the same
      // usage profile the user entered for this address.
      const curElecGross: number | null = null;
      const curFeedIn: number | null = null;
      const curElecNet: number | null = elecNetStored;
      const curGas: number | null = gasCurStored;
      const curElecNote = active?.currentElecNote ?? "";
      const curGasNote = active?.currentGasNote ?? "";
      // Payload slimming (2026-11-20, page would not open on the
      // user's phone): the dashboard used to ship EVERY snapshot's
      // full plan arrays — ~925 KB of JSON for 9 snapshots × ~290
      // plans, re-downloaded on every open / focus / 5-minute poll
      // over mobile data, and growing with every refresh. Now the
      // response is capped at the newest 10 snapshots (the trend
      // chart's window), and within them only the rows the page
      // renders in full keep their note text: each fuel's newest
      // data-bearing snapshot (the ranking) and its previous one
      // (whose notes feed the per-plan change comparison). Older
      // snapshots keep every rate field for the history chart but
      // drop the note text.
      const parsedRows = snapshotRows.map((row) => ({
        row,
        elecPlans: parsePlans(row.elecPlans),
        gasPlans: parsePlans(row.gasPlans),
      }));
      const fullDetailIds = new Set<number>();
      for (const key of ["elecPlans", "gasPlans"] as const) {
        let seen = 0;
        for (const p of parsedRows) {
          if (p[key].length > 0) {
            fullDetailIds.add(p.row.id);
            seen += 1;
            if (seen >= 2) break;
          }
        }
      }
      return {
        settings,
        snapshots: parsedRows.map((p) =>
          toSnapshotOut(p.row, {
            fullDetail: fullDetailIds.has(p.row.id),
            elecPlans: p.elecPlans,
            gasPlans: p.gasPlans,
          }),
        ),
        addresses: allAddresses.map((a) =>
          toAddressOut(a, dataFlags.get(a.id) ?? false),
        ),
        activeAddress: active
          ? toAddressOut(active, dataFlags.get(active.id) ?? false)
          : null,
        distributorOptions: {
          elec: ELEC_DISTRIBUTORS.map((d) => ({ id: d.id, label: d.label })),
          gas: GAS_DISTRIBUTORS.map((d) => ({ id: d.id, label: d.label })),
        },
        retailers: retailerRows.map((r) => ({
          id: r.id,
          name: r.name,
          offers: r.offers,
          website: r.website,
        })),
        reference: {
          elecDistributor: active
            ? `${active.elecDistributorLabel}（电力配电网）`
            : "尚未添加地址",
          gasDistributor: !active
            ? "尚未添加地址"
            : active.gasDistributorId === "none"
              ? "无燃气"
              : `${active.gasDistributorLabel}${active.gasZone ? ` — ${active.gasZone} 区` : ""}（燃气配电网）`,
          current: {
            known: currentKnown,
            // Gross / feed-in split: only populated when the stored
            // current-plan rates allow it; otherwise null.
            elecGrossAnnual: curElecGross,
            feedInCreditAnnual: curFeedIn,
            elecNetAnnual: curElecNet,
            gasAnnual: curGas,
            netTotalAnnual:
              curElecNet != null && curGas != null ? curElecNet + curGas : null,
            elecPlanNote: curElecNote,
            gasPlanNote: curGasNote,
          },
          vdo:
            active?.elecDistributorId === "ausnet"
              ? {
                  // AusNet flat domestic VDO 2026–27 (ESC, via the research
                  // report's zone table): $1.2824/day + 31.98c/kWh. The report
                  // gives no AusNet controlled-load rate, so none is shown.
                  // Annual at 4,000 kWh derived from those rates:
                  // 365 × 1.2824 + 4,000 × 0.3198 = $1,747.28.
                  supplyCPerDay: 128.24,
                  rateCKwh: 31.98,
                  annualAt4000: 1747,
                  controlledLoadCKwh: null,
                  periodLabel: "2026–27 年度（2026 年 7 月 1 日 – 2027 年 6 月 30 日）",
                  // AusNet VDO time-of-use rates (ESC 2026–27); net cost at
                  // the VDO reference usage (4,000 kWh/yr, VDO TOU split
                  // 29/53/18, no solar export): supply $468 + usage $1,158
                  // ≈ $1,626/yr.
                  tou: { peakC: 47.64, flatC: 22.6, shoulderC: 17.59 },
                  touNetAtActualUsage: 1626,
                }
              : null,
        },
      };
    },
  }),

  refreshRates: defineAction({
    description:
      "Polls the AER CDR energy plan feed for all tracked brands, recomputes the cheapest electricity and gas plans for the ACTIVE address's distribution networks at its saved usage, and stores a new snapshot for that address.",
    request: z.object({}),
    response: z.object({ snapshot: snapshotOut }),
    async handler(ctx) {
      const snapshot = await runRefresh(ctx);
      return { snapshot };
    },
  }),

  autoRefresh: defineAction({
    description:
      "The scheduled auto-update entry point (the daily managed cron calls this, not refreshRates): runs a real CDR refresh for the ACTIVE address only when the user's auto-update interval (settings.autoRefreshDays, default 7 = weekly) has elapsed since that address's last data-bearing check; returns refreshed=false with the reason when the interval has not elapsed or auto-update is off. Manual refreshRates is never gated by the interval.",
    request: z.object({}),
    response: z.object({
      refreshed: z.boolean(),
      reason: z.string(),
      snapshot: snapshotOut.nullable(),
    }),
    async handler(ctx) {
      const settings = await getSettings(ctx);
      const address = await getActiveAddress(ctx);
      if (!address) {
        return {
          refreshed: false,
          reason: "尚未添加地址，自动更新跳过。",
          snapshot: null,
        };
      }
      const days = settings.autoRefreshDays;
      if (days === 0) {
        return {
          refreshed: false,
          reason: "自动更新已关闭（设置里选了「关闭」），本次不抓取。",
          snapshot: null,
        };
      }
      const db = ctx.db<typeof schema>();
      // The interval is measured from the address's last DATA-BEARING
      // check (ok / partial): a run that errored stored no usable
      // data, so it must not push the next attempt a full interval
      // out — the next daily tick retries instead.
      const recent = await db
        .select()
        .from(schema.snapshots)
        .where(eq(schema.snapshots.addressId, address.id))
        .orderBy(desc(schema.snapshots.takenAt))
        .limit(10);
      const lastGood = recent.find((s) => s.status !== "error");
      if (lastGood) {
        const elapsedMs = Date.now() - lastGood.takenAt.getTime();
        if (elapsedMs < days * 86_400_000) {
          return {
            refreshed: false,
            reason: `距上次检查还没满自动更新间隔（${days} 天），本次不抓取。`,
            snapshot: null,
          };
        }
      }
      const snapshot = await runRefresh(ctx);
      return {
        refreshed: true,
        reason: `已按自动更新间隔（${days} 天）抓取一次新数据。`,
        snapshot,
      };
    },
  }),

  setAutoRefresh: defineAction({
    description:
      "Saves the auto-update interval in days: 0 = off, 1 = daily, 7 = weekly (the default), 14 = fortnightly, 30 = monthly. Global preference; the scheduled autoRefresh action honours it from its next daily tick. Manual refresh is unaffected.",
    request: z.object({
      days: z.union([
        z.literal(0),
        z.literal(1),
        z.literal(7),
        z.literal(14),
        z.literal(30),
      ]),
    }),
    response: z.object({ settings: settingsOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const row = rows[0];
      if (row) {
        await db
          .update(schema.settings)
          .set({ autoRefreshDays: args.days })
          .where(eq(schema.settings.id, row.id));
      } else {
        const derived = deriveAnnualProfile(DEFAULT_DAILY);
        await db.insert(schema.settings).values({
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
          autoRefreshDays: args.days,
        });
      }
      ctx.invalidateQueries();
      return { settings: await getSettings(ctx) };
    },
  }),

  saveSettings: defineAction({
    description:
      "Saves the household's simplified usage inputs — electricity kWh/day, self-generation kWh/day (solar and/or battery, default 10), gas MJ/day — plus the equipment checkboxes （太阳能/电池/电车） and the meter tariff type （单费率 single / 分时 tou, a display condition: plan families published in both variants show only the meter-matching one). The annual peak/flat/shoulder profile is derived server-side with the VDO time-of-use split (29/53/18) and stored alongside, so all pricing uses the new inputs.",
    request: z.object({
      elecDailyKwh: z
        .number()
        .min(0.1, "电日均用量至少 0.1 kWh/天")
        .max(500, "电日均用量最多 500 kWh/天"),
      selfGenDailyKwh: z
        .number()
        .min(0, "自发电量不能为负")
        .max(500, "自发电量最多 500 kWh/天"),
      gasDailyMj: z
        .number()
        .min(0, "气日均用量不能为负")
        .max(5000, "气日均用量最多 5,000 MJ/天"),
      hasSolar: z.boolean(),
      hasBattery: z.boolean(),
      hasEv: z.boolean(),
      meterType: z.enum(["single", "tou"]),
    }),
    response: z.object({ settings: settingsOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const daily: DailyUsage = {
        hasSolar: args.hasSolar,
        hasBattery: args.hasBattery,
        hasEv: args.hasEv,
        meterType: args.meterType,
        elecDailyKwh: args.elecDailyKwh,
        selfGenDailyKwh: args.selfGenDailyKwh,
        gasDailyMj: args.gasDailyMj,
      };
      const derived = deriveAnnualProfile(daily);
      const values = {
        id: 1,
        elecKwh: derived.elecKwh,
        gasMj: derived.gasMj,
        elecPeakKwh: derived.elecPeakKwh,
        elecFlatKwh: derived.elecFlatKwh,
        elecShoulderKwh: derived.elecShoulderKwh,
        solarExportKwh: derived.solarExportKwh,
        hasSolar: daily.hasSolar ? 1 : 0,
        hasBattery: daily.hasBattery ? 1 : 0,
        hasEv: daily.hasEv ? 1 : 0,
        meterType: daily.meterType,
        elecDailyKwh: daily.elecDailyKwh,
        selfGenDailyKwh: daily.selfGenDailyKwh,
        gasDailyMj: daily.gasDailyMj,
      };
      await db
        .insert(schema.settings)
        .values(values)
        .onConflictDoUpdate({
          target: schema.settings.id,
          set: {
            elecKwh: values.elecKwh,
            gasMj: values.gasMj,
            elecPeakKwh: values.elecPeakKwh,
            elecFlatKwh: values.elecFlatKwh,
            elecShoulderKwh: values.elecShoulderKwh,
            solarExportKwh: values.solarExportKwh,
            hasSolar: values.hasSolar,
            hasBattery: values.hasBattery,
            hasEv: values.hasEv,
            meterType: values.meterType,
            elecDailyKwh: values.elecDailyKwh,
            selfGenDailyKwh: values.selfGenDailyKwh,
            gasDailyMj: values.gasDailyMj,
          },
        });
      // The usage belongs to the active address: keep its row in sync
      // so switching away and back restores this profile. With no
      // address saved yet there is no row to sync.
      const active = await getActiveAddress(ctx);
      if (active) {
        await db
          .update(schema.addresses)
          .set({
            elecKwh: values.elecKwh,
            gasMj: values.gasMj,
            elecPeakKwh: values.elecPeakKwh,
            elecFlatKwh: values.elecFlatKwh,
            elecShoulderKwh: values.elecShoulderKwh,
            solarExportKwh: values.solarExportKwh,
            hasSolar: values.hasSolar,
            hasBattery: values.hasBattery,
            hasEv: values.hasEv,
            meterType: values.meterType,
            elecDailyKwh: values.elecDailyKwh,
            selfGenDailyKwh: values.selfGenDailyKwh,
            gasDailyMj: values.gasDailyMj,
          })
          .where(eq(schema.addresses.id, active.id));
      }
      ctx.invalidateQueries();
      return { settings: await getSettings(ctx) };
    },
  }),

  detectNetworks: defineAction({
    description:
      "Auto-detects which Victorian electricity and gas distribution networks cover a postcode, by scanning the AER CDR plan lists for residential plans whose includedPostcodes contain it (plus the gas zone named in those plans). Returns candidate networks per fuel — usually one, sometimes two for split postcodes — for the address form to pre-fill; the user confirms or overrides from their bill.",
    request: z.object({
      postcode: z
        .string()
        .trim()
        .regex(/^\d{4}$/, "邮编是 4 位数字"),
    }),
    response: detectNetworksResponse,
    async handler(_ctx, args): Promise<DetectNetworksResponse> {
      return detectNetworksForPostcode(args.postcode);
    },
  }),

  searchAddresses: defineAction({
    description:
      "Address autocomplete for the single address input: returns structured suggestions (street, suburb, postcode, state) for the dropdown, querying OpenStreetMap Nominatim free-form search, Nominatim structured search (street/city/postalcode, when the query parses into parts) and the Photon geocoder in parallel and merging their results (deduped by street + postcode) — so an address one source's ranking drops still appears from another, and one provider's outage no longer empties the dropdown. Returns an empty list only when every source finds nothing or is unreachable — the user can still type the address freehand.",
    request: z.object({
      query: z.string().trim().min(3, "至少输入 3 个字符").max(120),
    }),
    response: z.object({
      suggestions: z.array(
        z.object({
          display: z.string(),
          street: z.string(),
          suburb: z.string(),
          postcode: z.string(),
          state: z.string(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      // All sources run in parallel and their results are MERGED
      // (priority: Nominatim free-form, Nominatim structured, Photon;
      // deduped by street + postcode, capped at 6). Merging matters:
      // for a half-typed query like "123 Smith St, Fitz",
      // Nominatim free-form returns only the Fitzroy North house,
      // while Photon also returns the Fitzroy one — first-non-empty
      // would have hidden it.
      const parts = parseAddressQuery(args.query);
      const [freeForm, structured, photon] = await Promise.all([
        fetchJsonOrNull(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=au&limit=6&q=${encodeURIComponent(args.query)}`,
          8000,
        ),
        parts
          ? fetchJsonOrNull(
              `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=au&limit=6&street=${encodeURIComponent(parts.street)}&city=${encodeURIComponent(parts.suburb)}&postalcode=${encodeURIComponent(parts.postcode)}`,
              8000,
            )
          : Promise.resolve(null),
        fetchJsonOrNull(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(args.query)}&limit=8&lang=en`,
          8000,
        ),
      ]);
      const merged: AddressSuggestionOut[] = [];
      const seen = new Set<string>();
      const pushAll = (list: AddressSuggestionOut[]) => {
        for (const s of list) {
          if (merged.length >= 6) return;
          const key = `${s.street.toLowerCase()}|${s.postcode}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(s);
        }
      };
      pushAll(nominatimSuggestions((freeForm as NominatimItem[] | null) ?? []));
      pushAll(
        nominatimSuggestions((structured as NominatimItem[] | null) ?? []),
      );
      pushAll(photonSuggestions(photon));
      return { suggestions: merged };
    },
  }),

  saveAddress: defineAction({
    description:
      "Saves an address picked from the autocomplete dropdown (or typed freehand) as the active address: the electricity/gas distribution networks are auto-detected from the postcode via the CDR coverage probe and stored with the address, together with the probe's electricity candidates (falling back to the current address's networks when detection finds nothing). When two electricity networks cover the postcode with close counts the pick is only a guess: the address is stored unconfirmed (networksConfirmed = false) until the user picks the real network via confirmAddressNetworks; a network the user already confirmed for the same address is never overwritten by a re-save. An existing address with the same street + postcode is updated instead of duplicated, and a new address copies the current usage inputs as its starting profile. The client calls this automatically once the address input holds a complete address (there is no save button) purely so the detected networks display under the input; plan data is refreshed separately, only when the user taps 立即刷新 with all conditions ready.",
    request: z.object({
      street: z.string().trim().min(1, "请填写街道地址").max(120, "街道地址最多 120 字"),
      suburb: z.string().trim().min(1, "请填写 suburb").max(60, "suburb 最多 60 字"),
      postcode: z
        .string()
        .trim()
        .regex(/^\d{4}$/, "邮编是 4 位数字"),
      state: z.string().trim().min(2).max(3).default("VIC"),
    }),
    response: saveAddressResponse,
    async handler(ctx, args): Promise<z.infer<typeof saveAddressResponse>> {
      const db = ctx.db<typeof schema>();
      const previousActive = await getActiveAddress(ctx);
      const settings = await getSettings(ctx);
      // Usage profile the new address starts from: the previous
      // address's, or the current settings (VDO defaults on a fresh
      // install) when this is the first address.
      const profile = previousActive
        ? {
            elecKwh: previousActive.elecKwh,
            gasMj: previousActive.gasMj,
            elecPeakKwh: previousActive.elecPeakKwh,
            elecFlatKwh: previousActive.elecFlatKwh,
            elecShoulderKwh: previousActive.elecShoulderKwh,
            solarExportKwh: previousActive.solarExportKwh,
            hasSolar: previousActive.hasSolar,
            hasBattery: previousActive.hasBattery,
            hasEv: previousActive.hasEv,
            meterType: previousActive.meterType,
            elecDailyKwh: previousActive.elecDailyKwh,
            selfGenDailyKwh: previousActive.selfGenDailyKwh,
            gasDailyMj: previousActive.gasDailyMj,
          }
        : profileFromSettings(settings);
      // Fallback: the current address's networks, used only when the
      // postcode probe finds no candidate at all. With no previous
      // address the fallback is the first preset of each fuel — and
      // the address is stored UNCONFIRMED (see `settled` below), so
      // the page asks the user to pick the real network from their
      // bill instead of trusting the guess.
      let elecId: string = previousActive?.elecDistributorId ?? "ausnet";
      let elecLabel: string =
        previousActive?.elecDistributorLabel ?? "AusNet Services";
      let elecMatch: string =
        previousActive?.elecMatch ?? "ausnet services (electricity)";
      let gasId: string = previousActive?.gasDistributorId ?? "agn";
      let gasLabel: string =
        previousActive?.gasDistributorLabel ?? "Australian Gas Networks";
      let gasMatch: string =
        previousActive?.gasMatch ?? "australian gas networks";
      let gasZone: string = previousActive?.gasZone ?? "";
      let detected = false;
      let elecCandidates = 0;
      let gasCandidates = 0;
      let elecCandidatesJson: string | null = null;
      let elecAmbiguous = false;
      try {
        const det = await detectNetworksForPostcode(args.postcode);
        elecCandidates = det.elec.length;
        gasCandidates = det.gas.length;
        elecCandidatesJson = JSON.stringify(det.elec);
        elecAmbiguous = elecCandidatesAmbiguous(det.elec);
        const eTop = det.elec[0];
        if (eTop) {
          const preset = ELEC_DISTRIBUTORS.find((d) => d.id === eTop.id);
          if (preset) {
            elecId = preset.id;
            elecLabel = preset.label;
            elecMatch = preset.match;
            detected = true;
          }
        }
        const gTop = det.gas[0];
        if (gTop) {
          const preset = GAS_DISTRIBUTORS.find((d) => d.id === gTop.id);
          if (preset) {
            gasId = preset.id;
            gasLabel = preset.label;
            gasMatch = preset.match;
            gasZone = det.gasZone ?? "";
            detected = true;
          }
        }
      } catch {
        // Detection unreachable — keep the fallback networks.
      }
      const all = await listAddresses(ctx);
      const existing = all.find(
        (a) =>
          a.street.toLowerCase() === args.street.toLowerCase() &&
          a.postcode === args.postcode,
      );
      let row: AddressRow;
      if (existing) {
        // A network the user already confirmed for this same address
        // (same street + postcode) is theirs — a re-save (e.g. fixing
        // the suburb spelling) must not silently replace it with a
        // fresh postcode guess or un-confirm it.
        const keepConfirmed =
          existing.postcode === args.postcode &&
          existing.networksConfirmed === 1 &&
          existing.elecCandidates != null;
        const updated = await db
          .update(schema.addresses)
          .set({
            label: args.street,
            suburb: args.suburb,
            state: args.state.toUpperCase(),
            elecDistributorId: keepConfirmed
              ? existing.elecDistributorId
              : elecId,
            elecDistributorLabel: keepConfirmed
              ? existing.elecDistributorLabel
              : elecLabel,
            elecMatch: keepConfirmed ? existing.elecMatch : elecMatch,
            elecCandidates: keepConfirmed
              ? existing.elecCandidates
              : elecCandidatesJson,
            networksConfirmed: keepConfirmed
              ? 1
              : elecAmbiguous || !detected
                ? 0
                : 1,
            gasDistributorId: gasId,
            gasDistributorLabel: gasLabel,
            gasMatch,
            gasZone,
          })
          .where(eq(schema.addresses.id, existing.id))
          .returning();
        const updatedRow = updated[0];
        if (!updatedRow) throw new Error("saveAddress: update returned no rows");
        row = updatedRow;
      } else {
        const inserted = await db
          .insert(schema.addresses)
          .values({
            label: args.street,
            street: args.street,
            suburb: args.suburb,
            postcode: args.postcode,
            state: args.state.toUpperCase(),
            elecDistributorId: elecId,
            elecDistributorLabel: elecLabel,
            elecMatch,
            elecCandidates: elecCandidatesJson,
            networksConfirmed: elecAmbiguous || !detected ? 0 : 1,
            gasDistributorId: gasId,
            gasDistributorLabel: gasLabel,
            gasMatch,
            gasZone,
            elecKwh: profile.elecKwh,
            gasMj: profile.gasMj,
            elecPeakKwh: profile.elecPeakKwh,
            elecFlatKwh: profile.elecFlatKwh,
            elecShoulderKwh: profile.elecShoulderKwh,
            solarExportKwh: profile.solarExportKwh,
            hasSolar: profile.hasSolar,
            hasBattery: profile.hasBattery,
            hasEv: profile.hasEv,
            meterType: profile.meterType,
            elecDailyKwh: profile.elecDailyKwh,
            selfGenDailyKwh: profile.selfGenDailyKwh,
            gasDailyMj: profile.gasDailyMj,
            sortOrder: (all[all.length - 1]?.sortOrder ?? 0) + 1,
          })
          .returning();
        const insertedRow = inserted[0];
        if (!insertedRow) throw new Error("saveAddress: insert returned no rows");
        row = insertedRow;
      }
      await mirrorUsageToSettings(ctx, row);
      ctx.invalidateQueries();
      const addresses = await listAddresses(ctx);
      return {
        address: toAddressOut(row, await addressHasData(ctx, row.id)),
        addresses: await Promise.all(
          addresses.map(async (a) =>
            toAddressOut(a, await addressHasData(ctx, a.id)),
          ),
        ),
        detected,
        elecLabel,
        gasLabel: gasId === "none" ? "无燃气" : gasLabel,
        gasZone,
        elecCandidates,
        gasCandidates,
        elecAmbiguous: row.networksConfirmed !== 1,
      };
    },
  }),

  addAddress: defineAction({
    description:
      "Adds a saved address with its electricity/gas distributors (chosen from the Victorian distributor presets), copies the active address's usage profile as its starting point, and makes it the active address. The client refreshes right after, so the new address's plan data is fetched for its own networks.",
    request: z.object({
      street: z.string().trim().min(1, "请填写街道地址").max(120, "街道地址最多 120 字"),
      suburb: z.string().trim().min(1, "请填写 suburb").max(60, "suburb 最多 60 字"),
      postcode: z
        .string()
        .trim()
        .regex(/^\d{4}$/, "邮编是 4 位数字"),
      state: z.string().trim().min(2).max(3).default("VIC"),
      elecDistributorId: z.enum([
        "ausnet",
        "jemena",
        "powercor",
        "citipower",
        "united-energy",
      ]),
      gasDistributorId: z.enum(["agn", "multinet", "ausnet-gas", "none"]),
      gasZone: z.string().trim().max(40, "燃气分区最多 40 字").default(""),
      currentElecNetAnnual: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .nullable()
        .default(null),
      currentGasAnnual: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .nullable()
        .default(null),
    }),
    response: z.object({
      address: addressOut,
      addresses: z.array(addressOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const previousActive = await getActiveAddress(ctx);
      const profile = previousActive
        ? {
            elecKwh: previousActive.elecKwh,
            gasMj: previousActive.gasMj,
            elecPeakKwh: previousActive.elecPeakKwh,
            elecFlatKwh: previousActive.elecFlatKwh,
            elecShoulderKwh: previousActive.elecShoulderKwh,
            solarExportKwh: previousActive.solarExportKwh,
            hasSolar: previousActive.hasSolar,
            hasBattery: previousActive.hasBattery,
            hasEv: previousActive.hasEv,
            meterType: previousActive.meterType,
            elecDailyKwh: previousActive.elecDailyKwh,
            selfGenDailyKwh: previousActive.selfGenDailyKwh,
            gasDailyMj: previousActive.gasDailyMj,
          }
        : profileFromSettings(await getSettings(ctx));
      const elec = ELEC_DISTRIBUTORS.find((d) => d.id === args.elecDistributorId);
      const gas = GAS_DISTRIBUTORS.find((d) => d.id === args.gasDistributorId);
      if (!elec || !gas) throw new Error("配电网选项不正确，请重新选择。");
      const all = await listAddresses(ctx);
      const inserted = await db
        .insert(schema.addresses)
        .values({
          label: args.street,
          street: args.street,
          suburb: args.suburb,
          postcode: args.postcode,
          state: args.state.toUpperCase(),
          elecDistributorId: elec.id,
          elecDistributorLabel: elec.label,
          elecMatch: elec.match,
          // Explicitly chosen in the form — settled, no probe.
          elecCandidates: "[]",
          networksConfirmed: 1,
          gasDistributorId: gas.id,
          gasDistributorLabel: gas.label,
          gasMatch: gas.match,
          gasZone: gas.id === "none" ? "" : args.gasZone,
          elecKwh: profile.elecKwh,
          gasMj: profile.gasMj,
          elecPeakKwh: profile.elecPeakKwh,
          elecFlatKwh: profile.elecFlatKwh,
          elecShoulderKwh: profile.elecShoulderKwh,
          solarExportKwh: profile.solarExportKwh,
          hasSolar: profile.hasSolar,
          hasBattery: profile.hasBattery,
          hasEv: profile.hasEv,
          meterType: profile.meterType,
          elecDailyKwh: profile.elecDailyKwh,
          selfGenDailyKwh: profile.selfGenDailyKwh,
          gasDailyMj: profile.gasDailyMj,
          currentElecNetAnnual: args.currentElecNetAnnual,
          currentGasAnnual:
            gas.id === "none" ? null : args.currentGasAnnual,
          sortOrder: (all[all.length - 1]?.sortOrder ?? 0) + 1,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addAddress: insert returned no rows");
      await mirrorUsageToSettings(ctx, row);
      ctx.invalidateQueries();
      const addresses = await listAddresses(ctx);
      return {
        address: toAddressOut(row, false),
        addresses: await Promise.all(
          addresses.map(async (a) =>
            toAddressOut(a, await addressHasData(ctx, a.id)),
          ),
        ),
      };
    },
  }),

  switchAddress: defineAction({
    description:
      "Makes a saved address the active one: its usage profile is mirrored into settings, and the dashboard then shows that address's snapshots (refreshing fetches data for its networks when it has none yet).",
    request: z.object({ addressId: z.number().int().min(1) }),
    response: z.object({
      address: addressOut,
      addresses: z.array(addressOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.addresses)
        .where(eq(schema.addresses.id, args.addressId));
      const row = rows[0];
      if (!row) throw new Error("这个地址不存在，可能已被删除。");
      await mirrorUsageToSettings(ctx, row);
      ctx.invalidateQueries();
      const addresses = await listAddresses(ctx);
      return {
        address: toAddressOut(row, await addressHasData(ctx, row.id)),
        addresses: await Promise.all(
          addresses.map(async (a) =>
            toAddressOut(a, await addressHasData(ctx, a.id)),
          ),
        ),
      };
    },
  }),

  confirmAddressNetworks: defineAction({
    description:
      "Confirms the real electricity distribution network for an address whose postcode is genuinely split between two networks (the auto-detected pick was only a coverage-count guess): stores the user-picked distributor (from their bill), marks the address's networks confirmed, and — when the pick differs from the guess — deletes that address's snapshots, which were priced for the wrong network, so the page refetches under the confirmed one.",
    request: z.object({
      addressId: z.number().int().min(1),
      elecDistributorId: z.enum([
        "ausnet",
        "jemena",
        "powercor",
        "citipower",
        "united-energy",
      ]),
    }),
    response: z.object({
      address: addressOut,
      addresses: z.array(addressOut),
      networkChanged: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const elec = ELEC_DISTRIBUTORS.find((d) => d.id === args.elecDistributorId);
      if (!elec) throw new Error("配电网选项不正确，请重新选择。");
      const rows = await db
        .select()
        .from(schema.addresses)
        .where(eq(schema.addresses.id, args.addressId));
      const existing = rows[0];
      if (!existing) throw new Error("这个地址不存在，可能已被删除。");
      const networkChanged = existing.elecDistributorId !== elec.id;
      const updated = await db
        .update(schema.addresses)
        .set({
          elecDistributorId: elec.id,
          elecDistributorLabel: elec.label,
          elecMatch: elec.match,
          networksConfirmed: 1,
        })
        .where(eq(schema.addresses.id, args.addressId))
        .returning();
      const row = updated[0];
      if (!row) throw new Error("confirmAddressNetworks: update returned no rows");
      if (networkChanged) {
        // Snapshots fetched under the guessed network price the wrong
        // network's plans — drop them so nothing stale is shown; the
        // next refresh (manual or daily) refetches under the
        // confirmed network.
        await db
          .delete(schema.snapshots)
          .where(eq(schema.snapshots.addressId, args.addressId));
      }
      ctx.invalidateQueries();
      const addresses = await listAddresses(ctx);
      return {
        address: toAddressOut(row, await addressHasData(ctx, row.id)),
        addresses: await Promise.all(
          addresses.map(async (a) =>
            toAddressOut(a, await addressHasData(ctx, a.id)),
          ),
        ),
        networkChanged,
      };
    },
  }),

  updateAddress: defineAction({
    description:
      "Edits a saved address's street/suburb/postcode, its electricity/gas distributors and gas zone, and its known current-plan annual costs. Distributor changes take effect on the next refresh for that address.",
    request: z.object({
      addressId: z.number().int().min(1),
      street: z.string().trim().min(1, "请填写街道地址").max(120, "街道地址最多 120 字"),
      suburb: z.string().trim().min(1, "请填写 suburb").max(60, "suburb 最多 60 字"),
      postcode: z
        .string()
        .trim()
        .regex(/^\d{4}$/, "邮编是 4 位数字"),
      state: z.string().trim().min(2).max(3).default("VIC"),
      elecDistributorId: z.enum([
        "ausnet",
        "jemena",
        "powercor",
        "citipower",
        "united-energy",
      ]),
      gasDistributorId: z.enum(["agn", "multinet", "ausnet-gas", "none"]),
      gasZone: z.string().trim().max(40, "燃气分区最多 40 字").default(""),
      currentElecNetAnnual: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .nullable()
        .default(null),
      currentGasAnnual: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .nullable()
        .default(null),
      currentElecNote: z.string().trim().max(300, "备注最多 300 字").default(""),
      currentGasNote: z.string().trim().max(300, "备注最多 300 字").default(""),
    }),
    response: z.object({ address: addressOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const elec = ELEC_DISTRIBUTORS.find((d) => d.id === args.elecDistributorId);
      const gas = GAS_DISTRIBUTORS.find((d) => d.id === args.gasDistributorId);
      if (!elec || !gas) throw new Error("配电网选项不正确，请重新选择。");
      const updated = await db
        .update(schema.addresses)
        .set({
          label: args.street,
          street: args.street,
          suburb: args.suburb,
          postcode: args.postcode,
          state: args.state.toUpperCase(),
          elecDistributorId: elec.id,
          elecDistributorLabel: elec.label,
          elecMatch: elec.match,
          // Explicitly chosen in the form — settled, no probe.
          elecCandidates: "[]",
          networksConfirmed: 1,
          gasDistributorId: gas.id,
          gasDistributorLabel: gas.label,
          gasMatch: gas.match,
          gasZone: gas.id === "none" ? "" : args.gasZone,
          currentElecNetAnnual: args.currentElecNetAnnual,
          currentGasAnnual: gas.id === "none" ? null : args.currentGasAnnual,
          currentElecNote: args.currentElecNote,
          currentGasNote: args.currentGasNote,
        })
        .where(eq(schema.addresses.id, args.addressId))
        .returning();
      const row = updated[0];
      if (!row) throw new Error("这个地址不存在，可能已被删除。");
      ctx.invalidateQueries();
      return {
        address: toAddressOut(row, await addressHasData(ctx, row.id)),
      };
    },
  }),

  deleteAddress: defineAction({
    description:
      "Deletes a saved address and its snapshots. The last remaining address cannot be deleted; deleting the active address switches to the first remaining one.",
    request: z.object({ addressId: z.number().int().min(1) }),
    response: z.object({ deleted: z.boolean(), activeAddressId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const all = await listAddresses(ctx);
      if (all.length <= 1) {
        throw new Error("只剩一个地址，不能删除。");
      }
      const target = all.find((a) => a.id === args.addressId);
      if (!target) throw new Error("这个地址不存在，可能已被删除。");
      const active = await getActiveAddress(ctx);
      if (!active) throw new Error("没有可删除的地址。");
      await db
        .delete(schema.snapshots)
        .where(eq(schema.snapshots.addressId, target.id));
      await db
        .delete(schema.addresses)
        .where(eq(schema.addresses.id, target.id));
      let activeId = active.id;
      if (active.id === target.id) {
        const remaining = await listAddresses(ctx);
        const next = remaining[0];
        if (!next) throw new Error("删除后没有可用地址。");
        await mirrorUsageToSettings(ctx, next);
        activeId = next.id;
      }
      ctx.invalidateQueries();
      return { deleted: true, activeAddressId: activeId };
    },
  }),

} satisfies ActionsModule;
