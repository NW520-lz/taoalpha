import type { Db } from "../../src/store/db.ts";
import { runScan, type ScanResult } from "../../src/scan/scan.ts";
import { createFakeClient } from "./fake-okx.ts";
import { NOW, marketRoutes, testStrategy } from "./market-fixtures.ts";

/** A real scan over the synthetic market: GOOD-USDT and GOOD-USDT-SWAP pass screening, WIDE-USDT fails. */
export async function seedBundle(db: Db, strategy = testStrategy()): Promise<ScanResult> {
  const { client } = createFakeClient(marketRoutes());
  return runScan(db, client, strategy, () => NOW);
}

export function marketStructureReport(ref: string) {
  return {
    summary: "GOOD 现货 24 小时上涨约 11%，成交额充足。",
    claims: [{ statement: "GOOD-USDT 24h 涨幅 11.1111%", label: "fact", evidenceRefs: [ref] }],
    sources: [],
    unknowns: ["更长周期的趋势未取得"],
    missingData: [],
    assessments: [
      {
        instId: "GOOD-USDT",
        regime: "trend_up",
        scenarios: ["放量突破后回踩确认", "冲高回落进入震荡"],
        entryIdea: "回踩 9.8 附近再观察",
        invalidation: "跌破 9.5",
        evidenceRefs: [ref],
      },
    ],
  };
}

export function fundamentalsReport(ref: string, excerpt = "GOOD 官方公告：主网升级计划于 11 月 1 日进行。") {
  return {
    summary: "存在已公告的主网升级事件。",
    claims: [{ statement: "主网升级已由官方公告", label: "fact", evidenceRefs: ["src1"] }],
    sources: [
      {
        key: "src1",
        url: "https://example.com/good-mainnet-upgrade",
        publishedAt: "2026-10-27T08:00:00Z",
        fetchedAt: "2026-10-28T11:00:00Z",
        label: "fact",
        instIds: ["GOOD-USDT"],
        excerpt,
      },
    ],
    unknowns: ["升级是否会延期"],
    missingData: ["代币解锁日程未取得"],
    events: [
      {
        instId: "GOOD-USDT",
        event: "主网升级",
        eventTime: "2026-11-01T00:00:00Z",
        impactPath: "升级预期可能吸引短期资金",
        counterExplanation: "利好可能已被价格消化",
        verified: true,
        evidenceRefs: ["src1", ref],
      },
    ],
  };
}

export function quantReport(ref: string) {
  return {
    summary: "只做了快照内的描述性计算，没有历史回测。",
    claims: [],
    sources: [],
    unknowns: ["该形态的历史表现未验证"],
    missingData: ["历史 K 线未取得"],
    historicalValidation: "not_performed",
    computations: [{ description: "24h 涨幅", method: "(last - open24h) / open24h", result: "11.1111%", evidenceRefs: [ref] }],
  };
}

export function adversaryReport(ref: string, opts: { blocking?: boolean; target?: string } = {}) {
  return {
    summary: "涨幅可能由短期事件驱动，持续性存疑。",
    claims: [],
    sources: [],
    unknowns: [],
    missingData: [],
    objections: [
      {
        id: "obj1",
        target: opts.target ?? "GOOD-USDT",
        objection: "涨幅可能来自少数大单，事件落地后回吐",
        strongestCounterEvidence: "24h 高点 10.5 后已回落",
        waitCondition: "成交额在高位维持两小时",
        blocking: opts.blocking ?? false,
        evidenceRefs: [ref],
      },
    ],
  };
}

type CandidateSpec = { instId: string; product: "spot" | "usdt_perpetual"; direction: "long" | "short" };

export function synthesisReport(
  ref: string,
  opts: { decision?: "trade_candidate" | "wait" | "skip"; candidates?: CandidateSpec[]; objectionIds?: string[] } = {},
) {
  const decision = opts.decision ?? "trade_candidate";
  const specs = decision === "trade_candidate" ? (opts.candidates ?? [{ instId: "GOOD-USDT", product: "spot", direction: "long" }]) : [];
  return {
    summary: decision === "trade_candidate" ? "GOOD 可作为短期催化候选，等待人工审阅。" : "证据不足，等待。",
    claims: [],
    sources: [],
    unknowns: ["策略未经过历史验证"],
    missingData: [],
    decision,
    candidates: specs.map((spec) => ({
      ...spec,
      thesisHorizon: "short_term_catalyst",
      thesis: "主网升级前的短期资金流入",
      entryIdea: "回踩 9.8 附近",
      invalidation: "跌破 9.5 或升级延期",
      evidenceRefs: [ref],
    })),
    waitConditions: decision === "trade_candidate" ? [] : ["成交额在高位维持两小时"],
    objectionResponses: (opts.objectionIds ?? ["obj1"]).map((objectionId) => ({ objectionId, response: "已纳入失效条件，回落即放弃" })),
  };
}
