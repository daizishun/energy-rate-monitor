import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import { SafeAreaTopScrim } from "./safe-area";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Snapshot = Dashboard["snapshots"][number];
type Plan = Snapshot["elecPlans"][number];
type Settings = Dashboard["settings"];
type Address = Dashboard["addresses"][number];
type AddressSuggestion = ApiResponse<
  typeof api,
  "searchAddresses"
>["suggestions"][number];

/**
 * Parses a freehand address typed into the single address input —
 * "12 Smith St, Melbourne VIC 3000" — into the parts the save action
 * needs. Returns null when no trailing 4-digit postcode or no
 * street/suburb split can be read, so the user can be asked to pick
 * from the dropdown instead.
 */
/**
 * Normalizes an address string for the saved-address match below:
 * lowercases, drops punctuation, and expands street-type
 * abbreviations (Rd → road, Ct → court …) on BOTH sides, so what the
 * user types ("123 Smith St, Fitz") can match a saved address
 * stored in Nominatim's spelling ("123 Smith Street, Fitzroy").
 * Plain substring matching missed exactly that case.
 */
const STREET_ABBREVIATIONS: Record<string, string> = {
  rd: "road",
  st: "street",
  ct: "court",
  ave: "avenue",
  av: "avenue",
  dr: "drive",
  cres: "crescent",
  pl: "place",
  hwy: "highway",
  tce: "terrace",
  blvd: "boulevard",
  ln: "lane",
};

function normalizeAddressText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_ABBREVIATIONS[t] ?? t)
    .join(" ");
}

function parseAddressText(
  text: string,
): { street: string; suburb: string; postcode: string; state: string } | null {
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
  const stateMatched = stateMatch?.[0];
  const stateRaw = stateMatch?.[1];
  const state = stateRaw ? stateRaw.toUpperCase() : "VIC";
  const beforeState = (
    stateMatched
      ? before.slice(0, before.length - stateMatched.length)
      : before
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
  return { street, suburb, postcode, state };
}

// ---------------------------------------------------------------------------
// Formatting & pricing helpers (mirror the server's pricing logic)
// ---------------------------------------------------------------------------

function fmtMoney(v: number): string {
  return `$${Math.round(v).toLocaleString("en-AU")}`;
}

function fmtC(v: number): string {
  return `${Number(v.toFixed(2))}c`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Australia/Sydney",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", {
    timeZone: "Australia/Sydney",
    month: "numeric",
    day: "numeric",
  });
}

function stepsAnnual(supplyCPerDay: number, steps: Plan["steps"], annualUsage: number): number {
  const daily = annualUsage / 365;
  let remaining = daily;
  let usageC = 0;
  for (const step of steps) {
    if (remaining <= 0) break;
    const vol =
      step.upToPerDay == null ? remaining : Math.min(remaining, step.upToPerDay);
    usageC += vol * step.rateC;
    remaining -= vol;
  }
  return ((supplyCPerDay + usageC) * 365) / 100;
}

function feedInCredit(plan: Plan, solarExportKwh: number): number {
  if (plan.feedInC === 0 && plan.feedInAboveCapC == null) return 0;
  if (plan.feedInCapPerDay == null) return (solarExportKwh * plan.feedInC) / 100;
  const capped = Math.min(solarExportKwh, plan.feedInCapPerDay * 365);
  const above = plan.feedInAboveCapC ?? 0;
  return (capped * plan.feedInC + (solarExportKwh - capped) * above) / 100;
}

/** Net annual electricity cost: TOU or single-rate usage + supply − feed-in. */
function elecNet(plan: Plan, s: Settings): number {
  const supply = (plan.supplyCPerDay * 365) / 100;
  let usage: number;
  if (plan.tou) {
    usage =
      (s.elecPeakKwh * plan.tou.peakC +
        s.elecFlatKwh * plan.tou.flatC +
        s.elecShoulderKwh * plan.tou.shoulderC) /
      100;
  } else {
    usage = stepsAnnual(0, plan.steps, s.elecPeakKwh + s.elecFlatKwh + s.elecShoulderKwh);
  }
  return supply + usage - feedInCredit(plan, s.solarExportKwh);
}

function gasAnnual(plan: Plan, gasMj: number): number {
  return stepsAnnual(plan.supplyCPerDay, plan.steps, gasMj);
}

// All snapshots are priced from their stored rates at the current usage
// profile. (An earlier build showed a bundled PDF baseline's published
// costs verbatim at its own usage basis; the open-source build ships no
// such baseline, so there is no special case here.)
function planCost(plan: Plan, kind: "elec" | "gas", s: Settings, _snapshot: Snapshot): number {
  return kind === "elec" ? elecNet(plan, s) : gasAnnual(plan, s.gasMj);
}

function cheapestCost(
  plans: Plan[],
  kind: "elec" | "gas",
  s: Settings,
  snapshot: Snapshot,
): number | null {
  if (plans.length === 0) return null;
  return Math.min(...plans.map((p) => planCost(p, kind, s, snapshot)));
}

function bestPlan(
  plans: Plan[],
  kind: "elec" | "gas",
  s: Settings,
  snapshot: Snapshot,
): Plan | undefined {
  return [...plans].sort(
    (a, b) => planCost(a, kind, s, snapshot) - planCost(b, kind, s, snapshot),
  )[0];
}

function gasStepsText(plan: Plan): string {
  if (plan.steps.length === 1) return `单一 ${fmtC(plan.steps[0]?.rateC ?? 0)}/MJ`;
  let cum = 0;
  return plan.steps
    .map((st, i) => {
      if (st.upToPerDay == null) return `余 ${fmtC(st.rateC)}`;
      cum += st.upToPerDay;
      return i === 0
        ? `首 ${st.upToPerDay} MJ/天 ${fmtC(st.rateC)}`
        : `至 ${Math.round(cum * 10) / 10} MJ/天 ${fmtC(st.rateC)}`;
    })
    .join(" · ");
}

function elecRatesText(plan: Plan): string {
  if (plan.tou) {
    return `峰 ${fmtC(plan.tou.peakC)} / 平 ${fmtC(plan.tou.flatC)} / 肩 ${fmtC(plan.tou.shoulderC)}（c/kWh）`;
  }
  if (plan.steps.length === 1) return `单一费率 ${fmtC(plan.steps[0]?.rateC ?? 0)}/kWh`;
  return plan.steps
    .map((s) =>
      s.upToPerDay == null
        ? `${fmtC(s.rateC)} 起`
        : `首 ${s.upToPerDay} kWh/天 ${fmtC(s.rateC)}`,
    )
    .join(" · ");
}

function feedInText(plan: Plan): string {
  if (plan.feedInNote) return `回购：${plan.feedInNote}`;
  if (plan.feedInC === 0) return "无太阳能回购";
  if (plan.feedInCapPerDay != null) {
    return `回购 ${fmtC(plan.feedInC)}/kWh（前 ${plan.feedInCapPerDay} kWh/天）`;
  }
  return `回购 ${fmtC(plan.feedInC)}/kWh`;
}

function fmtAud(v: number): string {
  return `$${v.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString("en-AU");
}

type CalcLine = { label: string; math: string; amount: number };

/** Per-step usage lines for a stepped (single-rate elec / gas) plan:
 * the year's usage is split by the plan's daily step widths, exactly as
 * stepsAnnual prices it, so each line's amount sums to the usage charge. */
function calcStepLines(
  steps: Plan["steps"],
  annualUsage: number,
  unit: "kWh" | "MJ",
): CalcLine[] {
  const daily = annualUsage / 365;
  let remaining = daily;
  const lines: CalcLine[] = [];
  steps.forEach((step, i) => {
    if (remaining <= 0) return;
    const volPerDay =
      step.upToPerDay == null ? remaining : Math.min(remaining, step.upToPerDay);
    const annualVol = volPerDay * 365;
    const amount = (annualVol * step.rateC) / 100;
    const label =
      steps.length === 1 ? "用量（单一价）" : `用量 · 第 ${i + 1} 档`;
    const math =
      steps.length === 1
        ? `${fmtInt(annualUsage)} ${unit} × ${fmtC(step.rateC)}/${unit}`
        : `${volPerDay.toFixed(2)} ${unit}/天 × 365 天 = ${fmtInt(annualVol)} ${unit} × ${fmtC(step.rateC)}/${unit}`;
    lines.push({ label, math, amount });
    remaining -= volPerDay;
  });
  return lines;
}

/**
 * The full calculation behind one plan's annual figure, as line items
 * whose amounts sum to the displayed total (supply + usage − feed-in
 * for electricity; supply + stepped usage for gas), priced at the
 * household's current usage settings — the same inputs planCost uses.
 */
function buildCalcLines(plan: Plan, kind: "elec" | "gas", s: Settings): CalcLine[] {
  const lines: CalcLine[] = [
    {
      label: "供应费",
      math: `${fmtC(plan.supplyCPerDay)}/天 × 365 天`,
      amount: (plan.supplyCPerDay * 365) / 100,
    },
  ];
  if (kind === "elec") {
    if (plan.tou) {
      lines.push(
        {
          label: "峰段用电（16–21 点）",
          math: `${fmtInt(s.elecPeakKwh)} kWh × ${fmtC(plan.tou.peakC)}/kWh`,
          amount: (s.elecPeakKwh * plan.tou.peakC) / 100,
        },
        {
          label: "平段用电（21–11 点）",
          math: `${fmtInt(s.elecFlatKwh)} kWh × ${fmtC(plan.tou.flatC)}/kWh`,
          amount: (s.elecFlatKwh * plan.tou.flatC) / 100,
        },
        {
          label: "肩段用电（11–16 点）",
          math: `${fmtInt(s.elecShoulderKwh)} kWh × ${fmtC(plan.tou.shoulderC)}/kWh`,
          amount: (s.elecShoulderKwh * plan.tou.shoulderC) / 100,
        },
      );
    } else {
      lines.push(
        ...calcStepLines(
          plan.steps,
          s.elecPeakKwh + s.elecFlatKwh + s.elecShoulderKwh,
          "kWh",
        ),
      );
    }
    const credit = feedInCredit(plan, s.solarExportKwh);
    if (plan.feedInCapPerDay != null) {
      const capped = Math.min(s.solarExportKwh, plan.feedInCapPerDay * 365);
      const above = s.solarExportKwh - capped;
      const aboveRate = plan.feedInAboveCapC ?? 0;
      lines.push({
        label: "太阳能回购（扣减）",
        math:
          above > 0
            ? `前 ${fmtInt(capped)} kWh × ${fmtC(plan.feedInC)}/kWh + 超出 ${fmtInt(above)} kWh × ${fmtC(aboveRate)}/kWh`
            : `${fmtInt(capped)} kWh × ${fmtC(plan.feedInC)}/kWh（上限 ${plan.feedInCapPerDay} kWh/天）`,
        amount: -credit,
      });
    } else if (plan.feedInC !== 0 || credit !== 0) {
      lines.push({
        label: "太阳能回购（扣减）",
        math: `${fmtInt(s.solarExportKwh)} kWh × ${fmtC(plan.feedInC)}/kWh`,
        amount: -credit,
      });
    } else {
      lines.push({ label: "太阳能回购", math: "无回购", amount: 0 });
    }
  } else {
    lines.push(...calcStepLines(plan.steps, s.gasMj, "MJ"));
  }
  return lines;
}

/** One-line equation from the calc lines: $a + $b + … − $credit = $total. */
function calcEquation(lines: CalcLine[]): string {
  const parts = lines.filter((l) => l.amount !== 0);
  if (parts.length === 0) return "";
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const body = parts
    .map((l, i) => {
      if (i === 0) return fmtAud(l.amount);
      return l.amount >= 0
        ? `+ ${fmtAud(l.amount)}`
        : `− ${fmtAud(-l.amount)}`;
    })
    .join(" ");
  return `${body} = ${fmtAud(total)}`;
}

/**
 * Inline 「计算过程」 toggle that sits directly behind (after) the
 * plan's annual total on the same line. Tapping it expands CalcPanel
 * right under the header row, so the equation stays attached to the
 * $/年 figure it explains.
 */
function CalcToggle({
  open,
  onToggle,
  planName,
  kind,
}: {
  open: boolean;
  onToggle: () => void;
  planName: string;
  kind: "elec" | "gas";
}) {
  const color = kind === "elec" ? "var(--accent)" : "var(--gas)";
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${planName} 年费计算过程`}
      onClick={onToggle}
      className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium whitespace-nowrap"
      style={{ color }}
    >
      {open ? "计算过程 ▴" : "计算过程 ▾"}
    </button>
  );
}

/**
 * The expanded calculation for one plan's annual fee: every component
 * (supply, each usage period / step, the feed-in credit) with its own
 * multiplication, then the summed equation — so the headline $/年 can
 * be checked line by line.
 */
function CalcPanel({
  plan,
  kind,
  settings,
  annual,
}: {
  plan: Plan;
  kind: "elec" | "gas";
  settings: Settings;
  annual: number;
}) {
  const lines = buildCalcLines(plan, kind, settings);
  return (
        <div className="mt-2 rounded-[var(--radius)] bg-[var(--surface-alt)] p-3">
          <p className="text-xs font-medium text-[var(--text)]">
            年费 = 供应费 + 用电{kind === "elec" ? " − 太阳能回购" : ""}
            <span className="ml-1 font-normal text-[var(--dim)]">
              （按当前用量设置：{kind === "elec"
                ? `峰 ${fmtInt(settings.elecPeakKwh)} / 平 ${fmtInt(settings.elecFlatKwh)} / 肩 ${fmtInt(settings.elecShoulderKwh)} kWh，出线 ${fmtInt(settings.solarExportKwh)} kWh`
                : `气 ${fmtInt(settings.gasMj)} MJ/年，${(settings.gasMj / 365).toFixed(1)} MJ/天`}
              ）
            </span>
          </p>
          <ul className="mt-2 space-y-1.5">
            {lines.map((l) => (
              <li
                key={l.label}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums"
              >
                <span className="min-w-0 text-[var(--dim)]">
                  {l.label}：<span className="text-[var(--text)]">{l.math}</span>
                </span>
                <span className="shrink-0 font-medium text-[var(--text)]">
                  {l.amount < 0 ? `−${fmtAud(-l.amount)}` : fmtAud(l.amount)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-[var(--border)] pt-2 text-xs font-medium tabular-nums text-[var(--text)]">
            {calcEquation(lines)}
            <span className="ml-1 font-normal text-[var(--dim)]">
              ≈ {fmtMoney(annual)}/年{kind === "elec" ? "（净）" : ""}
            </span>
          </p>
          {isVariablePriced(plan) ? (
            <p className="mt-1 text-xs font-medium" style={{ color: "var(--gas)" }}>
              注：批发可变价套餐——上面用的是 CDR 公布的估算费率，实际电价随批发市场每 5–30 分钟浮动，这个年费只是估算，实际账单可能明显不同。
            </p>
          ) : null}
          {plan.feedInNote ? (
            <p className="mt-1 text-xs text-[var(--dim)]">{plan.feedInNote}</p>
          ) : null}
        </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Delta({ current, previous }: { current: number; previous: number | null }) {
  if (previous == null) return null;
  const diff = Math.round(current - previous);
  if (diff === 0) return <span className="text-[var(--dim)]">与上次检查持平</span>;
  if (diff < 0)
    return (
      <span className="font-medium text-[var(--accent)]">较上次便宜 {fmtMoney(-diff)}</span>
    );
  return (
    <span className="font-medium text-[var(--danger)]">较上次涨了 {fmtMoney(diff)}</span>
  );
}

type RefreshStatus = "updated" | "unchanged" | "failed";

const STATUS_LABELS: Record<RefreshStatus, string> = {
  updated: "有更新",
  unchanged: "没有更新",
  failed: "更新失败",
};

const STATUS_BADGE_COLORS: Record<RefreshStatus, string> = {
  updated: "#2f9e5f",
  unchanged: "#9aa5a0",
  failed: "var(--danger)",
};

const STATUS_BADGE_GLYPHS: Record<RefreshStatus, string> = {
  updated: "↑",
  unchanged: "－",
  failed: "!",
};

/**
 * Coloured circular status badge for the outcome of the most recent
 * refresh: green ↑ = 有更新， grey － = 没有更新， red ! = 更新失败
 * (the word rides along as the badge's aria-label / title). Shown in
 * three places — the 最优组合 header (combined outcome of both fuels),
 * each 电/气 tab button (that fuel's outcome), and each ranking row —
 * instead of a text badge repeated in every heading and card.
 */
function UpdateStatusDot({ status }: { status: RefreshStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center align-middle">
      <span
        role="img"
        aria-label={STATUS_LABELS[status]}
        title={STATUS_LABELS[status]}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold leading-none text-white shadow-sm ring-1 ring-black/10"
        style={{ background: STATUS_BADGE_COLORS[status] }}
      >
        <span aria-hidden="true">{STATUS_BADGE_GLYPHS[status]}</span>
      </span>
    </span>
  );
}

/** Key-order-insensitive JSON form (mirrors the server's comparison). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function planKey(plan: Plan): string {
  return `${plan.retailer}${plan.planName}`;
}

/**
 * The plan's CDR code as retailers quote it (e.g. FLO803807MR) — the
 * stored planId carries a "@VEC" suffix that is not part of the code.
 * PDF-baseline plans have no CDR id, so they show no 编号 line.
 */
function planCode(plan: Plan): string | null {
  if (!plan.planId) return null;
  const code = plan.planId.split("@")[0]?.trim();
  return code ? code : null;
}

function PlanCode({ plan }: { plan: Plan }) {
  const code = planCode(plan);
  if (!code) return null;
  return (
    <span className="block text-xs tabular-nums text-[var(--dim)]">编号 {code}</span>
  );
}

/**
 * Wholesale / variable-priced plans (Flow Power, Amber): CDR publishes
 * only estimate rates for them — the real price floats with the
 * wholesale market. The server leads such a plan's conditions with the
 * 批发可变价 explanation; the plan names themselves also carry
 * "Wholesale" / "Variable … (estimate)". Either signal marks the plan
 * so its annual figure is never read as a fixed-tariff quote.
 */
function isVariablePriced(plan: Plan): boolean {
  return (
    plan.conditions.includes("批发可变价") ||
    /wholesale/i.test(plan.planName) ||
    (/variable/i.test(plan.planName) && /estimate/i.test(plan.planName))
  );
}

/**
 * Split a plan's stored note into the visible Chinese text and the
 * retailer's original English segments (user request 2026-11-20:
 * 有备注的原文都翻译一下，且隐藏原文用类似向下箭头点击可展开）.
 * Fresh snapshots store the originals as 原文｜-prefixed lines and the
 * visible lines already carry Chinese (a translation, or the Chinese
 * summary for wholesale plans). Snapshots stored before that carry
 * （零售商原文） lines inline instead: those segments move into the
 * expandable block too, with the visible line keeping just the
 * Chinese label until the next refresh stores a translation.
 */
function splitNote(plan: Plan): { zh: string; originals: string[] } {
  const originals: string[] = [];
  const zhLines: string[] = [];
  for (const line of (plan.conditions ?? "").split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("原文｜")) {
      originals.push(line.slice("原文｜".length));
      continue;
    }
    if (line.includes("零售商原文")) {
      const idx = line.indexOf("：");
      const rawLabel = idx >= 0 ? line.slice(0, idx) : line;
      const text = idx >= 0 ? line.slice(idx + 1) : "";
      const label = rawLabel
        .replace(/，零售商原文/g, "")
        .replace(/（零售商原文）/g, "");
      if (text) originals.push(`${label}：${text}`);
      zhLines.push(`${label}：（原文见下方展开）`);
      continue;
    }
    zhLines.push(line);
  }
  return { zh: zhLines.join("\n"), originals };
}

/** A plan's note: Chinese text visible, retailer originals collapsed
 * behind a 「零售商原文 ▾」 toggle (see splitNote). */
function PlanNote({ plan }: { plan: Plan }) {
  const [origOpen, setOrigOpen] = useState(false);
  const note = splitNote(plan);
  if (!note.zh && note.originals.length === 0) return null;
  return (
    <>
      {note.zh ? (
        <p className="mt-0.5 whitespace-pre-line text-xs text-[var(--dim)]">备注：{note.zh}</p>
      ) : null}
      {note.originals.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={origOpen}
            aria-label={`${plan.planName} 零售商原文`}
            onClick={() => setOrigOpen((v) => !v)}
            className="mt-1 inline-flex min-h-8 items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--dim)]"
          >
            {origOpen ? "零售商原文 ▴" : "零售商原文 ▾"}
          </button>
          {origOpen ? (
            <p className="mt-1 whitespace-pre-line text-xs text-[var(--dim)]">
              {note.originals.join("\n")}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Amber pill marking a wholesale variable-price (estimate) plan. */
function VariablePriceChip() {
  return (
    <span
      role="img"
      aria-label="批发可变价，年费为估算"
      title="批发可变价：电价随批发市场浮动，年费按 CDR 公布的估算费率计算"
      className="ml-1.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 align-middle text-[11px] font-semibold leading-none"
      style={{ background: "var(--gas-soft)", color: "var(--gas)" }}
    >
      批发可变价·估算
    </span>
  );
}

/**
 * Whether the plan's own published conditions (the stored Chinese
 * note text) make a solar system a hard eligibility requirement —
 * e.g. ENGIE Solar Elec: 「您必须已安装…太阳能系统」, and the Flow
 * Power wholesale summaries: 「仅限有太阳能、电池、智能电表的客户」.
 * A mere mention of feed-in eligibility does NOT match (AGL Seniors:
 * 「如需了解太阳能回馈电价资格…」): a requirement word （必须 / 须 /
 * 仅限 / 只适用 / 仅适用） must sit in the same clause as 太阳能， or
 * 太阳能 must be followed by 才 / 方可.
 */
function solarRequiredByConditions(plan: Plan): boolean {
  return /(必须|须|仅限|只适用|仅适用)[^。；\n]{0,30}太阳能|太阳能[^。；\n]{0,12}(才|方可|才能)/.test(
    plan.conditions,
  );
}

/**
 * Whether a stored electricity plan applies to the household's current
 * equipment checkboxes. A refresh fetches ALL of the address's plans —
 * battery and EV plans included — and stores them; this filter is what
 * shows or hides them (user request 2026-11-20: only an address change
 * re-fetches, every other condition change just re-displays). The name
 * rules mirror the ones the server used at extraction time before the
 * filter moved to the display side: battery-named plans need 电池，
 * EV-named plans need 电车. The rules are conjunctive — a plan must
 * satisfy EVERY equipment requirement it carries (a "Battery + Solar"
 * plan needs both boxes ticked).
 *
 * Solar was the missing third rule (user report 2026-11-20: with
 * 太阳能/电池/电车 all unticked, solar feed-in plans were still
 * displayed in the ranking). Feed-in CREDIT already zeroes when
 * neither 太阳能 nor 电池 is ticked, but solar-SPECIFIC plans stayed
 * visible — name-borne ones (EnergyAustralia Solar Max, CovaU
 * SolarMax, ENGIE Solar Elec) and ones whose own conditions require
 * an installed solar system. They now need 太阳能 ticked, exactly
 * like battery / EV plans need their boxes. Ordinary plans that
 * merely offer a feed-in tariff are unaffected: with no solar their
 * export is 0, so the tariff earns nothing in the annual figure.
 * Gas plans always apply.
 */
function planAppliesToHousehold(plan: Plan, s: Settings): boolean {
  if (/battery/i.test(plan.planName) && !s.hasBattery) return false;
  if (
    (/\bev\b/i.test(plan.planName) || /electric vehicle/i.test(plan.planName)) &&
    !s.hasEv
  ) {
    return false;
  }
  if (/solar/i.test(plan.planName) && !s.hasSolar) return false;
  if (!s.hasSolar && solarRequiredByConditions(plan)) return false;
  return true;
}

/**
 * Words that only name a plan's meter/tariff variant, never the
 * product itself. Retailers publish most electricity plans in two
 * meter variants — a single-rate one and a time-of-use one (CDR
 * pricingModel SINGLE_RATE / TIME_OF_USE; the stored entry's `tou`
 * field tells them apart) — either under the SAME name (OVO One Plan,
 * Lumo Plus, Sumo Online Saver…) or with the variant spelled out
 * (1st Energy "… - Anytime" vs "… - Time of Use", Alinta "Single
 * Rate" vs "Time of Use (Interval)", Blue NRG "Blue VDO TOU" vs
 * "Blue VDO Single Rate"). Stripping these words (plus punctuation)
 * maps both variants of a product to one family key.
 */
const TARIFF_VARIANT_WORDS = new Set([
  "time",
  "of",
  "use",
  "single",
  "rate",
  "anytime",
  "flat",
  "tou",
  "interval",
  "controlled",
  "load",
  "cl",
  "general",
  "usage",
]);

function planFamilyKey(plan: Plan): string {
  const words = plan.planName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "" && !TARIFF_VARIANT_WORDS.has(w));
  return `${plan.retailer}|${words.join(" ")}`;
}

/**
 * The display filter for a snapshot's electricity plans: the
 * equipment rules above, then the meter-variant rule (user report:
 * "按我的条件应该只刷出这四个套餐，你刷出来有 7 个" — a 1st Energy
 * search for one address returned exactly 4 plans, while the page
 * showed all 7 stored ones: Emerald / Home / VDO each in BOTH
 * variants plus the Midday Power Saver).
 *
 * Root cause, verified 2026-11-20 against the raw CDR data: the two
 * variants of a family differ ONLY in their rate structure — a full
 * recursive diff of the Emerald and VDO pairs shows eligibility,
 * included postcodes, fees, supply-charge type and effective dates
 * are all identical, so NO plan-side field decides which variant an
 * address gets. Every plan's eligibility text instead defines
 * applicability against the PREMISES: "available to customers …
 * with the applicable network tariff and meter configuration". A
 * retailer quote site resolves the entered address to its meter
 * (NMI) and reads the meter's registered tariff configuration —
 * which is why the user never had to enter it — and then, per plan
 * family, offers only the variant matching that configuration. A
 * family published in only one variant shows regardless: Midday
 * Power Saver exists solely as a time-varying plan and 1st Energy's
 * own help page offers it to any residential customer with a smart
 * meter, so a result set legitimately mixes single-rate
 * and time-of-use plans. The tool cannot read meter registrations, so the
 * per-address 电表类型 setting stands in for it; for an address whose
 * retailer search returns single-rate variants it is "single". The rule
 * itself is uniform across retailers and addresses — no per-brand
 * special-casing. Like the checkboxes this is display-only: both
 * variants stay stored, switching the meter type re-displays with
 * no re-fetch. Validated against a stored snapshot:
 * meter 单费率 → 1st Energy shows the single-rate variants + Midday;
 * meter 分时 → the three TOU variants + Midday.
 */
function filterElecPlansForHousehold(plans: Plan[], s: Settings): Plan[] {
  const kept = plans.filter((p) => planAppliesToHousehold(p, s));
  const variants = new Map<string, { tou: boolean; flat: boolean }>();
  for (const p of kept) {
    const key = planFamilyKey(p);
    const v = variants.get(key) ?? { tou: false, flat: false };
    if (p.tou) v.tou = true;
    else v.flat = true;
    variants.set(key, v);
  }
  return kept.filter((p) => {
    const v = variants.get(planFamilyKey(p));
    if (!v || !(v.tou && v.flat)) return true;
    return s.meterType === "tou" ? p.tou != null : p.tou == null;
  });
}

/** Canonical form of one plan with the CDR plan id removed. CDR
 * republishes identical offers under alternating plan ids, and the id is
 * not a price change (mirrors the server's snapshot comparison). */
function canonicalPlan(plan: Plan): string {
  return canonicalJson({ ...plan, planId: null });
}

/**
 * Per-plan outcome of the latest refresh: each displayed plan is compared
 * against the same plan in the previous snapshot (matched by CDR plan id,
 * falling back to retailer + plan name). New or changed → 有更新，
 * identical → 没有更新， and a failed refresh marks every row 更新失败.
 * Plans whose retailer was carried over from the previous snapshot
 * (its brand failed this refresh but its last data is still shown) are
 * marked 更新失败 individually, even when the rest of the fuel updated
 * or held steady.
 */
function buildPlanStatuses(
  current: Plan[],
  previous: Plan[] | undefined,
  failed: boolean,
  carriedRetailers?: ReadonlySet<string>,
): Record<string, RefreshStatus> {
  const out: Record<string, RefreshStatus> = {};
  for (const plan of current) {
    if (failed || carriedRetailers?.has(plan.retailer)) {
      out[planKey(plan)] = "failed";
      continue;
    }
    const prev =
      (plan.planId != null
        ? previous?.find((p) => p.planId === plan.planId)
        : undefined) ??
      previous?.find(
        (p) => p.retailer === plan.retailer && p.planName === plan.planName,
      );
    out[planKey(plan)] =
      !prev || canonicalPlan(prev) !== canonicalPlan(plan)
        ? "updated"
        : "unchanged";
  }
  return out;
}

function VsCurrent({ cost, current }: { cost: number; current: number | null }) {
  // No known current-plan cost for this address → no comparison (never
  // borrow another address's figures).
  if (current == null) return null;
  const diff = Math.round(current - cost);
  if (diff > 0)
    return <span className="font-medium text-[var(--accent)]">比现在省 {fmtMoney(diff)}</span>;
  if (diff < 0)
    return <span className="font-medium text-[var(--danger)]">比现在贵 {fmtMoney(-diff)}</span>;
  return <span className="text-[var(--dim)]">与现在持平（当前套餐）</span>;
}

/** Full detail block for one plan (name, vs-current, rates, feed-in, notes). */
function PlanDetail({
  plan,
  annual,
  kind,
  currentAnnual,
  status,
  settings,
}: {
  plan: Plan;
  annual: number;
  kind: "elec" | "gas";
  currentAnnual: number | null;
  status?: RefreshStatus;
  settings: Settings;
}) {
  const [calcOpen, setCalcOpen] = useState(false);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm font-medium text-[var(--text)]">
          {plan.planName} {status ? <UpdateStatusDot status={status} /> : null}
          {isVariablePriced(plan) ? <VariablePriceChip /> : null}
          <PlanCode plan={plan} />
        </p>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <p className="font-[family-name:var(--font-display)] text-lg font-semibold tabular-nums text-[var(--text)]">
            {fmtMoney(annual)}
            <span className="ml-1 text-xs font-normal text-[var(--dim)]">
              /年{kind === "elec" ? "（净）" : ""}
            </span>
          </p>
          <CalcToggle
            open={calcOpen}
            onToggle={() => setCalcOpen((v) => !v)}
            planName={plan.planName}
            kind={kind}
          />
        </div>
      </div>
      {calcOpen ? (
        <CalcPanel
          plan={plan}
          kind={kind}
          settings={settings}
          annual={annual}
        />
      ) : null}
      <p className="mt-1 text-sm">
        <VsCurrent cost={annual} current={currentAnnual} />
      </p>
      <p className="mt-1 text-sm tabular-nums text-[var(--text)]">
        供应费 {fmtC(plan.supplyCPerDay)}/天 ·{" "}
        {kind === "elec" ? elecRatesText(plan) : gasStepsText(plan)}
      </p>
      {kind === "elec" ? (
        <p className="mt-0.5 text-xs text-[var(--dim)]">{feedInText(plan)}</p>
      ) : null}
      <PlanNote plan={plan} />
    </>
  );
}

function PlanList({
  plans,
  kind,
  settings,
  snapshot,
  currentAnnual,
  statusByKey,
}: {
  plans: Plan[];
  kind: "elec" | "gas";
  settings: Settings;
  snapshot: Snapshot;
  currentAnnual: number | null;
  statusByKey?: Record<string, RefreshStatus> | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [calcExpanded, setCalcExpanded] = useState<Record<string, boolean>>({});
  const priced = plans.map((p) => ({
    plan: p,
    annual: planCost(p, kind, settings, snapshot),
  }));
  // With 电池 ticked (electricity only), a supplier that HAS wholesale
  // variable-price plans is pulled to the front of the whole ranking
  // AS A WHOLE GROUP (user request 2026-11-20, clarified twice the
  // same day — an earlier within-supplier-only ordering was explicitly
  // rejected): inside such a group the wholesale plans lead, ordered
  // by supply charge (their annual figure is only an estimate at
  // floating wholesale rates, so the fixed daily supply charge is the
  // comparable number), and the supplier's other plans follow in
  // their original order, unchanged. Wholesale groups order among
  // themselves by their lead wholesale plan's supply charge;
  // suppliers without a wholesale plan keep their original
  // annual-cost ranking behind them.
  const wholesaleFirst = kind === "elec" && settings.hasBattery;
  const hasVariable = wholesaleFirst && priced.some(({ plan }) => isVariablePriced(plan));
  // Group by retailer: the best plan shows in full and the retailer's
  // other plans sit behind an expand toggle. Groups are ranked by
  // rankAnnual; items inside a group follow the display order above
  // (wholesale first by supply charge, then the rest in their
  // original annual order), or plain annual order when 电池 is not
  // ticked.
  const groups: {
    key: string;
    retailer: string;
    items: { plan: Plan; annual: number }[];
    rankAnnual: number;
    leadSupply: number | null;
  }[] = [];
  for (const item of [...priced].sort((a, b) => a.annual - b.annual)) {
    const group = groups.find((g) => g.key === `retailer-${item.plan.retailer}`);
    if (group) group.items.push(item);
    else
      groups.push({
        key: `retailer-${item.plan.retailer}`,
        retailer: item.plan.retailer,
        items: [item],
        rankAnnual: item.annual,
        leadSupply: null,
      });
  }
  if (wholesaleFirst) {
    for (const group of groups) {
      const variable = group.items
        .filter(({ plan }) => isVariablePriced(plan))
        .sort(
          (a, b) =>
            a.plan.supplyCPerDay - b.plan.supplyCPerDay || a.annual - b.annual,
        );
      if (variable.length === 0) continue;
      // The supplier's other plans keep their original order (the
      // annual order they were grouped in) — only the wholesale
      // plans move, to the front of the group.
      const regular = group.items.filter(({ plan }) => !isVariablePriced(plan));
      group.items = [...variable, ...regular];
      group.leadSupply = variable[0]?.plan.supplyCPerDay ?? null;
    }
    groups.sort((a, b) => {
      if (a.leadSupply != null && b.leadSupply != null)
        return a.leadSupply - b.leadSupply || a.rankAnnual - b.rankAnnual;
      if (a.leadSupply != null) return -1;
      if (b.leadSupply != null) return 1;
      return a.rankAnnual - b.rankAnnual;
    });
  }
  const visible = showAll ? groups : groups.slice(0, 10);
  const color = kind === "elec" ? "var(--accent)" : "var(--gas)";
  if (priced.length === 0)
    return <p className="py-4 text-sm text-[var(--dim)]">暂无数据，点「立即刷新」重试。</p>;
  return (
    <>
      {hasVariable ? (
        <p className="mt-2 text-xs text-[var(--dim)]">
          已勾选电池：有批发价套餐的供应商整家排到总排名最前面，批发价供应商之间按各自批发价套餐的供应费从低到高排（这类套餐的年费只是估算，供应费是固定可比的部分）；每家内部，批发价套餐排在最前面，该供应商的其他套餐接在后面、顺序不变；没有批发价套餐的供应商按原来的年费排名接在后面。
        </p>
      ) : null}
      <ol className="divide-y divide-[var(--border)]">
        {visible.map((group, i) => {
          const { retailer, items } = group;
          const best = items[0];
          if (!best) return null;
          const rest = items.slice(1);
          const isOpen = expanded[group.key] ?? false;
          const calcOpen = calcExpanded[group.key] ?? false;
          const bestStatus = statusByKey?.[planKey(best.plan)];
          return (
            <li key={group.key} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-base font-medium text-[var(--text)]">
                  <span
                    className="mr-2 font-[family-name:var(--font-display)] text-lg"
                    style={{ color }}
                  >
                    {i + 1}
                  </span>
                  {retailer}{" "}
                  {bestStatus ? <UpdateStatusDot status={bestStatus} /> : null}
                </p>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  <p className="font-[family-name:var(--font-display)] text-xl font-semibold tabular-nums text-[var(--text)]">
                    {fmtMoney(best.annual)}
                    <span className="ml-1 text-xs font-normal text-[var(--dim)]">
                      /年{kind === "elec" ? "（净）" : ""}
                    </span>
                  </p>
                  <CalcToggle
                    open={calcOpen}
                    onToggle={() =>
                      setCalcExpanded((prev) => ({ ...prev, [group.key]: !calcOpen }))
                    }
                    planName={best.plan.planName}
                    kind={kind}
                  />
                </div>
              </div>
              {calcOpen ? (
                <CalcPanel
                  plan={best.plan}
                  kind={kind}
                  settings={settings}
                  annual={best.annual}
                />
              ) : null}
              <p className="mt-0.5 text-sm text-[var(--dim)]">
                <span className="line-clamp-2">
                  {best.plan.planName}
                  {isVariablePriced(best.plan) ? <VariablePriceChip /> : null}
                </span>
                <PlanCode plan={best.plan} />
                {rest.length > 0 ? (
                  <span className="mt-0.5 block text-xs">
                    {isVariablePriced(best.plan)
                      ? `这家共 ${items.length} 个套餐，批发价套餐排在这家最前面，下面先显示它`
                      : `这家共 ${items.length} 个套餐，下面只显示最便宜的`}
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-sm">
                <VsCurrent cost={best.annual} current={currentAnnual} />
              </p>
              <p className="mt-1 text-sm tabular-nums text-[var(--text)]">
                供应费 {fmtC(best.plan.supplyCPerDay)}/天 ·{" "}
                {kind === "elec" ? elecRatesText(best.plan) : gasStepsText(best.plan)}
              </p>
              {kind === "elec" ? (
                <p className="mt-0.5 text-xs text-[var(--dim)]">{feedInText(best.plan)}</p>
              ) : null}
              <PlanNote plan={best.plan} />
              {rest.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${retailer} 其他 ${rest.length} 个套餐`}
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [group.key]: !isOpen }))
                    }
                    className="mt-3 flex min-h-11 w-full items-center justify-center gap-1 rounded-[var(--radius)] border px-3 text-sm font-medium"
                    style={{
                      borderColor: color,
                      color,
                      background: "var(--surface-alt)",
                    }}
                  >
                    {isOpen
                      ? "收起其他套餐 ▴"
                      : `查看其他 ${rest.length} 个套餐（${fmtMoney(rest[0]?.annual ?? 0)} 起）▾`}
                  </button>
                  {isOpen ? (
                    <ul className="mt-2 space-y-3 border-l-2 border-[var(--border)] pl-3">
                      {rest.map(({ plan, annual }, ri) => (
                        <li key={plan.planId ?? `${plan.retailer}-${plan.planName}-${ri}`}>
                          <PlanDetail
                            plan={plan}
                            annual={annual}
                            kind={kind}
                            currentAnnual={currentAnnual}
                            status={statusByKey?.[planKey(plan)]}
                            settings={settings}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {groups.length > 10 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 min-h-10 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--accent)]"
        >
          {showAll ? "收起" : `查看全部 ${groups.length} 家供应商`}
        </button>
      ) : null}
    </>
  );
}

function HistoryChart({
  snapshots,
  settings,
  kind,
}: {
  snapshots: Snapshot[];
  settings: Settings;
  kind: "elec" | "gas";
}) {
  const points = [...snapshots]
    .reverse()
    .filter((s) => (kind === "elec" ? s.elecPlans.length > 0 : s.gasPlans.length > 0))
    .map((s) => ({
      label: fmtDay(s.takenAt),
      ...(kind === "elec"
        ? {
            // Same display-side filter as the ranking: the trend's
            // cheapest is judged among the plans that apply to the
            // current conditions (checkboxes + meter type).
            电费最低净年费: cheapestCost(
              filterElecPlansForHousehold(s.elecPlans, settings),
              "elec",
              settings,
              s,
            ),
          }
        : { 燃气最低年费: cheapestCost(s.gasPlans, "gas", settings, s) }),
    }));
  if (points.length < 2) return null;
  return (
    <section aria-label="历史走势" className="mt-8">
      <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
        {kind === "elec" ? "电费最低年费走势" : "燃气最低年费走势"}
      </h2>
      <p className="mt-1 text-xs text-[var(--dim)]">
        每次检查的最低年费，按当前用量设置{kind === "elec" ? "（分时 + 回购）" : ""}重新估算
      </p>
      <div className="mt-3 h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--dim)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 11, fill: "var(--dim)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${v}`}
              width={52}
            />
            <Tooltip
              formatter={(value: number | string) =>
                typeof value === "number" ? fmtMoney(value) : value
              }
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 13,
              }}
            />
            {kind === "elec" ? (
              <Line
                type="monotone"
                dataKey="电费最低净年费"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            ) : (
              <Line
                type="monotone"
                dataKey="燃气最低年费"
                stroke="var(--gas)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 flex gap-4 text-xs text-[var(--dim)]">
        {kind === "elec" ? (
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            电费（净）
          </span>
        ) : (
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--gas)]" />
            燃气
          </span>
        )}
      </p>
    </section>
  );
}

const OFFER_LABELS: Record<string, string> = {
  Elec: "电",
  Gas: "气",
  Res: "住宅",
  Bus: "商业",
};

function RetailerList({
  retailers,
  defaultFuel,
}: {
  retailers: Dashboard["retailers"];
  defaultFuel?: "elec" | "gas";
}) {
  const [query, setQuery] = useState("");
  const [fuel, setFuel] = useState<"all" | "Elec" | "Gas">(
    defaultFuel === "gas" ? "Gas" : defaultFuel === "elec" ? "Elec" : "all",
  );
  // Follow the main 电/气 tab: switching tabs re-filters the directory.
  useEffect(() => {
    if (defaultFuel === "gas") setFuel("Gas");
    else if (defaultFuel === "elec") setFuel("Elec");
  }, [defaultFuel]);
  const filtered = retailers.filter((r) => {
    if (fuel !== "all" && !r.offers.includes(fuel)) return false;
    return r.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  return (
    <section aria-label="供应商目录" className="mt-10">
      <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
        全部供应商（{retailers.length} 家）
      </h2>
      <p className="mt-1 text-xs text-[var(--dim)]">
        名单来自 Victorian Energy Compare 官网（2026 年 11 月 19 日核对）
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索供应商"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索供应商名称"
          className="min-h-10 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]"
        />
        {(
          [
            ["all", "全部"],
            ["Elec", "有电"],
            ["Gas", "有气"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={fuel === value}
            onClick={() => setFuel(value)}
            className={`min-h-10 rounded-full px-4 text-sm ${
              fuel === value
                ? "bg-[var(--accent)] font-medium text-white"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {filtered.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--text)]">{r.name}</p>
              <p className="mt-0.5 flex flex-wrap gap-1">
                {r.offers.split(",").map((o) => {
                  const key = o.trim().replace(" only", "");
                  return (
                    <span
                      key={o}
                      className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-xs text-[var(--dim)]"
                    >
                      {OFFER_LABELS[key] ?? o.trim()}
                      {o.includes("only") ? "（仅）" : ""}
                    </span>
                  );
                })}
              </p>
            </div>
            {r.website ? (
              <a
                href={r.website}
                target="_blank"
                rel="noreferrer"
                aria-label={`打开 ${r.name} 官网`}
                className="flex min-h-9 shrink-0 items-center rounded-full border border-[var(--border)] px-3 text-sm text-[var(--accent)]"
              >
                官网
              </a>
            ) : (
              <span className="shrink-0 text-xs text-[var(--dim)]">官网未取得</span>
            )}
          </li>
        ))}
      </ul>
      {filtered.length === 0 ? (
        <p className="py-4 text-sm text-[var(--dim)]">没有匹配的供应商。</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<Snapshot["source"], string> = {
  research: "旧研究基线",
  cdr: "CDR 实时数据",
  pdf: "PDF 基线（旧版，不再生成）",
};

// Auto-update interval options (user setting 2026-11-20, default
// weekly): days between scheduled CDR fetches. The daily server tick
// enforces it (see the autoRefresh action); 0 = off.
const AUTO_REFRESH_OPTIONS = [
  [0, "关闭"],
  [1, "每天"],
  [7, "每周"],
  [14, "每两周"],
  [30, "每月"],
] as const;
type AutoRefreshDays = (typeof AUTO_REFRESH_OPTIONS)[number][0];

function autoRefreshLabel(days: number): string {
  return (
    AUTO_REFRESH_OPTIONS.find(([d]) => d === days)?.[1] ?? `每 ${days} 天`
  );
}

export function App() {
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
    // The daily cron writes new snapshots server-side while this page may
    // already be open (or kept alive in the shell's webview). The shared
    // query client defaults to staleTime 30s and refetchOnWindowFocus:
    // false, which left an open page showing its first-load copy forever.
    // Opt this query into fresh-on-return behaviour so a scheduled check's
    // new data shows up on the page without a manual refresh.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  // Returning to the page (app switch, tab switch, webview resume) does
  // not reliably fire window focus inside the shell, so refetch on
  // visibilitychange too — that is the moment stale data would be seen.
  const dashboardRefetch = dashboard.refetch;
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === "visible") void dashboardRefetch();
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [dashboardRefetch]);

  // Auto-update interval: a global setting (default 每周）, applied the
  // moment the select changes — no save button, like the network
  // dropdowns. Local state mirrors the server value so the select
  // doesn't snap back while the save is in flight.
  const [autoRefreshDays, setAutoRefreshDays] = useState<number>(7);
  const [autoRefreshError, setAutoRefreshError] = useState<string | null>(null);
  const setAutoRefreshMut = useMutation({
    mutationFn: async (days: AutoRefreshDays) =>
      await api.setAutoRefresh({ days }),
    onSuccess: () => {
      setAutoRefreshError(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) =>
      setAutoRefreshError(
        e instanceof Error ? e.message : "自动更新设置保存失败，请重试。",
      ),
  });

  const [fuelTab, setFuelTab] = useState<"elec" | "gas">("elec");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // True while a dropped refresh request is being reconciled (see the
  // onError below): the button row shows a neutral "confirming" line
  // instead of a red error that may turn out to be false.
  const [refreshConfirming, setRefreshConfirming] = useState(false);
  // Id of the newest snapshot at the moment the user taps 立即刷新. A full
  // CDR refresh takes the better part of a minute, and on a mobile
  // connection the page's request often drops before the response comes
  // back — while the server-side run still finishes and stores the new
  // snapshot. When the call errors, this id tells whether the refresh
  // actually landed: if a newer snapshot exists, the outcome comes from
  // that stored snapshot, not from the dropped connection.
  const refreshBaselineIdRef = useRef(0);
  // Baseline of a refresh attempt whose failure message is currently on
  // screen; watched below so the message clears if that run's snapshot
  // still lands afterwards through the page's regular auto-sync.
  const failedBaselineRef = useRef<number | null>(null);
  // Set when a refresh's new snapshot is known to have landed (direct
  // success, or a dropped request reconciled by polling); drives the
  // progress bar's completion flash below.
  const refreshLandedRef = useRef(false);
  const confirmTimerRef = useRef<number | null>(null);
  const stopConfirming = () => {
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setRefreshConfirming(false);
  };
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current != null) {
        window.clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);
  const refresh = useMutation({
    mutationFn: async () => await api.refreshRates({}),
    onSuccess: () => {
      stopConfirming();
      failedBaselineRef.current = null;
      refreshLandedRef.current = true;
      setRefreshError(null);
      setRefreshNote(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    // Show the actual failure reason right next to the refresh button,
    // not a bare "try again later" — but only once the refresh really is
    // known not to have landed (see refreshBaselineIdRef above).
    onError: (e) => {
      const se = e as Error & { code?: unknown; status?: unknown };
      const message = e instanceof Error ? e.message : "";
      // The SDK reports a dropped / unconfirmable request with a generic
      // English sentence ("The app could not confirm the result…") or a
      // status-0 network error. That is NOT a failed refresh: the server
      // run usually finishes and stores its snapshot after the page's
      // connection is already gone. The previous version checked for the
      // new snapshot exactly once, at the moment the error arrived —
      // almost always before the ~40 s server run had finished — so it
      // fell through and painted that English sentence in red, where it
      // stayed even after the new data synced in. Now: poll the dashboard
      // until a newer snapshot lands (up to 2.5 minutes) and only report
      // failure if none ever does.
      const unconfirmed =
        message.includes("could not confirm") ||
        se.code === "action_outcome_unknown" ||
        se.status === 0;
      if (!unconfirmed) {
        setRefreshError(message ? `刷新失败：${message}` : "刷新失败，请稍后再试。");
        return;
      }
      setRefreshError(null);
      setRefreshNote(null);
      setRefreshConfirming(true);
      const baseline = refreshBaselineIdRef.current;
      const deadline = Date.now() + 150_000;
      const tick = async () => {
        confirmTimerRef.current = null;
        try {
          const fresh = await queryClient.fetchQuery({
            queryKey: ["dashboard"],
            queryFn: () => api.getDashboard({}),
          });
          const newest = fresh.snapshots[0];
          if (newest && newest.id > baseline) {
            stopConfirming();
            refreshLandedRef.current = true;
            setRefreshError(null);
            // A landed error/partial snapshot renders its own stored
            // reason next to the button; only a clean run gets the
            // "completed despite the drop" note.
            setRefreshNote(
              newest.status === "ok"
                ? "刷新已完成，数据已更新到最新（刚才连接中断，结果不受影响）。"
                : null,
            );
            return;
          }
        } catch {
          // Dashboard unreachable too — keep waiting until the deadline.
        }
        if (Date.now() < deadline) {
          confirmTimerRef.current = window.setTimeout(() => void tick(), 4000);
        } else {
          stopConfirming();
          failedBaselineRef.current = baseline;
          setRefreshError(
            "刷新失败：连接中断，等了 2 分半仍没有新数据返回，下方仍显示上一次成功的数据。请稍后再点一次刷新。",
          );
        }
      };
      void tick();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  // Safety net for the error message above: if a snapshot newer than the
  // failed attempt's baseline later arrives through the page's regular
  // auto-sync (the server run outlasted the confirmation window, or the
  // daily check landed), the red text is stale — clear it and let the
  // landed snapshot's own outcome show instead.
  const newestSnapshot = dashboard.data?.snapshots[0];
  useEffect(() => {
    if (
      failedBaselineRef.current != null &&
      newestSnapshot &&
      newestSnapshot.id > failedBaselineRef.current
    ) {
      failedBaselineRef.current = null;
      refreshLandedRef.current = true;
      setRefreshError(null);
      if (newestSnapshot.status === "ok") {
        setRefreshNote("刷新已完成，数据已更新到最新（刚才连接中断，结果不受影响）。");
      }
    }
  }, [newestSnapshot]);

  // Refresh progress bar (user request 2026-11-20: the long
  // 正在确认结果 text state becomes a progress bar). A refresh is a
  // single server call with no progress stream, so the bar is an
  // elapsed-time estimate: it eases toward ~90% while the request is
  // in flight, keeps creeping through the dropped-connection
  // confirmation window, and completes (100%, brief flash) only when
  // the new snapshot is known to have landed. A failed run just
  // dismisses the bar — the red reason beside the button says why.
  const refreshActive = refresh.isPending || refreshConfirming;
  const refreshStartRef = useRef<number | null>(null);
  const [refreshElapsedSec, setRefreshElapsedSec] = useState(0);
  const [refreshJustDone, setRefreshJustDone] = useState(false);
  useEffect(() => {
    if (refreshActive) {
      if (refreshStartRef.current == null) {
        refreshStartRef.current = Date.now();
      }
      setRefreshJustDone(false);
      const tick = () => {
        const start = refreshStartRef.current;
        setRefreshElapsedSec(
          start == null ? 0 : Math.floor((Date.now() - start) / 1000),
        );
      };
      tick();
      const t = window.setInterval(tick, 250);
      return () => window.clearInterval(t);
    }
    if (refreshStartRef.current != null) {
      refreshStartRef.current = null;
      setRefreshElapsedSec(0);
      if (refreshLandedRef.current) {
        refreshLandedRef.current = false;
        setRefreshJustDone(true);
        const t = window.setTimeout(() => setRefreshJustDone(false), 1800);
        return () => window.clearTimeout(t);
      }
    }
  }, [refreshActive]);
  const refreshProgressPct = refreshActive
    ? Math.min(97, 5 + 92 * (1 - Math.exp(-refreshElapsedSec / 14)))
    : 100;
  const showRefreshProgress = refreshActive || refreshJustDone;

  // Usage inputs are (re)loaded whenever the ACTIVE ADDRESS changes —
  // each address keeps its own inputs, mirrored into settings
  // server-side on switch. The model is the simplified one (2026-11-20):
  // three daily numbers + three equipment checkboxes.
  const [elecDailyInput, setElecDailyInput] = useState("");
  const [selfGenInput, setSelfGenInput] = useState("");
  const [gasDailyInput, setGasDailyInput] = useState("");
  const [hasSolarInput, setHasSolarInput] = useState(true);
  const [hasBatteryInput, setHasBatteryInput] = useState(false);
  const [hasEvInput, setHasEvInput] = useState(false);
  // Meter tariff type of the active address （单费率 / 分时）: decides
  // which variant of each plan family shows (see
  // filterElecPlansForHousehold). Synced per address like the
  // checkboxes, persisted via the same chained saveSettings.
  const [meterTypeInput, setMeterTypeInput] = useState<"single" | "tou">("tou");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const loadedAddressId = useRef<number | null>(null);

  const data = dashboard.data;
  useEffect(() => {
    if (data?.activeAddress && loadedAddressId.current !== data.activeAddress.id) {
      loadedAddressId.current = data.activeAddress.id;
      setElecDailyInput(String(data.settings.elecDailyKwh));
      setSelfGenInput(String(data.settings.selfGenDailyKwh));
      setGasDailyInput(String(data.settings.gasDailyMj));
      setHasSolarInput(data.settings.hasSolar);
      setHasBatteryInput(data.settings.hasBattery);
      setHasEvInput(data.settings.hasEv);
      setMeterTypeInput(data.settings.meterType);
      setSettingsError(null);
      const a = data.activeAddress;
      setAddressText(`${a.street}, ${a.suburb} ${a.state} ${a.postcode}`);
      setPendingSuggestion(null);
      setAddressDropdownOpen(false);
    }
  }, [data]);

  // The auto-update interval is global (not per-address), so it syncs
  // from the server value independently of the address-keyed effect
  // above.
  const serverAutoRefreshDays = data?.settings.autoRefreshDays;
  useEffect(() => {
    if (serverAutoRefreshDays != null) {
      setAutoRefreshDays(serverAutoRefreshDays);
    }
  }, [serverAutoRefreshDays]);

  // --- Address state: ONE input + dropdown (like retailer sites) ---
  const [addressText, setAddressText] = useState("");
  const [addressDropdownOpen, setAddressDropdownOpen] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] =
    useState<AddressSuggestion | null>(null);
  const [debouncedAddressQuery, setDebouncedAddressQuery] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressNote, setAddressNote] = useState<string | null>(null);
  // Split-postcode network pick: a dropdown (not one-tap buttons —
  // the user tapped the wrong button once and re-confirmed the
  // guessed network). It defaults to the address's stored network
  // with the other candidate(s) alongside, and — user request
  // 2026-11-20, superseding the same day's confirm-button design —
  // there is NO 「确认电网」/「改成…」 button: whichever network the
  // dropdown is set to IS the search condition, applied the moment
  // it is selected (see applyNetworkPick). The dropdown stays on the
  // page after confirmation so a wrong pick can still be fixed the
  // same way. Keyed by address id: switching addresses falls back to
  // that address's own stored network.
  const [elecPick, setElecPick] = useState<{
    addressId: number;
    distributorId: string;
  } | null>(null);
  // Street+postcode key of the address the auto-save effect last tried
  // to save, so a completed address is saved exactly once per distinct
  // value (cleared on failure so a later change can retry).
  const autoSaveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedAddressQuery(addressText.trim()),
      400,
    );
    return () => window.clearTimeout(t);
  }, [addressText]);

  const addressSearch = useQuery({
    queryKey: ["addressSearch", debouncedAddressQuery],
    queryFn: () => api.searchAddresses({ query: debouncedAddressQuery }),
    enabled: addressDropdownOpen && debouncedAddressQuery.length >= 3,
    // Short stale time: an empty result (a provider hiccup on one
    // attempt) must not stick to that query string for a whole minute
    // while the user re-types the same address.
    staleTime: 15_000,
    retry: false,
  });

  const saveSettings = useMutation({
    mutationFn: async (args: {
      elecDailyKwh: number;
      selfGenDailyKwh: number;
      gasDailyMj: number;
      hasSolar: boolean;
      hasBattery: boolean;
      hasEv: boolean;
      meterType: "single" | "tou";
    }) => await api.saveSettings(args),
    onSuccess: () => {
      // No refresh from here any more: the usage inputs drive the
      // rankings live from local state (no save needed), and this save
      // only persists the conditions — it runs automatically, chained
      // in front of a 立即刷新 tap when the inputs have changed.
      setSettingsError(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) =>
      setSettingsError(e instanceof Error ? e.message : "保存失败，请检查数值后重试。"),
  });

  // Saving an address from the single input happens automatically
  // once the input holds a complete address (see the auto-save effect
  // below — there is no save button). The server auto-detects the
  // distribution networks from the postcode (CDR coverage probe),
  // stores them with the address and makes it active, so the 自动配网
  // line under the input refreshes by itself. Plan data is NOT
  // refreshed here: that waits for the 立即刷新 button, which stays
  // disabled until every condition is ready.
  const saveAddress = useMutation({
    mutationFn: async (args: {
      street: string;
      suburb: string;
      postcode: string;
      state: string;
    }) => await api.saveAddress(args),
    onSuccess: (res) => {
      setAddressError(null);
      setPendingSuggestion(null);
      setAddressDropdownOpen(false);
      setAddressNote(
        res.elecAmbiguous
          ? `地址已自动保存，但这个邮编有两个电网都覆盖、覆盖数很接近，按邮编分不出是哪一个（先按 ${res.elecLabel} 算）。请在下方按电费账单上的配电商，在下拉框里选真正的电网——选到哪个就按哪个查，选错电网，每家价格都会和零售商官网按地址查到的不一样。`
          : res.detected
            ? `地址已自动保存。自动配网：电 ${res.elecLabel} · 气 ${res.gasLabel}${res.gasZone ? `（${res.gasZone} 区）` : ""}。条件都齐了，点下方「立即刷新」按新地址拉取数据。`
            : "地址已自动保存，但按邮编没查到这个地址的套餐覆盖，配电网先沿用上一个地址的。条件都齐了，点下方「立即刷新」拉取数据。",
      );
      loadedAddressId.current = null;
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => {
      autoSaveKeyRef.current = null;
      setAddressError(e instanceof Error ? e.message : "保存地址失败，请检查后重试。");
    },
  });

  const switchAddress = useMutation({
    mutationFn: async (addressId: number) => await api.switchAddress({ addressId }),
    onSuccess: () => {
      setAddressError(null);
      loadedAddressId.current = null;
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      // No automatic refresh on switch either: if the address has no
      // data yet, the page shows its empty state and the (now enabled)
      // 立即刷新 button fetches it.
    },
    onError: (e) =>
      setAddressError(e instanceof Error ? e.message : "切换地址失败，请重试。"),
  });

  // Split-postcode network application (2026-11-20): when the
  // postcode probe found two electricity networks with close
  // coverage, the stored network is only a guess. The dropdown's
  // selection is applied through this mutation the moment it
  // changes — no confirm button (user request: 选择框选到哪个就作为
  // 搜索的条件）. Picking a different network deletes the address's
  // wrong-network snapshots server-side.
  const confirmNetworks = useMutation({
    mutationFn: async (args: { addressId: number; elecDistributorId: string }) =>
      await api.confirmAddressNetworks({
        addressId: args.addressId,
        elecDistributorId: args.elecDistributorId as
          | "ausnet"
          | "jemena"
          | "powercor"
          | "citipower"
          | "united-energy",
      }),
    onSuccess: (res) => {
      setAddressError(null);
      // The pick is now the stored network; drop the in-flight pick
      // so the dropdown reads straight from the address again.
      setElecPick(null);
      setAddressNote(
        res.networkChanged
          ? `电网已改成 ${res.address.elecDistributorLabel}。这个地址之前按另一个电网抓的套餐数据已经清掉，点下方「立即刷新」按 ${res.address.elecDistributorLabel} 重新拉取。`
          : `电网已确认是 ${res.address.elecDistributorLabel}，和之前自动判断的一致，现有数据不用重抓。`,
      );
      loadedAddressId.current = null;
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) =>
      setAddressError(e instanceof Error ? e.message : "切换电网失败，请重试。"),
  });

  // The network dropdown's change handler: record the pick AND apply
  // it immediately — the selected network becomes the search
  // condition at once, with no second tap. Re-selecting the network
  // already in force (or one already being applied) does nothing.
  const applyNetworkPick = (distributorId: string) => {
    if (!data?.activeAddress) return;
    const active = data.activeAddress;
    setElecPick({ addressId: active.id, distributorId });
    if (
      distributorId !== active.elecDistributorId &&
      !confirmNetworks.isPending
    ) {
      confirmNetworks.mutate({
        addressId: active.id,
        elecDistributorId: distributorId,
      });
    }
  };

  const selectSavedAddress = (a: Address) => {
    setAddressText(`${a.street}, ${a.suburb} ${a.state} ${a.postcode}`);
    setPendingSuggestion(null);
    setAddressDropdownOpen(false);
    setAddressNote(null);
    if (a.id !== data?.activeAddress?.id) switchAddress.mutate(a.id);
  };

  const selectSuggestion = (s: AddressSuggestion) => {
    setAddressText(s.display);
    setPendingSuggestion(s);
    setAddressDropdownOpen(false);
    setAddressNote(null);
  };

  // Latest saveAddress entry points, read through refs so the
  // auto-save effect below does not re-run on every render.
  const saveAddressMutateRef = useRef(saveAddress.mutate);
  saveAddressMutateRef.current = saveAddress.mutate;
  const saveAddressPendingRef = useRef(saveAddress.isPending);
  saveAddressPendingRef.current = saveAddress.isPending;

  // No 「保存地址」 button (user request 2026-11-20): once the input
  // holds a complete address that is not the active one — picked from
  // the dropdown or typed in full — it is saved automatically after a
  // short pause. Saving re-runs the CDR postcode probe server-side, so
  // the 自动配网 line under the input refreshes on its own.
  useEffect(() => {
    if (!data) return;
    const text = addressText.trim();
    const fields =
      pendingSuggestion && pendingSuggestion.display === text
        ? {
            street: pendingSuggestion.street,
            suburb: pendingSuggestion.suburb,
            postcode: pendingSuggestion.postcode,
            state: pendingSuggestion.state,
          }
        : parseAddressText(text);
    if (!fields) return;
    const key = `${fields.street.toLowerCase()}|${fields.postcode}`;
    const activeKey = data.activeAddress
      ? `${data.activeAddress.street.toLowerCase()}|${data.activeAddress.postcode}`
      : "";
    if (key === activeKey) {
      autoSaveKeyRef.current = key;
      return;
    }
    if (autoSaveKeyRef.current === key || saveAddressPendingRef.current) return;
    const t = window.setTimeout(() => {
      autoSaveKeyRef.current = key;
      setAddressError(null);
      setAddressNote(null);
      saveAddressMutateRef.current(fields);
    }, 900);
    return () => window.clearTimeout(t);
  }, [addressText, pendingSuggestion, data]);


  if (dashboard.isPending) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="px-4 py-16 text-center text-sm text-[var(--dim)]">
          正在加载电费气费数据…
        </main>
      </div>
    );
  }
  if (dashboard.error || !data) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="px-4 py-16 text-center">
          <p className="text-sm text-[var(--danger)]">数据加载失败。</p>
          <button
            type="button"
            onClick={() => void dashboard.refetch()}
            className="mt-4 min-h-10 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-white"
          >
            重新加载
          </button>
        </main>
      </div>
    );
  }

  const { settings, snapshots, reference } = data;

  // Live usage basis (user request 2026-11-20): there is no 「保存用量」
  // button and the usage inputs do NOT need saving to act as the
  // filter/pricing conditions below — the rankings re-price straight
  // from the local input state, deriving the annual profile with the
  // same VDO split the server uses (peak 29% / flat 53% / shoulder
  // 18%; self-generation counts only with 太阳能 or 电池 ticked). The
  // inputs are persisted only when 立即刷新 is tapped (chained save),
  // so the server-side extraction sees the same checkboxes.
  const elecDailyNum = Number(elecDailyInput);
  const selfGenNum = Number(selfGenInput);
  const gasNum = Number(gasDailyInput);
  const elecDailyValid =
    elecDailyInput.trim() !== "" &&
    Number.isFinite(elecDailyNum) &&
    elecDailyNum >= 0.1 &&
    elecDailyNum <= 500;
  const selfGenValid =
    selfGenInput.trim() !== "" &&
    Number.isFinite(selfGenNum) &&
    selfGenNum >= 0 &&
    selfGenNum <= 500;
  const gasValid =
    gasDailyInput.trim() !== "" &&
    Number.isFinite(gasNum) &&
    gasNum >= 0 &&
    gasNum <= 5000;
  const usageValid = elecDailyValid && selfGenValid && gasValid;
  const usageError = !elecDailyValid
    ? "电日均用量请填 0.1 – 500 之间的数字（kWh/天）。"
    : !selfGenValid
      ? "自发电量请填 0 – 500 之间的数字（kWh/天）。"
      : !gasValid
        ? "气日均用量请填 0 – 5,000 之间的数字（MJ/天），不用气就填 0。"
        : null;
  const effElecKwh = Math.round(elecDailyNum * 365);
  const effPeak = Math.round(effElecKwh * 0.29);
  const effShoulder = Math.round(effElecKwh * 0.18);
  const effectiveSettings: Settings = usageValid
    ? {
        ...settings,
        elecDailyKwh: elecDailyNum,
        selfGenDailyKwh: selfGenNum,
        gasDailyMj: gasNum,
        hasSolar: hasSolarInput,
        hasBattery: hasBatteryInput,
        hasEv: hasEvInput,
        meterType: meterTypeInput,
        elecKwh: effElecKwh,
        elecPeakKwh: effPeak,
        elecShoulderKwh: effShoulder,
        elecFlatKwh: effElecKwh - effPeak - effShoulder,
        solarExportKwh:
          hasSolarInput || hasBatteryInput ? Math.round(selfGenNum * 365) : 0,
        gasMj: Math.round(gasNum * 365),
      }
    : settings;
  // Each fuel displays its own newest data-bearing snapshot: a partial
  // refresh that returned no gas plans must not blank out the gas view —
  // the previous gas data stays on screen, marked 更新失败 for that run.
  const elecDisplay = snapshots.find((s) => s.elecPlans.length > 0);
  const gasDisplay = snapshots.find((s) => s.gasPlans.length > 0);
  const display = elecDisplay ?? gasDisplay;
  const latest = snapshots[0];
  const previousElec = elecDisplay
    ? snapshots.find((s) => s.id < elecDisplay.id && s.elecPlans.length > 0)
    : undefined;
  const previousGas = gasDisplay
    ? snapshots.find((s) => s.id < gasDisplay.id && s.gasPlans.length > 0)
    : undefined;

  // Display-side conditions filter (user request 2026-11-20): stored
  // snapshots carry ALL of the address's electricity plans — battery,
  // EV and solar variants included, fetched once per address — and
  // which of them show follows the CURRENT conditions: the equipment
  // checkboxes (see planAppliesToHousehold) and the meter type, which
  // picks the single-rate or time-of-use variant of each plan family
  // (see filterElecPlansForHousehold). Toggling any of them therefore
  // re-displays the already-fetched data (best plan, hero, ranking,
  // per-plan statuses) with no re-fetch; only an address change
  // fetches new data.
  const elecPlansShown = elecDisplay
    ? filterElecPlansForHousehold(elecDisplay.elecPlans, effectiveSettings)
    : [];
  const prevElecPlansShown = previousElec
    ? filterElecPlansForHousehold(previousElec.elecPlans, effectiveSettings)
    : undefined;

  const elecBest = elecDisplay
    ? cheapestCost(elecPlansShown, "elec", effectiveSettings, elecDisplay)
    : null;
  const gasBest = gasDisplay
    ? cheapestCost(gasDisplay.gasPlans, "gas", effectiveSettings, gasDisplay)
    : null;
  const elecBestPlan = elecDisplay
    ? bestPlan(elecPlansShown, "elec", effectiveSettings, elecDisplay)
    : undefined;
  const gasBestPlan = gasDisplay
    ? bestPlan(gasDisplay.gasPlans, "gas", effectiveSettings, gasDisplay)
    : undefined;
  const prevElecBest = previousElec
    ? cheapestCost(prevElecPlansShown ?? [], "elec", effectiveSettings, previousElec)
    : null;
  const prevGasBest = previousGas
    ? cheapestCost(previousGas.gasPlans, "gas", effectiveSettings, previousGas)
    : null;
  const comboBest = elecBest != null && gasBest != null ? elecBest + gasBest : null;
  const comboSaving =
    comboBest != null && reference.current.netTotalAnnual != null
      ? reference.current.netTotalAnnual - comboBest
      : null;
  // No address saved yet: the page still renders (address input, usage
  // inputs, disabled refresh) against an empty placeholder, so the user
  // can add their first address. Everything that needs a real address
  // is gated by `hasActiveAddress` or by the refresh-readiness checks.
  const EMPTY_ADDRESS: Address = {
    id: 0,
    label: "",
    street: "",
    suburb: "",
    postcode: "",
    state: "VIC",
    elecDistributorId: "ausnet",
    elecDistributorLabel: "",
    elecCandidates: [],
    networksConfirmed: false,
    gasDistributorId: "none",
    gasDistributorLabel: "",
    gasZone: "",
    currentElecNetAnnual: null,
    currentGasAnnual: null,
    currentElecNote: "",
    currentGasNote: "",
    hasData: false,
  };
  const hasActiveAddress = data.activeAddress != null;
  const activeAddress = data.activeAddress ?? EMPTY_ADDRESS;
  const vdo = reference.vdo;

  // Address dropdown contents: the saved addresses matching what's
  // typed, plus web address suggestions (excluding ones already saved).
  const addressQuery = addressText.trim().toLowerCase();
  const savedMatches = data.addresses.filter((a) => {
    if (!addressQuery) return true;
    const full = normalizeAddressText(
      `${a.street} ${a.suburb} ${a.state} ${a.postcode}`,
    );
    const q = normalizeAddressText(addressQuery);
    if (full.includes(q) || addressQuery.includes(a.postcode)) return true;
    // Token-wise fallback: every word the user typed appears somewhere
    // in the saved address (covers partial suburb names like "North").
    const qTokens = q.split(" ").filter(Boolean);
    return (
      qTokens.length > 0 && qTokens.every((t) => full.includes(t))
    );
  });
  const webSuggestions = (addressSearch.data?.suggestions ?? []).filter(
    (s) =>
      !data.addresses.some(
        (a) =>
          a.street.toLowerCase() === s.street.toLowerCase() &&
          a.postcode === s.postcode,
      ),
  );
  const showAddressDropdown =
    addressDropdownOpen &&
    (savedMatches.length > 0 || webSuggestions.length > 0);

  // Per-fuel outcome of the latest refresh (auto or manual), judged from
  // the newest snapshot row — that row IS the last refresh attempt:
  //   - an error row → both fuels failed;
  //   - a CDR row that returned no plans for a fuel → that fuel failed
  //     (its screen still shows the previous data, marked failed);
  //   - otherwise the row's server-computed changed flag decides
  //     有更新 / 没有更新.
  // Baseline snapshots (PDF / research) predate any refresh → no status.
  const fuelRefreshStatus = (kind: "elec" | "gas"): RefreshStatus | null => {
    if (!latest) return null;
    if (latest.status === "error") return "failed";
    if (latest.source !== "cdr") return null;
    const plans = kind === "elec" ? latest.elecPlans : latest.gasPlans;
    if (plans.length === 0) return "failed";
    const changed = kind === "elec" ? latest.elecChanged : latest.gasChanged;
    if (changed == null) return null;
    return changed ? "updated" : "unchanged";
  };
  const elecStatus = fuelRefreshStatus("elec");
  const gasStatus = fuelRefreshStatus("gas");
  // The combo spans both fuels: failed if either fuel failed, updated if
  // either updated, otherwise unchanged (null until both have an outcome).
  const comboStatus: RefreshStatus | null =
    elecStatus == null || gasStatus == null
      ? null
      : elecStatus === "failed" || gasStatus === "failed"
        ? "failed"
        : elecStatus === "updated" || gasStatus === "updated"
          ? "updated"
          : "unchanged";

  // Per-plan statuses for the ranking rows, per fuel: shown once that
  // fuel has a refresh outcome; a fuel whose latest refresh failed marks
  // every (stale) row 更新失败. When the displayed snapshot IS the latest
  // refresh, its carried-over retailers (brands that failed that run but
  // whose previous plans are still shown) are marked failed per row.
  const elecPlanStatuses =
    elecDisplay && elecStatus != null
      ? buildPlanStatuses(
          elecPlansShown,
          prevElecPlansShown,
          elecStatus === "failed",
          elecDisplay.id === latest?.id
            ? new Set(elecDisplay.carriedOver.elec)
            : undefined,
        )
      : null;
  const gasPlanStatuses =
    gasDisplay && gasStatus != null
      ? buildPlanStatuses(
          gasDisplay.gasPlans,
          previousGas?.gasPlans,
          gasStatus === "failed",
          gasDisplay.id === latest?.id
            ? new Set(gasDisplay.carriedOver.gas)
            : undefined,
        )
      : null;

  // Refresh gating (user request 2026-11-20): 立即刷新 stays greyed
  // out until every condition is ready — the address in the input is
  // complete AND its auto-detected networks are fully on file (the
  // input matches the saved active address, whose record carries the
  // detected 电网/气网）, and all three usage numbers are valid.
  const parsedInputAddress =
    pendingSuggestion && pendingSuggestion.display === addressText.trim()
      ? {
          street: pendingSuggestion.street,
          suburb: pendingSuggestion.suburb,
          postcode: pendingSuggestion.postcode,
          state: pendingSuggestion.state,
        }
      : parseAddressText(addressText);
  const inputMatchesActive =
    parsedInputAddress != null &&
    parsedInputAddress.street.toLowerCase() ===
      activeAddress.street.toLowerCase() &&
    parsedInputAddress.postcode === activeAddress.postcode;
  const networksComplete =
    activeAddress.elecDistributorLabel.trim() !== "" &&
    (activeAddress.gasDistributorId === "none" ||
      activeAddress.gasDistributorLabel.trim() !== "");
  // Split postcode (2026-11-20): the probe found two electricity
  // networks with close coverage for this postcode, so the stored
  // network is an unconfirmed guess. The 自动配网 line must not
  // present the guess as fact, and the warning box below stays until
  // the network is settled. But 立即刷新 is NOT blocked by it any
  // more: the dropdown's current selection is the search condition
  // (user request — no confirm button), so tapping 立即刷新 first
  // settles the network to whatever the dropdown shows (see
  // onRefreshClick) and only then fetches.
  const elecAmbiguous =
    !activeAddress.networksConfirmed &&
    activeAddress.elecCandidates.length >= 2;
  const elecNetworkText = elecAmbiguous
    ? `未确认（${activeAddress.elecCandidates.map((c) => c.label).join(" / ")} 都覆盖这个邮编）`
    : activeAddress.elecDistributorLabel;
  const gasNetworkText =
    activeAddress.gasDistributorId === "none"
      ? "无燃气"
      : `${activeAddress.gasDistributorLabel}${activeAddress.gasZone ? `（${activeAddress.gasZone} 区）` : ""}`;
  // The network dropdown's current value: the user's in-flight pick
  // for this address, or — by default — the network stored on the
  // address (the auto-guess while unconfirmed, the confirmed network
  // afterwards), so the other candidate is always one tap away in
  // the same dropdown.
  const elecPickValue =
    elecPick && elecPick.addressId === activeAddress.id
      ? elecPick.distributorId
      : activeAddress.elecDistributorId;
  const elecPickLabel =
    activeAddress.elecCandidates.find((c) => c.id === elecPickValue)?.label ??
    activeAddress.elecDistributorLabel;
  // The dropdown's selection IS the search condition (user request
  // 2026-11-20: no 「改成」/「确认电网」 button). Changing it applies
  // immediately via applyNetworkPick, so a differing pick is only
  // ever in flight for the moment the apply call takes. The one case
  // a refresh still has to settle first is an UNCONFIRMED address
  // whose dropdown was never touched: the shown pick (the auto
  // guess) then becomes the condition when 立即刷新 is tapped (see
  // onRefreshClick). Both cases are covered by elecNeedsSettle.
  const elecPickPending =
    activeAddress.elecCandidates.length >= 2 &&
    elecPickValue !== activeAddress.elecDistributorId;
  const elecNeedsSettle =
    activeAddress.elecCandidates.length >= 2 &&
    (elecPickPending || !activeAddress.networksConfirmed);
  const addressReady =
    inputMatchesActive &&
    networksComplete &&
    !saveAddress.isPending &&
    !switchAddress.isPending &&
    !confirmNetworks.isPending;
  const refreshReady = addressReady && usageValid;
  const missingReasons: string[] = [];
  if (!parsedInputAddress) {
    missingReasons.push("地址还没填完整（街道、suburb 和 4 位邮编都要有）");
  } else if (saveAddress.isPending || switchAddress.isPending) {
    missingReasons.push("正在自动判断配网，等下方配网信息刷新出来");
  } else if (!inputMatchesActive) {
    missingReasons.push("新地址还没保存成功（看上方地址处的提示）");
  } else if (!networksComplete) {
    missingReasons.push("自动配网信息不全（电网或气网还没判出来）");
  }
  // Address dropdown feedback: an address one geocoder ranks low was
  // "not found" in the dropdown): while a
  // search is running, or when it comes back with nothing, the
  // dropdown now shows a status line instead of simply not appearing —
  // a silently absent dropdown reads as "没找到" even when the search
  // is still in flight or one provider hiccuped. Only for a query that
  // is not the active address (the active one needs no suggestions).
  const addressQueryCurrent = debouncedAddressQuery === addressText.trim();
  const addressSearching =
    addressQueryCurrent &&
    addressSearch.isFetching &&
    webSuggestions.length === 0 &&
    savedMatches.length === 0;
  const addressNoResults =
    addressQueryCurrent &&
    addressSearch.isSuccess &&
    webSuggestions.length === 0 &&
    savedMatches.length === 0;
  const showAddressStatus =
    addressDropdownOpen &&
    !inputMatchesActive &&
    addressText.trim().length >= 3 &&
    (addressSearching || addressNoResults);
  const showAddressPanel = showAddressDropdown || showAddressStatus;
  if (!usageValid) {
    missingReasons.push("用量还没填对（三个日均数都要填有效数字）");
  }

  const settingsDirty =
    usageValid &&
    (elecDailyNum !== settings.elecDailyKwh ||
      selfGenNum !== settings.selfGenDailyKwh ||
      gasNum !== settings.gasDailyMj ||
      hasSolarInput !== settings.hasSolar ||
      hasBatteryInput !== settings.hasBattery ||
      hasEvInput !== settings.hasEv ||
      meterTypeInput !== settings.meterType);

  // Conditions-only change (user request 2026-11-20): a refresh
  // fetches ALL of the active address's data — every applicable plan,
  // battery / EV variants included — and stores it. After that, ANY
  // condition change (the three daily numbers AND all three equipment
  // checkboxes) only changes how the already-fetched plans are priced
  // and filtered for display: every stored plan carries its full rate
  // steps, the page re-prices locally, and battery / EV plans are
  // shown or hidden by the checkboxes client-side. So when the
  // conditions are the only things that changed, tapping 立即刷新
  // must NOT re-fetch the CDR source; persisting the inputs is enough
  // and the display below is already showing the re-computed result.
  // A real fetch runs when nothing changed (the user is asking for
  // fresh prices) or when the address has no stored data yet — which
  // is what an address change leads to.
  const hasExistingData = elecDisplay != null || gasDisplay != null;
  const conditionsOnlyChange = settingsDirty && hasExistingData;

  // Tapping 立即刷新 first persists the current usage inputs when
  // they differ from the saved ones. When only conditions changed,
  // that save IS the whole refresh (see conditionsOnlyChange above)
  // and no CDR fetch runs; otherwise the refresh runs after the save —
  // the user never presses a separate save button.
  const onRefreshClick = async () => {
    stopConfirming();
    failedBaselineRef.current = null;
    refreshLandedRef.current = false;
    setRefreshError(null);
    setRefreshNote(null);
    refreshBaselineIdRef.current = latest?.id ?? 0;
    // The dropdown's selection is the search condition: settle it
    // BEFORE anything else whenever it is not yet in force — a pick
    // whose immediate apply is still in flight, or an unconfirmed
    // address whose dropdown still shows the auto-guess (the user
    // never had to touch it; what's shown is what counts). Without
    // this, the refresh below could re-fetch under the old network
    // and the user would see the same rates again — the exact
    // "还是费率不一样" trap. Settling a different network deletes
    // the address's wrong-network snapshots server-side, so that
    // path always ends in a full fetch (never the conditions-only
    // shortcut).
    let networkApplied = false;
    if (elecNeedsSettle) {
      try {
        const res = await confirmNetworks.mutateAsync({
          addressId: activeAddress.id,
          elecDistributorId: elecPickValue,
        });
        networkApplied = res.networkChanged;
        if (networkApplied) {
          setAddressNote(
            `电网已改成 ${res.address.elecDistributorLabel}，正在按这个电网重新拉取数据…`,
          );
        }
      } catch {
        // confirmNetworks' onError already shows the reason by the
        // address block; don't refresh under the old network.
        return;
      }
    }
    if (settingsDirty) {
      try {
        await saveSettings.mutateAsync({
          elecDailyKwh: elecDailyNum,
          selfGenDailyKwh: selfGenNum,
          gasDailyMj: gasNum,
          hasSolar: hasSolarInput,
          hasBattery: hasBatteryInput,
          hasEv: hasEvInput,
          meterType: meterTypeInput,
        });
      } catch {
        // saveSettings' onError already shows the reason by the usage
        // inputs; don't start a refresh on stale conditions.
        return;
      }
      if (conditionsOnlyChange && !networkApplied) {
        setRefreshNote(
          "这次只改了条件（用量 / 勾选 / 电表类型）：新设置已保存，下面的排名已按新条件用这个地址已抓到的套餐数据重新显示，没有重新抓取数据源。只有换地址才会重新抓取。",
        );
        return;
      }
    }
    refresh.mutate();
  };

  const inputCls =
    "mt-1 min-h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-base tabular-nums text-[var(--text)]";

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-5">
        {/* ============ 输入区（最前面）：地址 + 用量 + 刷新 ============ */}
        <section
          aria-label="地址与用量设置"
          className="mt-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
        >
          <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3">
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
              我的地址与用量
            </h2>
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              页面所有数据都按这里的地址和用量算。换地址后，排名、走势和刷新都会换成新地址的数据。
            </p>
          </div>

          <div className="px-4 py-4">
            {/* Address — ONE input + dropdown, like retailer quote sites */}
            <p className="text-sm font-medium text-[var(--text)]">地址</p>
            <div className="relative mt-2">
              <input
                id="address-input"
                aria-label="地址"
                type="text"
                autoComplete="off"
                name="query" minLength={3} maxLength={120} required
                value={addressText}
                onChange={(e) => {
                  setAddressText(e.target.value);
                  setPendingSuggestion(null);
                  setAddressDropdownOpen(true);
                  setAddressNote(null);
                }}
                onFocus={() => setAddressDropdownOpen(true)}
                onBlur={() =>
                  window.setTimeout(() => setAddressDropdownOpen(false), 200)
                }
                placeholder="输入地址，例如 12 Smith St, Melbourne VIC 3000"
                className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 pr-12 text-base text-[var(--text)]"
              />
              {addressText.length > 0 ? (
                <button
                  type="button"
                  aria-label="清空地址输入"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setAddressText("");
                    setPendingSuggestion(null);
                    setAddressNote(null);
                    setAddressError(null);
                    document.getElementById("address-input")?.focus();
                  }}
                  className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-3xl leading-none text-[var(--dim)] hover:bg-[var(--surface-alt)] hover:text-[var(--text)]"
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
              {showAddressPanel ? (
                <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg">
                  {savedMatches.map((a) => (
                    <li key={`saved-${a.id}`}>
                      <button
                        type="button"
                        aria-label={`选择已保存地址 ${a.street}，${a.suburb} ${a.postcode}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSavedAddress(a);
                        }}
                        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-alt)]"
                      >
                        <span aria-hidden="true">📍</span>
                        <span className="min-w-0 flex-1 truncate">
                          {a.street}，{a.suburb} {a.state} {a.postcode}
                        </span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          已保存{a.id === activeAddress.id ? " · 当前" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                  {webSuggestions.map((s) => (
                    <li key={`web-${s.display}`}>
                      <button
                        type="button"
                        aria-label={`选择地址 ${s.display}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSuggestion(s);
                        }}
                        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-alt)]"
                      >
                        <span aria-hidden="true">🔍</span>
                        <span className="min-w-0 flex-1 truncate">{s.display}</span>
                      </button>
                    </li>
                  ))}
                  {showAddressStatus && addressSearching ? (
                    <li className="px-3 py-2.5 text-sm text-[var(--dim)]">
                      正在搜索这个地址…
                    </li>
                  ) : null}
                  {showAddressStatus && addressNoResults ? (
                    <li className="px-3 py-2.5 text-sm text-[var(--dim)]">
                      下拉里暂时没搜到这个地址。不用管下拉，把完整地址直接打完（街道，区名
                      VIC 邮编），工具会自动保存并判断配网。
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {saveAddress.isPending ? (
                <span className="text-sm font-medium text-[var(--dim)]">
                  正在自动保存地址并判断配电网…
                </span>
              ) : parsedInputAddress && !inputMatchesActive ? (
                <span className="text-sm font-medium text-[var(--dim)]">
                  地址已填完，正在自动判断配网…
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-[var(--dim)]">
              输入时下拉会列出已保存的地址和地址建议（地址库同时查 OpenStreetMap 的 Nominatim 和 Photon 两个地理编码服务，结果合并去重后显示，一个查不到另一个也能补上）。输入框右边的大 × 点一下就能一次清空，不用逐字删。选好或把地址填完整后不用点任何按钮：工具会自动保存，并按邮编判断这个地址的电网和气网（自动配网），判断结果会刷新显示在下面一行；如果这个邮编被两个电网同时覆盖、分不出是哪一个，下面会让你按电费账单在下拉框里选真正的电网——没有确认按钮，下拉框选到哪个就按哪个查，选好立刻生效，选错了随时再改选。数据本身要等条件都齐了，点下方「立即刷新」才拉取。
            </p>
            {!hasActiveAddress && !parsedInputAddress ? (
              <p className="mt-1.5 text-sm text-[var(--text)]">
                还没有保存地址：在上方输入你的维州地址并填完整，工具会自动保存并判断配网，然后点下方「立即刷新」抓取套餐。
              </p>
            ) : inputMatchesActive ? (
              <p className="mt-1.5 text-sm text-[var(--text)]">
                当前地址：{activeAddress.street}，{activeAddress.suburb}{" "}
                {activeAddress.state} {activeAddress.postcode}
                <span className="text-[var(--dim)]">
                  {" "}· 自动配网：电 {elecNetworkText} · 气{" "}
                  {gasNetworkText}
                </span>
              </p>
            ) : parsedInputAddress ? (
              <p className="mt-1.5 text-sm text-[var(--text)]">
                已填地址：{addressText.trim()}
                <span className="text-[var(--dim)]">
                  {" "}· 自动配网：
                  {saveAddress.isPending
                    ? "正在判断，马上刷新显示…"
                    : "马上自动判断，结果会刷新显示在这里"}
                </span>
              </p>
            ) : (
              <p className="mt-1.5 text-sm text-[var(--text)]">
                当前地址：{activeAddress.street}，{activeAddress.suburb}{" "}
                {activeAddress.state} {activeAddress.postcode}
                <span className="text-[var(--dim)]">
                  {" "}· 自动配网：电 {elecNetworkText} · 气{" "}
                  {gasNetworkText}
                  （在上方把新地址填完整，这里的配网信息会自动更新）
                </span>
              </p>
            )}
            {addressError ? (
              <p role="alert" className="mt-2 text-sm font-medium text-[var(--danger)]">
                {addressError}
              </p>
            ) : null}
            {addressNote ? (
              <p className="mt-2 text-sm font-medium text-[var(--accent)]">{addressNote}</p>
            ) : null}
            {elecAmbiguous ? (
              <div className="mt-3 rounded-[var(--radius)] border border-[var(--gas)] bg-[var(--gas-soft)] p-3">
                <p className="text-sm font-medium text-[var(--text)]">
                  这个地址的电网要你确认一下
                </p>
                <p className="mt-1 text-sm text-[var(--text)]">
                  邮编 {activeAddress.postcode} 被两个电网同时覆盖，覆盖套餐数很接近（
                  {activeAddress.elecCandidates
                    .map((c) => `${c.label} 约 ${c.planCount} 个`)
                    .join("、")}
                  ），按邮编分不出这户到底是哪一个。1st Energy
                  这类零售商官网是按地址本身定电网的，电网选错，每家价格都会和官网查到的不一样。请按电费账单上的配电商（distributor）在下拉框里选——没有确认按钮，选到哪个就按哪个查：
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="elec-network-pick"
                    className="text-sm font-medium text-[var(--text)]"
                  >
                    我家电网是
                  </label>
                  <select
                    id="elec-network-pick"
                    aria-label="我家电网是"
                    value={elecPickValue}
                    disabled={confirmNetworks.isPending}
                    onChange={(e) => applyNetworkPick(e.target.value)}
                    className="min-h-11 max-w-full rounded-[var(--radius)] border border-[var(--gas)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] disabled:opacity-50"
                  >
                    {activeAddress.elecCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                        {c.id === activeAddress.elecDistributorId
                          ? "（现在按这个算，是自动猜的）"
                          : ""}
                      </option>
                    ))}
                  </select>
                  {confirmNetworks.isPending ? (
                    <span className="text-sm text-[var(--dim)]">
                      正在按选的电网切换…
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-[var(--dim)]">
                  下拉框默认就是现在暂定的这个，另一个也在里面。选到另一个电网立刻生效：这个地址之前按猜的电网抓的数据会清掉，再点「立即刷新」按新电网重新拉。不动下拉框直接点「立即刷新」也可以——那就按下拉框当前选的这个（自动猜的）定下来再拉数据。之后发现选错了，地址下面还有同一个下拉框，改选另一个立刻生效。
                </p>
              </div>
            ) : null}
            {!elecAmbiguous && activeAddress.elecCandidates.length >= 2 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label
                  htmlFor="elec-network-change"
                  className="text-sm text-[var(--dim)]"
                >
                  电网（邮编 {activeAddress.postcode} 两个网都覆盖，当前{" "}
                  {activeAddress.elecDistributorLabel}）：
                </label>
                <select
                  id="elec-network-change"
                  aria-label="更改电网"
                  value={elecPickValue}
                  disabled={confirmNetworks.isPending}
                  onChange={(e) => applyNetworkPick(e.target.value)}
                  className="min-h-11 max-w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
                >
                  {activeAddress.elecCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.id === activeAddress.elecDistributorId ? "（当前）" : ""}
                    </option>
                  ))}
                </select>
                {confirmNetworks.isPending ? (
                  <span className="text-sm text-[var(--dim)]">
                    正在按选的电网切换…
                  </span>
                ) : null}
                <span className="text-xs text-[var(--dim)]">
                  下拉框选到哪个就按哪个查，没有确认按钮：改选另一个电网立刻生效，会清掉这个地址按旧电网抓的数据，再点「立即刷新」按新电网重新拉。
                </span>
              </div>
            ) : null}

            {/* Equipment checkboxes + three daily usage inputs */}
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <p className="text-sm font-medium text-[var(--text)]">
                我的设备与用量（当前地址）
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(
                  [
                    ["太阳能", hasSolarInput, setHasSolarInput],
                    ["电池", hasBatteryInput, setHasBatteryInput],
                    ["电车", hasEvInput, setHasEvInput],
                  ] as const
                ).map(([label, checked, setChecked]) => (
                  <label
                    key={label}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                      checked
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--text)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`有${label}`}
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                      className="h-5 w-5 shrink-0 accent-[#0b5a4a]"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-sm text-[var(--text)]">电表类型</span>
                {(
                  [
                    ["single", "单费率"],
                    ["tou", "分时（峰 / 平 / 肩）"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={meterTypeInput === value}
                    onClick={() => setMeterTypeInput(value)}
                    className={`min-h-11 rounded-full border px-4 text-sm ${
                      meterTypeInput === value
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--text)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                勾选决定哪些套餐算得上：没勾太阳能，太阳能专用套餐（名字带 Solar、或适用条件要求装太阳能系统的）不进排名；没勾电池，电池专用套餐不进排名；没勾电车，电车套餐不进排名；名字里带多项设备的（如 Battery + Solar）要都勾上才进排名。自发电量是太阳能发的电，也可以是电池放的电——勾了太阳能或电池，它就按各套餐的回购价算进年费；两个都没勾，自发电按 0 计。
              </p>
              <p className="mt-2 text-xs text-[var(--dim)]">
                电表类型为什么能决定同一套餐显示哪个版本：同一个套餐在零售商那里一般有单费率、分时两个版本，两版在官方数据里除了费率没有任何区别——给哪一版，取决于你家电表登记的计费方式（每个套餐的适用条件都写明要和电表的计费配置相符）。零售商官网就是这么定的：你填地址，它按地址查到电表编号、读到这块表登记的计费方式，所以不用你填这个条件。有两版的套餐只给相符的那一版；只有一版的套餐照常给——比如 Midday Power Saver 只有分时版、装了智能电表就能选，所以你在官网搜出的那 4 个套餐里单费率和分时都有。工具查不到电表登记信息，只能请你在这里选：例如你在零售商官网按自己地址搜出的双版本套餐全是单费率版，就选单费率。和账单对不上就改选：现用套餐全天一个价是单费率，分峰 / 平 / 肩不同价是分时；改完立刻重新显示，不用重新抓取。
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block text-sm text-[var(--text)]" htmlFor="elec-daily">
                  电日均用量（kWh/天）
                  <input
                    id="elec-daily"
                    name="elecDailyKwh" type="number" min={0.1} max={500} required
                    step="0.1"
                    inputMode="decimal"
                    value={elecDailyInput}
                    onChange={(e) => setElecDailyInput(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="block text-sm text-[var(--text)]" htmlFor="self-gen-daily">
                  自发电量（kWh/天）
                  <input
                    id="self-gen-daily"
                    name="selfGenDailyKwh" type="number" min={0} max={500} required
                    step="0.1"
                    inputMode="decimal"
                    value={selfGenInput}
                    onChange={(e) => setSelfGenInput(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="block text-sm text-[var(--text)]" htmlFor="gas-daily">
                  气日均用量（MJ/天）
                  <input
                    id="gas-daily"
                    name="gasDailyMj" type="number" min={0} max={5000} required
                    step="0.1"
                    inputMode="decimal"
                    value={gasDailyInput}
                    onChange={(e) => setGasDailyInput(e.target.value)}
                    className={inputCls}
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                就这三个数，其余口径按 VDO：年用电 = 日均 × 365，分时按 VDO 负荷曲线拆成峰 29% / 平 53% / 肩 18%（峰 16–21 点、肩 11–16 点、平 21–11 点）；默认值电 11 kWh/天（VDO 参考用量 4,000 kWh/年）、自发电 10 kWh/天、气 139 MJ/天（AER 维州住宅基准 50,743 MJ/年）。按当前输入折算：年电{" "}
                {effectiveSettings.elecKwh.toLocaleString("en-AU")} kWh（峰{" "}
                {effectiveSettings.elecPeakKwh.toLocaleString("en-AU")} / 平{" "}
                {effectiveSettings.elecFlatKwh.toLocaleString("en-AU")} / 肩{" "}
                {effectiveSettings.elecShoulderKwh.toLocaleString("en-AU")}），自发电出线{" "}
                {effectiveSettings.solarExportKwh.toLocaleString("en-AU")} kWh/年，年气{" "}
                {effectiveSettings.gasMj.toLocaleString("en-AU")} MJ。
              </p>
              {usageError ? (
                <p role="alert" className="mt-3 text-sm font-medium text-[var(--danger)]">
                  {usageError}
                </p>
              ) : null}
              {settingsError ? (
                <p role="alert" className="mt-2 text-sm font-medium text-[var(--danger)]">
                  {settingsError}
                </p>
              ) : null}
              <p className="mt-3 text-xs text-[var(--dim)]">
                这三个数和上面的勾选不用保存：改完下面的排名立刻按新条件重新显示。刷新时工具会把这个地址下所有适用的套餐一次抓全（电池、电车专用套餐也一并抓回来存着），之后改用量或改勾选都只是按新条件重新显示已有数据，不再重新抓取；只有换了地址，才需要抓新地址的数据。
              </p>
              {reference.current.elecPlanNote || reference.current.gasPlanNote ? (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  {reference.current.elecPlanNote}
                  {reference.current.elecPlanNote && reference.current.gasPlanNote
                    ? "；"
                    : ""}
                  {reference.current.gasPlanNote}。
                </p>
              ) : null}
            </div>

            {/* Refresh — same row carries the outcome + reason */}
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              {elecNeedsSettle && !elecAmbiguous ? (
                <p className="mb-3 rounded-[var(--radius)] border border-[var(--gas)] bg-[var(--gas-soft)] px-3 py-2 text-sm font-medium text-[var(--text)]">
                  电网下拉框现在选的是 {elecPickLabel}：点「立即刷新」会先按这个电网定下来，再按它拉数据。
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  type="button"
                  onClick={() => void onRefreshClick()}
                  disabled={
                    !refreshReady ||
                    refresh.isPending ||
                    refreshConfirming ||
                    saveSettings.isPending ||
                    confirmNetworks.isPending
                  }
                  aria-describedby="refresh-readiness"
                  className={`min-h-11 rounded-full px-6 text-base font-medium text-white ${
                    refreshReady
                      ? "bg-[var(--accent)]"
                      : "cursor-not-allowed bg-[#9aa5a0]"
                  } disabled:opacity-70`}
                >
                  {refreshActive
                    ? "正在刷新…"
                    : confirmNetworks.isPending
                      ? "正在切换电网…"
                      : saveSettings.isPending
                        ? "正在带上当前用量…"
                        : "立即刷新"}
                </button>
                {refreshActive ? null : refreshError ? (
                  <p role="alert" className="text-sm font-medium text-[var(--danger)]">
                    {refreshError}
                  </p>
                ) : refreshNote ? (
                  <p className="text-sm font-medium text-[var(--accent)]">{refreshNote}</p>
                ) : latest?.status === "error" ? (
                  <p role="alert" className="text-sm font-medium text-[var(--danger)]">
                    刷新失败：{latest.message ?? "数据源无法访问"}，下方仍显示上一次成功的数据。
                  </p>
                ) : latest?.status === "partial" ? (
                  <p className="text-sm font-medium text-[var(--gas)]">
                    部分更新：{latest.message ?? "部分数据源未返回"}，没更新到的部分仍显示上一次的数据。
                  </p>
                ) : null}
              </div>
              {showRefreshProgress ? (
                <div className="mt-3">
                  <div
                    role="progressbar"
                    aria-label="刷新进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(refreshProgressPct)}
                    className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-alt)]"
                  >
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
                      style={{ width: `${refreshProgressPct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-sm text-[var(--dim)]">
                    {refreshJustDone
                      ? "刷新完成，数据已更新。"
                      : refreshConfirming
                        ? `连接中断，正在确认刷新结果（服务端可能还在刷新）…已用 ${refreshElapsedSec} 秒，确认到新数据后这里会更新`
                        : `正在从 CDR 官方数据源拉取各品牌套餐…已用 ${refreshElapsedSec} 秒`}
                  </p>
                </div>
              ) : null}
              {!refreshReady &&
              !refresh.isPending &&
              !refreshConfirming &&
              missingReasons.length > 0 ? (
                <p id="refresh-readiness" className="mt-2 text-sm text-[var(--dim)]">
                  「立即刷新」还不能点：{missingReasons.join("；")}
                  。条件都齐了，按钮就会亮起来可以点。
                </p>
              ) : null}
              {refreshReady &&
              conditionsOnlyChange &&
              !elecNeedsSettle &&
              !refresh.isPending &&
              !refreshConfirming ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  只改了条件（用量 / 勾选 / 电表类型）：点「立即刷新」只保存新设置并按它重新显示，不会重新抓取数据（只有换地址才会重新抓取）。
                </p>
              ) : null}
              <p className="mt-2 text-xs text-[var(--dim)]">
                {latest
                  ? `上次检查：${fmtTime(latest.takenAt)}（${SOURCE_LABELS[latest.source]}）· 自动更新：${autoRefreshLabel(autoRefreshDays)}，页面打开时自动同步最新结果`
                  : "这个地址还没有检查记录，条件齐了点「立即刷新」从官方 CDR 数据源拉取一次。"}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label
                  htmlFor="auto-refresh-interval"
                  className="text-sm text-[var(--text)]"
                >
                  自动更新
                </label>
                <select
                  id="auto-refresh-interval"
                  aria-label="自动更新间隔"
                  value={autoRefreshDays}
                  disabled={setAutoRefreshMut.isPending}
                  onChange={(e) => {
                    const v = Number(e.target.value) as AutoRefreshDays;
                    setAutoRefreshDays(v);
                    setAutoRefreshMut.mutate(v);
                  }}
                  className="min-h-11 max-w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
                >
                  {AUTO_REFRESH_OPTIONS.map(([days, label]) => (
                    <option key={days} value={days}>
                      {label}
                      {days === 7 ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
                {setAutoRefreshMut.isPending ? (
                  <span className="text-sm text-[var(--dim)]">正在保存…</span>
                ) : null}
                <span className="text-xs text-[var(--dim)]">
                  选到哪个就按哪个来，没有保存按钮：到了间隔，后台会自动从
                  CDR 拉一次新数据；选「关闭」就只靠手动刷新。手动点「立即刷新」不受这个设置影响，随时能拉。
                </span>
              </div>
              {autoRefreshError ? (
                <p role="alert" className="mt-2 text-sm font-medium text-[var(--danger)]">
                  自动更新设置没保存上：{autoRefreshError}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* Best combo */}
        {comboBest != null && elecBestPlan && gasBestPlan ? (
          <section
            aria-label="最优组合"
            className="mt-3 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--accent-soft)] p-4"
          >
            <p className="flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
              最优组合
              {comboStatus ? <UpdateStatusDot status={comboStatus} /> : null}
            </p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-4xl font-semibold tabular-nums text-[var(--text)]">
              {fmtMoney(comboBest)}
              <span className="ml-1 text-sm font-normal text-[var(--dim)]">/年（电+气净成本）</span>
            </p>
            <p className="mt-1 text-sm text-[var(--text)]">
              电：{elecBestPlan.retailer} {elecBestPlan.planName}
              {isVariablePriced(elecBestPlan) ? <VariablePriceChip /> : null}
              {planCode(elecBestPlan) ? `（编号 ${planCode(elecBestPlan)}）` : ""}（
              {fmtMoney(elecBest ?? 0)}）+ 气：{gasBestPlan.retailer} {gasBestPlan.planName}
              {isVariablePriced(gasBestPlan) ? <VariablePriceChip /> : null}
              {planCode(gasBestPlan) ? `（编号 ${planCode(gasBestPlan)}）` : ""}（
              {fmtMoney(gasBest ?? 0)}）
            </p>
            {isVariablePriced(elecBestPlan) || isVariablePriced(gasBestPlan) ? (
              <p className="mt-1 text-xs text-[var(--dim)]">
                组合里的批发可变价套餐，年费是按 CDR 公布的估算费率算的，实际账单随批发价浮动，明细见下方排名里该套餐的备注。
              </p>
            ) : null}
            {comboSaving != null && comboSaving > 0 ? (
              <p className="mt-1 text-sm font-medium text-[var(--accent)]">
                比你现在的净支出 {fmtMoney(reference.current.netTotalAnnual ?? 0)}/年省{" "}
                {fmtMoney(comboSaving)}
              </p>
            ) : null}
          </section>
        ) : null}

        {/* Fuel tab switcher — sticky so gas is one tap away on mobile */}
        <div
          role="tablist"
          aria-label="选择查看电费或燃气"
          className="sticky top-0 z-20 -mx-4 mt-4 bg-[var(--bg)] px-4 py-2"
        >
          <div className="grid grid-cols-2 gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1">
            <button
              type="button"
              role="tab"
              aria-selected={fuelTab === "elec"}
              onClick={() => {
                setFuelTab("elec");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`flex min-h-11 flex-wrap items-center justify-center gap-x-1.5 rounded-full px-2 text-base font-medium transition-colors ${
                fuelTab === "elec"
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text)]"
              }`}
            >
              ⚡ 电费
              {elecBest != null ? (
                <span className="text-sm font-normal tabular-nums opacity-90">
                  {fmtMoney(elecBest)}/年
                </span>
              ) : null}
              {elecStatus ? <UpdateStatusDot status={elecStatus} /> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={fuelTab === "gas"}
              onClick={() => {
                setFuelTab("gas");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`flex min-h-11 flex-wrap items-center justify-center gap-x-1.5 rounded-full px-2 text-base font-medium transition-colors ${
                fuelTab === "gas"
                  ? "bg-[var(--gas)] text-white"
                  : "text-[var(--text)]"
              }`}
            >
              🔥 燃气
              {gasBest != null ? (
                <span className="text-sm font-normal tabular-nums opacity-90">
                  {fmtMoney(gasBest)}/年
                </span>
              ) : null}
              {gasStatus ? <UpdateStatusDot status={gasStatus} /> : null}
            </button>
          </div>
        </div>

        {/* Hero: cheapest annual bill for the selected fuel */}
        <section aria-label="当前最便宜年费" className="mt-2">
          {fuelTab === "elec" ? (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm font-medium text-[var(--accent)]">
                电费 · 当前最低净年费
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-4xl font-semibold tabular-nums text-[var(--text)]">
                {elecBest != null ? fmtMoney(elecBest) : "—"}
              </p>
              {elecBest != null && reference.current.elecNetAnnual != null ? (
                <p className="mt-1 text-sm">
                  <VsCurrent cost={elecBest} current={reference.current.elecNetAnnual} />{" "}
                  {reference.current.elecGrossAnnual != null &&
                  reference.current.feedInCreditAnnual != null ? (
                    <span className="text-[var(--dim)]">
                      （现在净 {fmtMoney(reference.current.elecNetAnnual)}：支出{" "}
                      {fmtMoney(reference.current.elecGrossAnnual)} − 回购{" "}
                      {fmtMoney(reference.current.feedInCreditAnnual)}）
                    </span>
                  ) : (
                    <span className="text-[var(--dim)]">
                      （现在净 {fmtMoney(reference.current.elecNetAnnual)}）
                    </span>
                  )}
                </p>
              ) : null}
              <p className="mt-1 text-sm">
                {elecBest != null ? <Delta current={elecBest} previous={prevElecBest} /> : null}
              </p>
            </div>
          ) : (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm font-medium text-[var(--gas)]">
                燃气 · 当前最低年费
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-4xl font-semibold tabular-nums text-[var(--text)]">
                {gasBest != null ? fmtMoney(gasBest) : "—"}
              </p>
              {gasBest != null && reference.current.gasAnnual != null ? (
                <p className="mt-1 text-sm">
                  <VsCurrent cost={gasBest} current={reference.current.gasAnnual} />{" "}
                  <span className="text-[var(--dim)]">
                    （现在 {fmtMoney(reference.current.gasAnnual)}/年）
                  </span>
                </p>
              ) : null}
              <p className="mt-1 text-sm">
                {gasBest != null ? <Delta current={gasBest} previous={prevGasBest} /> : null}
              </p>
            </div>
          )}

        </section>

        {/* Top plans — only the selected fuel, switched by the tabs above.
            Each fuel renders its own newest data-bearing snapshot, so a
            fuel the last refresh failed for still shows its previous
            data (marked 更新失败） instead of going blank. */}
        {display ? (
          fuelTab === "elec" ? (
            elecDisplay ? (
              <section aria-label="电费套餐排名" className="mt-6">
                <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
                  电费套餐排名{" "}
                  <span className="text-sm font-normal text-[var(--dim)]">
                    {activeAddress.elecDistributorLabel}
                    {elecAmbiguous ? "（暂定，未确认，见上方）" : ""} · 按当前口径 {effectiveSettings.elecKwh.toLocaleString("en-AU")} kWh（日均 {effectiveSettings.elecDailyKwh} kWh，VDO 分时拆峰{" "}
                    {effectiveSettings.elecPeakKwh.toLocaleString("en-AU")} / 平{" "}
                    {effectiveSettings.elecFlatKwh.toLocaleString("en-AU")} / 肩{" "}
                    {effectiveSettings.elecShoulderKwh.toLocaleString("en-AU")}）+ 自发电出线{" "}
                    {effectiveSettings.solarExportKwh.toLocaleString("en-AU")} kWh 的净成本，共{" "}
                    {elecPlansShown.length} 个 plan
                  </span>
                </h2>
                <PlanList
                  key="elec"
                  plans={elecPlansShown}
                  kind="elec"
                  settings={effectiveSettings}
                  snapshot={elecDisplay}
                  currentAnnual={reference.current.elecNetAnnual}
                  statusByKey={elecPlanStatuses}
                />
              </section>
            ) : (
              <p className="mt-8 text-sm text-[var(--dim)]">
                还没有电费数据。点上方「立即刷新」从官方 CDR 数据源拉取一次。
              </p>
            )
          ) : gasDisplay ? (
            <section aria-label="燃气套餐排名" className="mt-6">
              <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
                燃气套餐排名{" "}
                <span className="text-sm font-normal text-[var(--dim)]">
                  {activeAddress.gasDistributorLabel}
                  {activeAddress.gasZone ? ` ${activeAddress.gasZone}` : ""} · 阶梯费率 · 按年用 {effectiveSettings.gasMj.toLocaleString("en-AU")} MJ（
                  {(effectiveSettings.gasMj / 365).toFixed(1)} MJ/天）估算，共 {gasDisplay.gasPlans.length}{" "}
                  个 offer
                </span>
              </h2>
              <PlanList
                key="gas"
                plans={gasDisplay.gasPlans}
                kind="gas"
                settings={effectiveSettings}
                snapshot={gasDisplay}
                currentAnnual={reference.current.gasAnnual}
                statusByKey={gasPlanStatuses}
              />
            </section>
          ) : (
            <p className="mt-8 text-sm text-[var(--dim)]">
              {activeAddress.gasDistributorId === "none"
                ? "这个地址没有接燃气（地址里选的是「无燃气」）。"
                : "还没有燃气数据。点上方「立即刷新」从官方 CDR 数据源拉取一次。"}
            </p>
          )
        ) : (
          <p className="mt-8 text-sm text-[var(--dim)]">
            还没有价格数据。点上方「立即刷新」从官方 CDR 数据源拉取一次。
          </p>
        )}

        <HistoryChart snapshots={snapshots} settings={effectiveSettings} kind={fuelTab} />

        {/* VDO reference — electricity only, and only for AusNet
            addresses (the one zone with verified VDO figures). */}
        {fuelTab === "elec" && vdo ? (
          <section
            aria-label="VDO 默认价"
            className="mt-10 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-4"
          >
          <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
            Victorian Default Offer（VDO）参考价
          </h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            AusNet 区 · {vdo.periodLabel} · 单费率来源：Essential Services
            Commission；分时费率为 VDO 分时价（2026–27 年度）
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <div>
              <dt className="text-xs text-[var(--dim)]">供应费</dt>
              <dd className="mt-0.5 font-[family-name:var(--font-display)] text-lg font-semibold tabular-nums text-[var(--text)]">
                {fmtC(vdo.supplyCPerDay)}/天
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--dim)]">单费率</dt>
              <dd className="mt-0.5 font-[family-name:var(--font-display)] text-lg font-semibold tabular-nums text-[var(--text)]">
                {fmtC(vdo.rateCKwh)}/kWh
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--dim)]">分时 · 峰/平/肩</dt>
              <dd className="mt-0.5 font-[family-name:var(--font-display)] text-lg font-semibold tabular-nums text-[var(--text)]">
                {fmtC(vdo.tou.peakC)} / {fmtC(vdo.tou.flatC)} /{" "}
                {fmtC(vdo.tou.shoulderC)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--dim)]">分时净年费（VDO 用量）</dt>
              <dd className="mt-0.5 font-[family-name:var(--font-display)] text-lg font-semibold tabular-nums text-[var(--text)]">
                约 {fmtMoney(vdo.touNetAtActualUsage)}
              </dd>
            </div>
          </dl>
            <p className="mt-3 text-sm text-[var(--dim)]">
              VDO 分时套餐按 VDO 参考用量（4,000 kWh/年，按峰 29% / 平 53% / 肩 18% 拆分）净成本约{" "}
              {fmtMoney(vdo.touNetAtActualUsage)}；单费率 VDO 按 4,000
              kWh/年算约 {fmtMoney(vdo.annualAt4000)}。
            </p>
          </section>
        ) : null}

        <RetailerList retailers={data.retailers} defaultFuel={fuelTab} />

        {/* Method & caveats */}
        <section aria-label="数据说明" className="mt-10 border-t border-[var(--border)] pt-5">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--text)]">
            数据说明
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--dim)]">
            <li>
              多地址：页面最前面只有一个地址输入框，输入时下拉列出已保存地址和地址建议（地址建议同时查 Nominatim 普通搜索、Nominatim 结构化搜索和 Photon 地理编码，都是 OpenStreetMap 数据，结果合并去重后显示；搜索中或没搜到时下拉里会直接写明状态，不再是空白一片），在下拉里点选、或把地址填完整后会自动保存并切换，不用点保存按钮。每个地址各自保存配电网、设备勾选、用量和检查记录；保存时按邮编自动配网（见下一条），配网结果刷新显示在输入框下方，排名、走势、最优组合和「与现在比」全部换成该地址的。数据刷新只在条件都齐了以后点「立即刷新」进行（条件不齐时按钮是灰的）。VDO 参考价只有 AusNet 区有已核实数据，其他配电网的地址不显示 VDO。
            </li>
            <li>
              配电网自动判断（2026-11-20 实测）：没有按街道地址查配电网的公开接口——维州政府的{" "}
              <a
                className="text-[var(--accent)] underline"
                href="https://www.energy.vic.gov.au/about-energy/find-your-energy-distributor"
                target="_blank"
                rel="noreferrer"
              >
                Find your energy distributor
              </a>{" "}
              只有区域表和地图，配电网边界也不按邮编走。工具改用 CDR
              套餐数据判断：每个套餐都带「覆盖邮编 + 配电网」，按邮编扫一遍就知道哪些电网
              / 气网在这个邮编有住宅套餐，燃气分区从套餐名里带出。实测举例：3043 → Jemena 电 / AusNet 气，3146 → United Energy 电 /
              Multinet 气。邮编跨网时（两个电网都覆盖、且第二名覆盖数达到第一名一半以上）按邮编分不出是哪一个：例如 3977 是 United Energy 和 AusNet 几乎各半——这种地址保存时只先按覆盖最多的暂定一个，页面会标「未确认」并让你按电费账单在下拉框里选真正的电网：没有确认按钮，下拉框选到哪个就按哪个查、立刻生效（改选另一个电网会清掉之前按暂定电网抓的数据重抓）；一直不动下拉框的话，点「立即刷新」就按下拉框当前选的这个定下来再拉数据。下拉框一直留在地址下面，选错了随时改选。零售商官网（如 1st Energy）是按地址本身定电网的，电网暂定错了，每家价格都会和官网查到的不一样（零售商官网按地址本身定电网，电网暂定错了，每家价格都会和官网查到的不一样）。局限：判断是邮编级的，某家套餐没把邮编列全就可能漏掉一个网。
            </li>
            <li>
              同名套餐的分区变体（2026-11-20 修复）：有些零售商把同一个套餐名按定价分区发布成多个变体，名字和配电网都一样，只能靠各自的「覆盖邮编」名单区分——例如 Sumo 燃气 Online Saver Plus 在 AGN 网上有两个变体，一个覆盖墨尔本邮编，另一个只覆盖维州乡镇（Shepparton 一带）。此前工具只按配电网名匹配，两个变体都进了排名，乡镇变体在当前气用量下便宜一点，被排成了燃气第一名、进了最优组合——但这个地址根本买不到它。现在抓取时多一道同名变体校验：同名变体里只要有的名单覆盖这个邮编，就只保留覆盖本邮编的变体；没有任何变体的名单覆盖本邮编时则全部保留（CDR 邮编名单偶有漏列，不能反过来把对的套餐删掉）。
            </li>
            <li>
              用量口径（2026-11-20 改版）：用量只填三个日均数——电日均、自发电量（默认 0 kWh/天，没装太阳能 / 电池就填 0；太阳能发的电，也可以是电池放的电）、气日均——加太阳能 / 电池 / 电车三个勾选和电表类型（单费率 / 分时），不用保存，改完下面的排名立刻按新数重算；点「立即刷新」时把当前数值存下。抓取与显示是分开的（2026-11-20 再改）：刷新会把当前地址下所有适用的套餐一次抓全存下来，电池 / 电车专用套餐也一并抓回，勾选只决定显示哪些——没勾太阳能 / 电池 / 电车，对应的专用套餐就不显示，勾上立刻出现，不用重新抓取；改用量或改勾选都只按新条件重新显示已有数据，只有换地址才重新抓取。电表类型同理（2026-11-20 补；根因同日晚间逐项核实）：同一个套餐在 CDR 上一般有单费率和分时两个版本，把两版的原始数据逐字段比对过——资格条件、覆盖邮编、费用、生效日期全都一样，唯一差别就是费率结构本身，所以决定显示哪一版的条件不在套餐数据里，在电表那边：每个套餐的适用条件都写着要与「适用的网络费率和电表配置」相符。零售商官网按你填的地址查到电表编号、读到这块表登记的计费方式，所以不用你填这个条件，筛法也是按每个套餐筛——有两版的只给相符的那一版，只有一版的照常给。工具查不到电表登记信息，只能按地址保存你选的类型来显示，这条规则对所有零售商、所有地址统一适用。实例：1st Energy 在 AusNet 有多个住宅套餐——Emerald、Home、VDO 各有单费率 / 分时两版，再加只有分时版的 Midday Power Saver；如果你在零售商官网按自己地址搜出的双版本套餐全是单费率版，说明这块电表登记为单费率，就选单费率；结果里单费率和分时同时出现，往往是因为 Midday 这类套餐只有分时一版（其官网说明写明面向所有装了智能电表的住宅用户）。其余默认值按 VDO：电默认 11 kWh/天（VDO 参考用量 4,000 kWh/年），分时拆分用 VDO 负荷曲线峰 29% / 平 53% / 肩 18%（口径见{" "}
              <a
                className="text-[var(--accent)] underline"
                href="https://billhero.com.au/electricity/eden-park-3757"
                target="_blank"
                rel="noreferrer"
              >
                BillHero 的 AusNet VDO 说明页
              </a>
              ：约 29% 峰、18% 肩（solar soak）、53% 平）；气默认 139 MJ/天（AER 维州住宅基准 50,743 MJ/年，经{" "}
              <a
                className="text-[var(--accent)] underline"
                href="https://wattever.com.au/compare-best-gas-rates-vic/"
                target="_blank"
                rel="noreferrer"
              >
                WATTever 的 AER 基准表
              </a>{" "}
              核对）。真实用量没有任何网站能按地址查到（在零售商和配电网手里，要本人授权），有账单上的真实日均数时优先填真实数。年用量按上面三个日均数 × 365 折算。
            </li>
            <li>
              数据来源：本地数据库初始是空的，没有预置任何家庭数据；点「立即刷新」后从 AER 的 Consumer Data Right (CDR) 官方套餐数据接口（cdr.energymadeeasy.gov.au，Victorian Energy Compare 的同源数据）按当前地址的配电网拉取最新套餐。零售商名单取自 Victorian Energy Compare 的 33 家零售商表。
            </li>
            <li>
              排名按当前用量口径算：电 {effectiveSettings.elecKwh.toLocaleString("en-AU")} kWh/年（日均{" "}
              {effectiveSettings.elecDailyKwh} kWh，按 VDO 分时曲线拆峰{" "}
              {effectiveSettings.elecPeakKwh.toLocaleString("en-AU")} / 平{" "}
              {effectiveSettings.elecFlatKwh.toLocaleString("en-AU")} / 肩{" "}
              {effectiveSettings.elecShoulderKwh.toLocaleString("en-AU")}），计入分时电价与自发电回购（出线{" "}
              {effectiveSettings.solarExportKwh.toLocaleString("en-AU")}{" "}
              kWh/年，回购按各 plan 费率计算、有日上限的按上限截断、超出部分按 plan
              规则）；气 {effectiveSettings.gasMj.toLocaleString("en-AU")} MJ/年（日均{" "}
              {effectiveSettings.gasDailyMj} MJ），按官方阶梯精确计算。
            </li>
            {reference.current.known ? (
              <li>
                当前地址的现用套餐年费（按当前用量口径）：电净{" "}
                {fmtMoney(reference.current.elecNetAnnual ?? 0)}/年
                {reference.current.elecGrossAnnual != null &&
                reference.current.feedInCreditAnnual != null
                  ? `（支出 ${fmtMoney(reference.current.elecGrossAnnual)} − 回购 ${fmtMoney(reference.current.feedInCreditAnnual)}）`
                  : ""}
                ；气 {fmtMoney(reference.current.gasAnnual ?? 0)}/年；合计净{" "}
                {fmtMoney(reference.current.netTotalAnnual ?? 0)}/年。
              </li>
            ) : (
              <li>
                当前地址没有记录现用套餐的年费，所以不显示「与现在比」（不会拿其他地址的数字冒充）。
              </li>
            )}
            <li>
              自动更新（默认每周一次，可在刷新按钮下方的「自动更新」里改成每天、每两周、每月或关闭；手动点「立即刷新」不受影响，随时能拉）拉取的是 AER 的 Consumer Data Right (CDR) 官方套餐数据
              （cdr.energymadeeasy.gov.au），刷新后的年费同样按上面的用量口径（分时 +
              回购）重算；CDR 只收录参与品牌的市场套餐。同一套餐在
              CDR 里常有单费率版与分时版两种（对应不同的电表计费配置），本页两种都抓回来存着，只按上面选的电表类型——也就是这个地址电表登记的计费方式——显示并计价相符的那一版，只有一版的套餐不受影响、照常显示；太阳能回购按
              CDR 公布值计（回购不另加 GST）。
            </li>
            <li>
              和零售商官方费率单（fact sheet）对账（以 1st Energy 公开费率单为例核对过）：供应费和每度电价两边一致——1ST787440MR 供应费
              99.99c/天、单价 24.86c；1ST810296MR 121.77c/天、30.36c；1ST764126SR
              128.24c/天、31.98c；1ST804532SR 128.24c/天、分时各段（峰 49.82c / 平
              24.78c / 午间免费段超出后 19.76c），四份的回购都是
              0.5c。但费率单上的估算年费是按标准家庭三档用量印的（低 7.2 / 中 11.8 /
              高 15.5 度每天），本页按你上面填的日均用量算，所以年费数字一般对不上，
              是口径不同、不是费率不同：把电日均用量改成 15.5
              度，单费率套餐的年费就和费率单「高」档估算基本一致（费率单取整到十位）。
              午间免费类套餐（Midday Power
              Saver）的免费时段和每日免费额度写在该套餐的备注里；本页肩段显示的
              7.9c 是把免费时段摊进 11–16 点后的时段均价，费率单上没有这个价——费率单
              是分段标价（11–14 点每天前 24 度免费、14–16 点 19.76c）。
            </li>
            <li>
              CDR 覆盖已按 VEC 33 家零售商表逐家探查补全（2026-11-19）：新增 Amber
              Electric、Blue NRG、Diamond Energy、Flipped Energy、Flow Power、Nectr、Next
              Business Energy，并经 Energy Locals 的 CDR 通道补上 Indigo
              Power——这些品牌在 AusNet 区有住宅电套餐，已纳入每日刷新，排名按 VEC
              33 家表全量显示。其余逐家核实后没有适用于维州普通住宅地址的数据：Arcline by RACV、Pacific Blue
              在 CDR 上无任何套餐记录；Perpetual Energy、SmartestEnergy 在 CDR
              上只有商业套餐；Energy Locals Urban、Real Utilities
              是嵌入式网络，不覆盖 AusNet 普通住宅；Solstice 维州只有乡镇燃气，CDR
              上同名品牌是塔州电力，并非同一家；1st Energy (EL Retail Energy) 的套餐经
              Energy Locals 通道发布，但没有适用于 AusNet / AGN 的住宅套餐。
            </li>
            <li>
              2026-11-19 已修复一处解析错误：此前 CDR
              里各套餐的分时版被漏抓（某套餐只剩单一费率版，年费误算），太阳能回购也全部漏计（误显示「无太阳能回购」）。修复后
              分时版与回购都已计入；修复前的
              CDR 快照仍留在走势里，那几个点位偏高是旧错误造成的。
            </li>
            <li>
              2026-11-19 再次修复回购计价（此前电费前几名年费偏低的原因）：部分套餐的回购是分时或阶梯的——最高价只在晚间时段（太阳能基本不出线）或只限每天前若干度，旧算法却把最高一档价套在全部{" "}
              {effectiveSettings.solarExportKwh.toLocaleString("en-AU")}{" "}
              kWh 出线上，多算了几百到一千多元回购，把这几个套餐顶到了排名最前。现改为：分时回购按白天出线时段（7–19
              点）的均价计，阶梯回购按每日上限截断、超出部分按低档价计。电池专用套餐（如
              Origin Battery Earner，其 26.5c
              回购是晚间电池放电价）只在勾选了「电池」时才进排名，没勾就剔除（电车套餐同理，只在勾选「电车」时进排名）。修复前的 CDR
              快照仍留在走势里，那几个偏低的点位是旧错误造成的。
            </li>
            <li>
              2026-11-20 补上太阳能的显示规则：此前设备勾选只管电池和电车——没勾电池剔除电池套餐、没勾电车剔除电车套餐，唯独太阳能没有对应规则，太阳能专用套餐（名字带
              Solar 的，如 EnergyAustralia Solar Max、CovaU SolarMax、ENGIE Solar
              Elec，以及适用条件写明必须装太阳能系统的套餐）在没勾太阳能时仍留在排名里展示。现在三项一致：没勾太阳能，这些套餐不进排名（走势图的最低年费也按同一规则算）；名字里带多项设备的套餐（如
              Battery + Solar）要把对应勾选都勾上才显示。普通套餐只是附带一个回购价，不算太阳能专用套餐，照常显示——没勾太阳能时出线按
              0 计，回购不计入年费，排名就是纯用电成本的顺序。
            </li>
            <li>
              {!hasActiveAddress
                ? "还没有保存地址，配电网信息待添加地址后显示。"
                : <>当前地址配电网：电为 {activeAddress.elecDistributorLabel}
              {elecAmbiguous ? "（暂定，未确认——这个邮编两个电网都覆盖，见页首确认区）" : ""}，气为{" "}
              {activeAddress.gasDistributorId === "none"
                ? "无燃气"
                : `${activeAddress.gasDistributorLabel}${activeAddress.gasZone ? `（${activeAddress.gasZone} 区）` : ""}`}</>}
              。
            </li>
            <li>
              套餐备注：每个套餐的「备注」来自 CDR 里零售商自己公布的说明（价格变动方式、适用条件、优惠条件），显示的都是中文：批发可变价套餐（名字带「批发可变价·估算」标记，如
              Flow Power、Amber 的估算价套餐）的适用条件（需要哪些设备、估算按多大的太阳能 / 电池算）和优惠条件（金额、是否仅限新客）是中文摘要，其他套餐的说明翻成中文显示。零售商的英文原文不直接显示，收在每个套餐备注下方的「零售商原文 ▾」里，点开才看。批发可变价套餐电价跟着批发市场走、不是固定价，CDR
              公布的费率只是估算值，年费按估算费率计算，实际账单会随用电时段和批发价浮动。优惠条件（如新客抵扣）没有计入年费，备注里会写明。几乎每家都有的「费率可按条款调整」这类套话不逐条显示。勾选电池时，有批发价套餐的供应商整家排到总排名最前面（批发价供应商之间按各自批发价套餐的供应费从低到高排），每家内部批发价套餐排在最前面、其他套餐顺序不变。
            </li>
            <li>换供应商需自行联系零售商办理；本页只做价格监测，不代办签约。</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
