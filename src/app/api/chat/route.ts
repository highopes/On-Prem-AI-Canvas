import { Agent } from "undici";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClientReq = {
  message: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  stream?: boolean;
  workspace?: "security" | "observability";
};

type VizKind = "none" | "single" | "table" | "bar" | "pie" | "line";
type Template = "count" | "table" | "count_by" | "trend";
type GroupBy = "Severity" | "node_pod_container" | "recent_network_activity" | "tag";

type OutputSpec = {
  kind: VizKind;
  title: string;
  template: Template;
  group_by?: GroupBy;
  limit?: number;
  span?: string;
  split?: "none" | "severity";
};

type Filters = {
  severity_exact?: Array<"CRITICAL" | "WARNING" | "INFO">;
  description_like?: string;
  details_like?: string;
  node_like?: string;
  has_network_activity?: boolean;
  tags_exact?: string[];
};

type ChartDatum = Record<string, string | number>;
type TableRow = Record<string, string | number | null | undefined>;
type McpRow = Record<string, unknown>;

type Plan = {
  language: "en" | "zh";
  earliest_time: string;
  latest_time: string;
  filters: Filters;
  outputs: OutputSpec[];
};

type ObservabilityViz = "line" | "network";
type ObservabilityMcp = "grafana" | "hubble" | "ndi";
type ObservabilityTool = "query_dashboard_timeseries" | "fetch_flow_metrics" | "fetch_anomalies";
type ObservabilityTarget =
  | "hubble-l7-http-metrics-by-workload"
  | "nvidia-dcgm-exporter-dashboard"
  | "vllm-dashboard"
  | "ai-serving/foundation-instruct-vllm"
  | "fdtn-ai/Foundation-Sec-8B-Instruct"
  | "default-cluster";
type ObservabilityMetric = "success_count_per_minute" | "success_rate" | "gpu_utilization" | "policy_drop_flows" | "anomaly_events";

type ObservabilityRequest = {
  mcp: ObservabilityMcp;
  tool: ObservabilityTool;
  target: ObservabilityTarget;
  metric: ObservabilityMetric;
  viz: ObservabilityViz;
  title: string;
};

type ObservabilityPlan = {
  language: "en" | "zh";
  earliest_time: string;
  latest_time: string;
  requests: ObservabilityRequest[];
};

type ObservabilityIntent = "success_rate" | "success_count" | "anomaly" | "gpu" | "unknown";

type NetworkNode = { id: string; label: string; status: "ok" | "alert" };
type NetworkEdge = { from: string; to: string; label?: string };
type NetworkAnnotation = { nodeId: string; label: string };
type NetworkRow = {
  source: string;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  annotations?: NetworkAnnotation[];
  stats?: { policy_drop?: number; anomalies?: number };
};

type Panel =
  | { panel_id: string; title: string; kind: "single"; spl: string; label: string; value: number }
  | { panel_id: string; title: string; kind: "table"; spl: string; columns: string[]; rows: TableRow[] }
  | {
      panel_id: string;
      title: string;
      kind: "bar";
      spl: string;
      xKey: string;
      yKey: string;
      data: ChartDatum[];
      drilldownType: "severity" | "tag" | "node" | "net";
    }
  | {
      panel_id: string;
      title: string;
      kind: "pie";
      spl: string;
      xKey: string;
      yKey: string;
      data: ChartDatum[];
      drilldownType: "severity" | "tag" | "node" | "net";
    }
  | { panel_id: string; title: string; kind: "line"; spl: string; xKey: string; seriesKeys: string[]; data: ChartDatum[] }
  | { panel_id: string; title: string; kind: "network"; rows: NetworkRow[] };

function detectLanguage(msg: string): "en" | "zh" {
  return /[\u4e00-\u9fff]/.test(msg) ? "zh" : "en";
}

function clampInt(n: unknown, lo: number, hi: number, dflt: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(x)));
}

function stripQuotes(v: string): string {
  const s = String(v ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function joinUrl(base: string, path: string): string {
  const b = String(base ?? "").replace(/\/+$/, "");
  const p = String(path ?? "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

function envBool(name: string, dflt: boolean): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function undiciDispatcherFor(url: string) {
  if (url.startsWith("https://")) return new Agent({ connect: { rejectUnauthorized: false } });
  return undefined;
}

function getRequiredAppToken(): string {
  return String(process.env.APP_ACCESS_TOKEN || "").trim();
}

function extractBearerToken(req: Request): string {
  const auth = String(req.headers.get("authorization") || "");
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const alt = String(req.headers.get("x-app-token") || "");
  return alt.trim();
}

function requireAuthIfConfigured(req: Request): { ok: boolean; resp?: Response } {
  const required = getRequiredAppToken();
  if (!required) return { ok: true };

  const got = extractBearerToken(req);
  if (!got || got !== required) {
    return {
      ok: false,
      resp: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true };
}

function resolveSplunkMcpConfig() {
  const endpoint = process.env.SPLUNK_MCP_ENDPOINT || process.env.MCP_ENDPOINT || "";
  const tokenRaw = process.env.SPLUNK_MCP_TOKEN || process.env.MCP_TOKEN || "";
  const token = stripQuotes(tokenRaw);

  if (!endpoint) throw new Error("Missing Splunk MCP endpoint (SPLUNK_MCP_ENDPOINT or MCP_ENDPOINT)");
  if (!token) throw new Error("Missing Splunk MCP token (SPLUNK_MCP_TOKEN or MCP_TOKEN)");
  return { endpoint, token };
}

function resolveQwenChatCompletionsUrl(): string {
  const direct = process.env.QWEN_ENDPOINT || process.env.QWEN_CHAT_COMPLETIONS || "";
  if (direct) return direct;

  const base = process.env.QWEN_BASE_URL || process.env.QWEN_URL || "";
  if (!base) throw new Error("Missing Qwen endpoint (QWEN_ENDPOINT or QWEN_BASE_URL)");

  const lower = base.toLowerCase();
  if (lower.includes("/chat/completions")) return base;
  if (lower.endsWith("/v1") || lower.endsWith("/v1/")) return joinUrl(base, "chat/completions");
  if (!lower.includes("/v1")) return joinUrl(joinUrl(base, "v1"), "chat/completions");
  return joinUrl(base, "chat/completions");
}

function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isMcpRow(value: unknown): value is McpRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractResultsFromMcpResult(r: unknown): McpRow[] {
  if (!r) return [];

  if (typeof r === "object" && r !== null) {
    const sc = (r as { structuredContent?: unknown }).structuredContent;
    if (sc && typeof sc === "object") {
      const scObj = sc as { results?: unknown; data?: unknown };
      if (Array.isArray(scObj.results)) return scObj.results.filter(isMcpRow);
      if (Array.isArray(scObj.data)) return scObj.data.filter(isMcpRow);
    }
  }

  if (typeof r === "object" && r !== null) {
    const results = (r as { results?: unknown }).results;
    if (Array.isArray(results)) return results.filter(isMcpRow);
  }

  if (typeof r === "object" && r !== null) {
    const fields = (r as { fields?: unknown }).fields;
    const rows = (r as { rows?: unknown }).rows;
    if (Array.isArray(rows) && Array.isArray(fields)) {
      return rows.map((row) => {
        const obj: McpRow = {};
        fields.forEach((f, i) => {
          if (typeof f === "string") obj[f] = Array.isArray(row) ? row[i] : undefined;
        });
        return obj;
      });
    }
  }

  if (typeof r === "object" && r !== null) {
    const data = (r as { data?: unknown }).data;
    if (Array.isArray(data)) return data.filter(isMcpRow);
  }

  if (typeof r === "object" && r !== null) {
    const content = (r as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && typeof c === "object") {
          const cObj = c as { type?: unknown; json?: unknown; text?: unknown };
          if (cObj.type === "json" && cObj.json && typeof cObj.json === "object") {
            const jsonObj = cObj.json as { results?: unknown };
            if (Array.isArray(jsonObj.results)) return jsonObj.results.filter(isMcpRow);
          }
          if (cObj.type === "text" && typeof cObj.text === "string") {
            const obj = tryParseJson(cObj.text);
            if (!obj) continue;
            if (Array.isArray(obj)) return obj.filter(isMcpRow);
            if (typeof obj === "object" && obj !== null) {
              const objResults = (obj as { results?: unknown }).results;
              if (Array.isArray(objResults)) return objResults.filter(isMcpRow);
              const sc2 = (obj as { structuredContent?: unknown }).structuredContent;
              if (sc2 && typeof sc2 === "object") {
                const sc2Obj = sc2 as { results?: unknown };
                if (Array.isArray(sc2Obj.results)) return sc2Obj.results.filter(isMcpRow);
              }
            }
          }
        }
      }
    }
  }

  return [];
}

async function callSplunkMcp(query: string, earliest_time: string, latest_time: string, row_limit: number) {
  const { endpoint, token } = resolveSplunkMcpConfig();
  const dispatcher = undiciDispatcherFor(endpoint);

  const payload = {
    jsonrpc: "2.0",
    id: 200,
    method: "tools/call",
    params: { name: "run_splunk_query", arguments: { query, earliest_time, latest_time, row_limit } },
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // @ts-expect-error undici dispatcher is not yet in the standard fetch typings.
    dispatcher,
  });

  const text = await resp.text();
  const json = tryParseJson(text);

  if (!resp.ok) {
    const bodyPreview = text ? text.slice(0, 800) : "";
    throw new Error(`Splunk MCP HTTP ${resp.status}: ${bodyPreview}`);
  }
  if (!json || typeof json !== "object") return [];
  const result = (json as { result?: unknown }).result;
  if (!result) return [];
  return extractResultsFromMcpResult(result);
}

function escapeSplString(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractJsonObjectLoose(text: string): unknown | null {
  const t = String(text ?? "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return null;
  const slice = t.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function extractTagTokens(userMsg: string): string[] {
  const s = String(userMsg ?? "");
  const out = new Set<string>();
  const re1 = /attack\.t\d{4}(?:\.\d{3})?/gi;
  const re2 = /nist\.[a-z0-9._-]+/gi;
  for (const m of s.match(re1) || []) out.add(m.toLowerCase());
  for (const m of s.match(re2) || []) out.add(m.toLowerCase());
  return Array.from(out);
}

function userExplicitTagIntent(userMsg: string): boolean {
  const s = String(userMsg ?? "").toLowerCase();
  if (s.includes("mitre") || s.includes("att&ck") || s.includes("attack.")) return true;
  if (s.includes("nist")) return true;
  return extractTagTokens(userMsg).length > 0;
}

function containsNetworkActivityIntent(userMsg: string): boolean {
  const s = String(userMsg ?? "").toLowerCase();
  if (s.includes("network activity")) return true;
  if (s.includes("egress") || s.includes("ingress")) return true;
  if (/\u7f51\u7edc/.test(userMsg)) return true;
  return false;
}

function normalizeOutputs(rawOutputs: unknown): OutputSpec[] {
  const outputsIn = Array.isArray(rawOutputs) ? rawOutputs : [];
  const allowedKind = new Set(["none", "single", "table", "bar", "pie", "line"]);
  const allowedTemplate = new Set(["count", "table", "count_by", "trend"]);
  const allowedGroup = new Set(["Severity", "node_pod_container", "recent_network_activity", "tag"]);
  const allowedSplit = new Set(["none", "severity"]);

  const out: OutputSpec[] = [];
  for (const o of outputsIn) {
    const kind = allowedKind.has(String((o as { kind?: unknown })?.kind)) ? (String((o as { kind?: unknown }).kind) as VizKind) : "none";
    const template = allowedTemplate.has(String((o as { template?: unknown })?.template))
      ? (String((o as { template?: unknown }).template) as Template)
      : "table";
    const rawTitle = (o as { title?: unknown })?.title;
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : "Result";

    const spec: OutputSpec = { kind, template, title };

    if (template === "count_by") {
      spec.group_by = allowedGroup.has(String((o as { group_by?: unknown })?.group_by))
        ? (String((o as { group_by?: unknown }).group_by) as GroupBy)
        : "Severity";
      spec.limit = clampInt((o as { limit?: unknown })?.limit, 3, 50, 10);
      if (spec.kind !== "bar" && spec.kind !== "pie") spec.kind = "bar";
    }

    if (template === "trend") {
      const rawSpan = (o as { span?: unknown })?.span;
      spec.span = typeof rawSpan === "string" && rawSpan.trim() ? rawSpan.trim() : "5m";
      spec.split = allowedSplit.has(String((o as { split?: unknown })?.split))
        ? (String((o as { split?: unknown }).split) as "none" | "severity")
        : "none";
      spec.kind = "line";
    }

    if (template === "count") spec.kind = "single";
    if (template === "table") {
      spec.kind = "table";
      spec.limit = clampInt((o as { limit?: unknown })?.limit, 5, 200, 50);
    }

    out.push(spec);
  }
  return out;
}

function normalizePlan(raw: unknown, userMsg: string): Plan {
  const lang = detectLanguage(userMsg);

  const rawEarliest = (raw as { earliest_time?: unknown })?.earliest_time;
  const earliest_time =
    typeof rawEarliest === "string" && rawEarliest.trim()
      ? rawEarliest.trim()
      : process.env.DEFAULT_EARLIEST_TIME || "-15m";
  const rawLatest = (raw as { latest_time?: unknown })?.latest_time;
  const latest_time =
    typeof rawLatest === "string" && rawLatest.trim()
      ? rawLatest.trim()
      : process.env.DEFAULT_LATEST_TIME || "now";

  const f: Filters = {};

  const rf = (raw as { filters?: unknown })?.filters ?? {};

  const sevRaw =
    typeof rf === "object" && rf !== null ? ((rf as { severity_exact?: unknown; severity?: unknown }).severity_exact ?? (rf as { severity?: unknown }).severity) : undefined;
  if (Array.isArray(sevRaw)) {
    const cleaned = sevRaw
      .map((x) => String(x || "").trim().toUpperCase())
      .filter((x: string) => x === "CRITICAL" || x === "WARNING" || x === "INFO");
    if (cleaned.length) f.severity_exact = cleaned as Array<"CRITICAL" | "WARNING" | "INFO">;
  }

  const rawDescription = (rf as { description_like?: unknown }).description_like;
  if (typeof rawDescription === "string" && rawDescription.trim()) f.description_like = rawDescription.trim();
  const rawDetails = (rf as { details_like?: unknown }).details_like;
  if (typeof rawDetails === "string" && rawDetails.trim()) f.details_like = rawDetails.trim();
  const rawNode = (rf as { node_like?: unknown }).node_like;
  if (typeof rawNode === "string" && rawNode.trim()) f.node_like = rawNode.trim();

  if (typeof (rf as { has_network_activity?: unknown }).has_network_activity === "boolean")
    f.has_network_activity = (rf as { has_network_activity: boolean }).has_network_activity;

  if (Array.isArray((rf as { tags_exact?: unknown }).tags_exact)) {
    const cleaned = ((rf as { tags_exact?: unknown[] }).tags_exact ?? [])
      .map((x) => String(x || "").trim().toLowerCase())
      .filter((x: string) => /^[a-z0-9._-]+$/.test(x));
    if (cleaned.length) f.tags_exact = cleaned;
  }

  const outputs = normalizeOutputs((raw as { outputs?: unknown })?.outputs);

  return { language: lang, earliest_time, latest_time, filters: f, outputs };
}

function ensureGuardrails(plan: Plan, userMsg: string) {
  plan.language = detectLanguage(userMsg);

  const tokens = extractTagTokens(userMsg);
  if (!userExplicitTagIntent(userMsg) || tokens.length === 0) {
    delete plan.filters.tags_exact;
  } else {
    plan.filters.tags_exact = tokens;
  }

  if (containsNetworkActivityIntent(userMsg) && typeof plan.filters.has_network_activity !== "boolean") {
    plan.filters.has_network_activity = true;
  }

  if (!Array.isArray(plan.outputs) || plan.outputs.length === 0) {
    plan.outputs = [{ kind: "table", title: "Events", template: "table", limit: 50 }];
  }

  const meaningful = plan.outputs.some((o) => o.kind !== "none");
  if (!meaningful) {
    plan.outputs = [{ kind: "table", title: "Events", template: "table", limit: 50 }];
  }

  plan.outputs = plan.outputs.slice(0, 4);
}

const OBSERVABILITY_ALLOWED_TIMES = new Set(["-15m", "-30m", "-60m"]);
const OBSERVABILITY_ALLOWED_MCPS = new Set<ObservabilityMcp>(["grafana", "hubble", "ndi"]);
const OBSERVABILITY_ALLOWED_TOOLS = new Set<ObservabilityTool>([
  "query_dashboard_timeseries",
  "fetch_flow_metrics",
  "fetch_anomalies",
]);
const OBSERVABILITY_ALLOWED_TARGETS = new Set<ObservabilityTarget>([
  "hubble-l7-http-metrics-by-workload",
  "nvidia-dcgm-exporter-dashboard",
  "vllm-dashboard",
  "ai-serving/foundation-instruct-vllm",
  "fdtn-ai/Foundation-Sec-8B-Instruct",
  "default-cluster",
]);
const OBSERVABILITY_ALLOWED_METRICS = new Set<ObservabilityMetric>([
  "success_count_per_minute",
  "success_rate",
  "gpu_utilization",
  "policy_drop_flows",
  "anomaly_events",
]);
const OBSERVABILITY_ALLOWED_VIZ = new Set<ObservabilityViz>(["line", "network"]);

function isAllowedObservabilityCombo(req: ObservabilityRequest): boolean {
  if (req.mcp === "grafana") {
    if (req.tool !== "query_dashboard_timeseries" || req.viz !== "line") return false;
    if (req.target === "vllm-dashboard" && req.metric === "success_count_per_minute") return true;
    if (req.target === "hubble-l7-http-metrics-by-workload" && req.metric === "success_rate") return true;
    if (req.target === "nvidia-dcgm-exporter-dashboard" && req.metric === "gpu_utilization") return true;
    return false;
  }
  if (req.mcp === "hubble") {
    return req.tool === "fetch_flow_metrics" && req.viz === "network" && req.target === "ai-serving/foundation-instruct-vllm" && req.metric === "policy_drop_flows";
  }
  return (
    req.mcp === "ndi" &&
    req.tool === "fetch_anomalies" &&
    req.viz === "network" &&
    req.target === "default-cluster" &&
    req.metric === "anomaly_events"
  );
}

function normalizeObservabilityPlan(raw: unknown, userMsg: string): ObservabilityPlan {
  const lang = detectLanguage(userMsg);
  const earliest_time =
    typeof (raw as { earliest_time?: unknown })?.earliest_time === "string" &&
    OBSERVABILITY_ALLOWED_TIMES.has((raw as { earliest_time: string }).earliest_time)
      ? (raw as { earliest_time: string }).earliest_time
      : "-15m";
  const latest_time = (raw as { latest_time?: unknown })?.latest_time === "now" ? "now" : "now";

  const requestsIn = Array.isArray((raw as { requests?: unknown })?.requests) ? ((raw as { requests: unknown[] }).requests as unknown[]) : [];
  const requests: ObservabilityRequest[] = [];

  for (const r of requestsIn) {
    const reqObj = (r ?? {}) as {
      mcp?: unknown;
      tool?: unknown;
      target?: unknown;
      metric?: unknown;
      viz?: unknown;
      title?: unknown;
    };
    const mcp = OBSERVABILITY_ALLOWED_MCPS.has(reqObj.mcp as ObservabilityMcp) ? (reqObj.mcp as ObservabilityMcp) : null;
    const tool = OBSERVABILITY_ALLOWED_TOOLS.has(reqObj.tool as ObservabilityTool) ? (reqObj.tool as ObservabilityTool) : null;
    const target = OBSERVABILITY_ALLOWED_TARGETS.has(reqObj.target as ObservabilityTarget) ? (reqObj.target as ObservabilityTarget) : null;
    const metric = OBSERVABILITY_ALLOWED_METRICS.has(reqObj.metric as ObservabilityMetric) ? (reqObj.metric as ObservabilityMetric) : null;
    const viz = OBSERVABILITY_ALLOWED_VIZ.has(reqObj.viz as ObservabilityViz) ? (reqObj.viz as ObservabilityViz) : null;
    const title = typeof reqObj.title === "string" && reqObj.title.trim() ? reqObj.title.trim() : "Observability";

    if (!mcp || !tool || !target || !metric || !viz) continue;
    const req: ObservabilityRequest = { mcp, tool, target, metric, viz, title };
    if (!isAllowedObservabilityCombo(req)) continue;
    requests.push(req);
  }

  return { language: lang, earliest_time, latest_time, requests: requests.slice(0, 3) };
}

function fallbackObservabilityPlan(userMsg: string): ObservabilityPlan {
  const lang = detectLanguage(userMsg);
  const earliest_time = "-15m";
  const latest_time = "now";
  const s = userMsg.toLowerCase();
  const isAnomaly = s.includes("\u901a\u4fe1\u5f02\u5e38") || s.includes("anomaly") || s.includes("abnormal") || s.includes("drop");

  if (isAnomaly) {
    return {
      language: lang,
      earliest_time,
      latest_time,
      requests: [
        {
          mcp: "hubble",
          tool: "fetch_flow_metrics",
          target: "ai-serving/foundation-instruct-vllm",
          metric: "policy_drop_flows",
          viz: "network",
          title: lang === "zh" ? "\u901a\u4fe1\u5f02\u5e38\u62d3\u6251" : "Communication anomaly topology",
        },
        {
          mcp: "ndi",
          tool: "fetch_anomalies",
          target: "default-cluster",
          metric: "anomaly_events",
          viz: "network",
          title: lang === "zh" ? "\u4f4e\u5c42\u7f51\u7edc\u5f02\u5e38" : "Underlay anomalies",
        },
      ],
    };
  }

  const isSuccessRate = s.includes("\u6210\u529f\u7387") || s.includes("success rate");
  if (isSuccessRate) {
    return {
      language: lang,
      earliest_time,
      latest_time,
      requests: [
        {
          mcp: "grafana",
          tool: "query_dashboard_timeseries",
          target: "hubble-l7-http-metrics-by-workload",
          metric: "success_rate",
          viz: "line",
          title: lang === "zh" ? "\u6210\u529f\u7387\u8d8b\u52bf" : "Success rate trend",
        },
      ],
    };
  }

  const isGpu = s.includes("gpu");
  if (isGpu) {
    return {
      language: lang,
      earliest_time,
      latest_time,
      requests: [
        {
          mcp: "grafana",
          tool: "query_dashboard_timeseries",
          target: "nvidia-dcgm-exporter-dashboard",
          metric: "gpu_utilization",
          viz: "line",
          title: lang === "zh" ? "GPU\u5229\u7528\u7387\u8d8b\u52bf" : "GPU utilization trend",
        },
      ],
    };
  }

  return {
    language: lang,
    earliest_time,
    latest_time,
    requests: [
      {
        mcp: "grafana",
        tool: "query_dashboard_timeseries",
        target: "vllm-dashboard",
        metric: "success_count_per_minute",
        viz: "line",
        title: lang === "zh" ? "vLLM\u6210\u529f\u6b21\u6570\u8d8b\u52bf" : "vLLM success count trend",
      },
    ],
  };
}

function detectObservabilityIntent(userMsg: string): ObservabilityIntent {
  const s = userMsg.toLowerCase();
  if (s.includes("\u901a\u4fe1\u5f02\u5e38") || s.includes("anomaly") || s.includes("abnormal") || s.includes("drop")) return "anomaly";
  if (s.includes("\u6210\u529f\u7387") || s.includes("success rate")) return "success_rate";
  if (s.includes("gpu")) return "gpu";
  if (s.includes("\u6210\u529f\u6b21\u6570") || s.includes("success count")) return "success_count";
  return "unknown";
}

function buildObservabilityRequest(
  intent: ObservabilityIntent,
  lang: "en" | "zh",
): ObservabilityRequest[] {
  if (intent === "anomaly") {
    return [
      {
        mcp: "hubble",
        tool: "fetch_flow_metrics",
        target: "ai-serving/foundation-instruct-vllm",
        metric: "policy_drop_flows",
        viz: "network",
        title: lang === "zh" ? "\u901a\u4fe1\u5f02\u5e38\u62d3\u6251" : "Communication anomaly topology",
      },
      {
        mcp: "ndi",
        tool: "fetch_anomalies",
        target: "default-cluster",
        metric: "anomaly_events",
        viz: "network",
        title: lang === "zh" ? "\u4f4e\u5c42\u7f51\u7edc\u5f02\u5e38" : "Underlay anomalies",
      },
    ];
  }
  if (intent === "success_rate") {
    return [
      {
        mcp: "grafana",
        tool: "query_dashboard_timeseries",
        target: "hubble-l7-http-metrics-by-workload",
        metric: "success_rate",
        viz: "line",
        title: lang === "zh" ? "\u6210\u529f\u7387\u8d8b\u52bf" : "Success rate trend",
      },
    ];
  }
  if (intent === "gpu") {
    return [
      {
        mcp: "grafana",
        tool: "query_dashboard_timeseries",
        target: "nvidia-dcgm-exporter-dashboard",
        metric: "gpu_utilization",
        viz: "line",
        title: lang === "zh" ? "GPU\u5229\u7528\u7387\u8d8b\u52bf" : "GPU utilization trend",
      },
    ];
  }
  return [
    {
      mcp: "grafana",
      tool: "query_dashboard_timeseries",
      target: "vllm-dashboard",
      metric: "success_count_per_minute",
      viz: "line",
      title: lang === "zh" ? "vLLM\u6210\u529f\u6b21\u6570\u8d8b\u52bf" : "vLLM success count trend",
    },
  ];
}

function enforceObservabilityIntent(plan: ObservabilityPlan, userMsg: string): ObservabilityPlan {
  const intent = detectObservabilityIntent(userMsg);
  if (intent === "unknown") return plan;
  const requests = buildObservabilityRequest(intent, plan.language);
  return { ...plan, requests };
}

const BASE_SEARCH = [
  '| savedsearch "Event_Table"',
  '| eval _time=strptime(Time,"%Y-%m-%d %H:%M:%S")',
  '| rename "Recent Network Activity" as recent_network_activity "Node: Pod/Container" as node_pod_container',
].join("\n");

function buildFilterPipeline(filters: Filters): string[] {
  const lines: string[] = [];

  if (filters.tags_exact && filters.tags_exact.length > 0) {
    lines.push('| eval __tags=split(Tags, ", ")');
    const ors = filters.tags_exact.map((t) => `mvfind(__tags,"${escapeSplString(t)}")>=0`).join(" OR ");
    lines.push(`| where (${ors})`);
  }

  const clauses: string[] = [];

  if (filters.severity_exact && filters.severity_exact.length > 0) {
    const list = filters.severity_exact.map((s) => `"${escapeSplString(s)}"`).join(",");
    clauses.push(`in(Severity, ${list})`);
  }
  if (filters.description_like && filters.description_like.length > 0) {
    const v = escapeSplString(filters.description_like);
    clauses.push(`like(Description, "%${v}%")`);
  }
  if (filters.details_like && filters.details_like.length > 0) {
    const v = escapeSplString(filters.details_like);
    clauses.push(`like(Details, "%${v}%")`);
  }
  if (filters.node_like && filters.node_like.length > 0) {
    const v = escapeSplString(filters.node_like);
    clauses.push(`like(node_pod_container, "%${v}%")`);
  }
  if (typeof filters.has_network_activity === "boolean") {
    clauses.push(filters.has_network_activity ? `recent_network_activity!="N/A"` : `recent_network_activity="N/A"`);
  }

  if (clauses.length > 0) lines.push(`| where ${clauses.join(" AND ")}`);
  return lines;
}

function splCount(filters: Filters): string {
  const fp = buildFilterPipeline(filters);
  return [BASE_SEARCH, ...fp, "| stats count as value"].join("\n");
}

function splTable(filters: Filters, limit: number): string {
  const n = clampInt(limit, 5, 200, 50);
  const fp = buildFilterPipeline(filters);
  return [
    BASE_SEARCH,
    ...fp,
    "| sort 0 -_time",
    `| head ${n}`,
    "| table Time Severity Description Tags Details recent_network_activity node_pod_container",
    '| rename recent_network_activity as "Recent Network Activity" node_pod_container as "Node: Pod/Container"',
  ].join("\n");
}

function splCountBy(filters: Filters, groupBy: GroupBy, limit: number): string {
  const n = clampInt(limit, 3, 50, 10);
  const fp = buildFilterPipeline(filters);

  if (groupBy === "tag") {
    return [
      BASE_SEARCH,
      ...fp,
      '| eval tag=split(Tags, ", ")',
      "| mvexpand tag",
      "| stats count as count by tag",
      "| sort 0 -count",
      `| head ${n}`,
    ].join("\n");
  }
  if (groupBy === "Severity") {
    return [BASE_SEARCH, ...fp, "| stats count as count by Severity", "| sort 0 -count", `| head ${n}`].join("\n");
  }
  if (groupBy === "node_pod_container") {
    return [BASE_SEARCH, ...fp, "| stats count as count by node_pod_container", "| sort 0 -count", `| head ${n}`].join("\n");
  }
  return [BASE_SEARCH, ...fp, "| stats count as count by recent_network_activity", "| sort 0 -count", `| head ${n}`].join("\n");
}

function splTrend(filters: Filters, span: string, split: "none" | "severity"): string {
  const fp = buildFilterPipeline(filters);
  const bucket = typeof span === "string" && span.trim() ? span.trim() : "5m";

  if (split === "severity") {
    return [
      BASE_SEARCH,
      ...fp,
      `| timechart span=${bucket}`,
      "  count as total",
      '  count(eval(Severity="CRITICAL")) as critical',
      '  count(eval(Severity="WARNING")) as warning',
      '  count(eval(Severity="INFO")) as info',
      '| eval time=strftime(_time,"%H:%M")',
      "| fields time total critical warning info",
    ].join("\n");
  }

  return [
    BASE_SEARCH,
    ...fp,
    `| timechart span=${bucket} count as total`,
    '| eval time=strftime(_time,"%H:%M")',
    "| fields time total",
  ].join("\n");
}

function newPanelId(prefix: string, seq: number) {
  return `${prefix}_${Date.now()}_${seq}`;
}

function plannerSystemPrompt(): string {
  return [
    "You are a fast planner for an IT operations assistant.",
    "Return ONLY one JSON object. No markdown. No extra text.",
    "Do NOT write SPL. Do NOT invent fields. Do NOT invent savedsearch names.",
    "",
    "Data fields and rules:",
    "- _time: time filter only.",
    "- Severity: exact match only (CRITICAL/WARNING/INFO).",
    "- Description: fuzzy substring match only.",
    "- Details: fuzzy substring match only.",
    "- recent_network_activity: either 'N/A' or not 'N/A'.",
    "- node_pod_container: fuzzy substring match only.",
    "- Tags: fixed-format tokens list. Use tags_exact ONLY when user explicitly requests tag filtering or provides explicit tokens like attack.t1611.",
    "",
    "Filter keys you may output (all optional):",
    '- severity_exact: ["CRITICAL","WARNING","INFO"]',
    '- description_like: "substring"',
    '- details_like: "substring"',
    '- node_like: "substring"',
    "- has_network_activity: true|false",
    '- tags_exact: ["attack.t1611","nist.xx.yy"] (ONLY if explicit tokens or explicit tag filtering intent)',
    "",
    "Output panel templates you may choose (1 to 4):",
    '- { "kind":"single", "title":"...", "template":"count" }',
    '- { "kind":"table", "title":"...", "template":"table", "limit":50 }',
    '- { "kind":"bar"|"pie", "title":"...", "template":"count_by", "group_by":"Severity"|"node_pod_container"|"recent_network_activity"|"tag", "limit":10 }',
    '- { "kind":"line", "title":"...", "template":"trend", "span":"5m", "split":"none"|"severity" }',
    "",
    "JSON schema (use double quotes):",
    '{ "earliest_time":"-15m", "latest_time":"now", "filters":{ }, "outputs":[ ] }',
    "",
    "Guidelines:",
    '- If user asks to list/show events, include a table.',
    '- If user asks distribution/statistics, include count_by.',
    '- If user asks trend over time, include trend.',
    "- If uncertain, include a table.",
  ].join("\n");
}

function observabilityPlannerSystemPrompt(): string {
  return [
    "You are a strict planner for the Observability analytics workspace.",
    "Return ONLY one JSON object. No markdown. No extra text.",
    "Choose values ONLY from the allowed options below. Do NOT invent new strings.",
    "",
    "Time range options:",
    '- earliest_time: "-15m" | "-30m" | "-60m"',
    '- latest_time: "now"',
    "",
    "Allowed request fields:",
    '- mcp: "grafana" | "hubble" | "ndi"',
    '- tool: "query_dashboard_timeseries" | "fetch_flow_metrics" | "fetch_anomalies"',
    '- target: "hubble-l7-http-metrics-by-workload" | "nvidia-dcgm-exporter-dashboard" | "vllm-dashboard" | "ai-serving/foundation-instruct-vllm" | "fdtn-ai/Foundation-Sec-8B-Instruct" | "default-cluster"',
    '- metric: "success_count_per_minute" | "success_rate" | "gpu_utilization" | "policy_drop_flows" | "anomaly_events"',
    '- viz: "line" | "network"',
    '- title: short label',
    "",
    "Valid combinations (MUST follow):",
    '1) Grafana: tool="query_dashboard_timeseries", viz="line",',
    '   - target="vllm-dashboard", metric="success_count_per_minute"',
    '   - target="hubble-l7-http-metrics-by-workload", metric="success_rate"',
    '   - target="nvidia-dcgm-exporter-dashboard", metric="gpu_utilization"',
    '2) Hubble: tool="fetch_flow_metrics", viz="network",',
    '   - target="ai-serving/foundation-instruct-vllm", metric="policy_drop_flows"',
    '3) NDI: tool="fetch_anomalies", viz="network",',
    '   - target="default-cluster", metric="anomaly_events"',
    "",
    "Guidance:",
    "- If user asks communication anomalies, return TWO requests: Hubble + NDI.",
    "- If user asks vLLM success count, return Grafana vllm-dashboard.",
    "- If user asks microservice success rate, return Grafana hubble-l7-http-metrics-by-workload.",
    "- If user asks GPU status, return Grafana nvidia-dcgm-exporter-dashboard.",
    "",
    "JSON schema (use double quotes):",
    '{ "earliest_time":"-15m", "latest_time":"now", "requests":[ { "mcp":"grafana", "tool":"query_dashboard_timeseries", "target":"vllm-dashboard", "metric":"success_count_per_minute", "viz":"line", "title":"..." } ] }',
  ].join("\n");
}

function explainerSystemPrompt(lang: "en" | "zh"): string {
  const langLine = lang === "zh" ? "You MUST reply in Simplified Chinese." : "You MUST reply in English.";
  return [
    "You are an IT operations assistant.",
    "Return a Markdown answer.",
    "No <think> blocks.",
    langLine,
    "",
    "Use ONLY the evidence provided. Do NOT invent numbers.",
    "Structure:",
    "1) 2-4 line summary",
    "2) 3-6 bullet key findings with numbers",
    "3) 2-4 bullet next actions",
  ].join("\n");
}

function applyNoThinkIfNeeded(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, disableThinking: boolean) {
  if (!disableThinking) return messages;
  return messages.map((m, idx) => {
    if (idx === messages.length - 1 && m.role === "user") {
      return { ...m, content: `/no_think\n${m.content}` };
    }
    return m;
  });
}

async function callQwenNonStream(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  max_tokens: number,
  timeoutMs: number,
) {
  const url = resolveQwenChatCompletionsUrl();
  const model = process.env.QWEN_MODEL || "Qwen/Qwen3-14B-FP8";
  const dispatcher = undiciDispatcherFor(url);

  const disableThinking = envBool("QWEN_DISABLE_THINKING", true);
  const msgs = applyNoThinkIfNeeded(messages, disableThinking);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages: msgs,
      max_tokens,
      temperature: 0.0,
      top_p: 1.0,
      stream: false,
      enable_thinking: !disableThinking ? true : false,
      chat_template_kwargs: { enable_thinking: !disableThinking ? true : false },
    } satisfies Record<string, unknown>;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // @ts-expect-error undici dispatcher is not yet in the standard fetch typings.
      dispatcher,
    });

    const text = await resp.text();
    const json = tryParseJson(text);

    if (!resp.ok) {
      const preview = text ? text.slice(0, 800) : "";
      throw new Error(`Qwen HTTP ${resp.status}: ${preview}`);
    }

    let content = "";
    if (json && typeof json === "object") {
      const choices = (json as { choices?: unknown }).choices;
      if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const message = (choices[0] as { message?: unknown }).message;
        if (message && typeof message === "object") {
          const raw = (message as { content?: unknown }).content;
          if (typeof raw === "string") content = raw;
        }
      }
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function* callQwenStream(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  max_tokens: number,
  timeoutMs: number,
) {
  const url = resolveQwenChatCompletionsUrl();
  const model = process.env.QWEN_MODEL || "Qwen/Qwen3-14B-FP8";
  const dispatcher = undiciDispatcherFor(url);

  const disableThinking = envBool("QWEN_DISABLE_THINKING", true);
  const msgs = applyNoThinkIfNeeded(messages, disableThinking);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages: msgs,
      max_tokens,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
      enable_thinking: !disableThinking ? true : false,
      chat_template_kwargs: { enable_thinking: !disableThinking ? true : false },
    } satisfies Record<string, unknown>;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // @ts-expect-error undici dispatcher is not yet in the standard fetch typings.
      dispatcher,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const preview = text ? text.slice(0, 800) : "";
      throw new Error(`Qwen HTTP ${resp.status}: ${preview}`);
    }
    if (!resp.body) throw new Error("Qwen stream body missing");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buf.indexOf("\n\n");
        if (idx < 0) break;
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        const lines = chunk.split("\n").map((l) => l.trim());
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          const obj = tryParseJson(payload);
          let content = "";
          if (obj && typeof obj === "object") {
            const choices = (obj as { choices?: unknown }).choices;
            if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
              const delta = (choices[0] as { delta?: unknown }).delta;
              if (delta && typeof delta === "object") {
                const raw = (delta as { content?: unknown }).content;
                if (typeof raw === "string") content = raw;
              }
            }
          }
          if (!content) continue;

          yield String(content);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function buildEvidenceFromPanels(panels: Panel[]) {
  const ev: Array<Record<string, unknown>> = [];
  for (const p of panels) {
    if (p.kind === "single") ev.push({ kind: "single", title: p.title, value: p.value });
    else if (p.kind === "bar" || p.kind === "pie") ev.push({ kind: p.kind, title: p.title, xKey: p.xKey, yKey: p.yKey, top: (p.data || []).slice(0, 10) });
    else if (p.kind === "line") ev.push({ kind: "line", title: p.title, xKey: p.xKey, seriesKeys: p.seriesKeys, tail: (p.data || []).slice(-12) });
    else if (p.kind === "table") ev.push({ kind: "table", title: p.title, columns: p.columns, sample: (p.rows || []).slice(0, 6), totalRows: (p.rows || []).length });
    else if (p.kind === "network") {
      ev.push({
        kind: "network",
        title: p.title,
        rows: (p.rows || []).map((row) => ({
          source: row.source,
          nodes: row.nodes.map((n) => ({ label: n.label, status: n.status })),
          edges: row.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
          stats: row.stats || {},
          annotations: row.annotations || [],
        })),
      });
    }
  }
  return ev;
}

function fallbackMarkdown(lang: "en" | "zh", panels: Panel[]) {
  const single = panels.find((p) => p.kind === "single");
  const cnt = single && "value" in single ? single.value : null;

  if (lang === "zh") {
    const head = cnt != null ? `**\u8fd4\u56de\u6570\u91cf\uff1a${cnt}\u6761**` : `**\u5df2\u8fd4\u56de\u56fe\u8868\u4e0e\u8868\u683c**`;
    return `${head}\n\n\u6a21\u578b\u89e3\u91ca\u9636\u6bb5\u5931\u8d25\uff0c\u4f46 Splunk \u6570\u636e\u9762\u677f\u5df2\u7ecf\u8fd4\u56de\u3002`;
  }

  const headEn = cnt != null ? `**Returned: ${cnt} events**` : `**Charts and tables returned**`;
  return `${headEn}\n\nThe explanation stage failed, but Splunk panels are already returned.`;
}

function normalizeChartData(rows: McpRow[]): ChartDatum[] {
  return rows.map((row) => {
    const out: ChartDatum = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" || typeof value === "number") {
        out[key] = value;
      } else if (value != null) {
        out[key] = String(value);
      }
    }
    return out;
  });
}

function normalizeTableValue(value: unknown): string | number | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value === "string" || typeof value === "number") return value;
  return String(value);
}

function normalizeTableRows(rows: McpRow[], columns: string[]): TableRow[] {
  return rows.map((row) => {
    const out: TableRow = {};
    for (const col of columns) {
      out[col] = normalizeTableValue(row[col]);
    }
    return out;
  });
}

async function runPanels(plan: Plan, pushPanel: (p: Panel) => void) {
  let seq = 0;

  for (const out of plan.outputs) {
    if (out.kind === "none") continue;

    if (out.template === "count") {
      const spl = splCount(plan.filters);
      const rows = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, 5);
      const v = Number((rows?.[0] as McpRow | undefined)?.value ?? 0);
      const p: Panel = { panel_id: newPanelId("p_single", seq++), title: out.title, kind: "single", spl, label: "count", value: v };
      pushPanel(p);
      continue;
    }

    if (out.template === "table") {
      const limit = clampInt(out.limit, 5, 200, 50);
      const spl = splTable(plan.filters, limit);
      const rows = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, limit);
      const columns = ["Time", "Severity", "Description", "Tags", "Details", "Recent Network Activity", "Node: Pod/Container"];
      const p: Panel = {
        panel_id: newPanelId("p_table", seq++),
        title: out.title,
        kind: "table",
        spl,
        columns,
        rows: normalizeTableRows(rows, columns),
      };
      pushPanel(p);
      continue;
    }

    if (out.template === "count_by") {
      const groupBy = out.group_by || "Severity";
      const limit = clampInt(out.limit, 3, 50, 10);
      const spl = splCountBy(plan.filters, groupBy, limit);
      const data = normalizeChartData(await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, limit));

      let xKey = "Severity";
      let drilldownType: "severity" | "tag" | "node" | "net" = "severity";
      if (groupBy === "node_pod_container") {
        xKey = "node_pod_container";
        drilldownType = "node";
      } else if (groupBy === "recent_network_activity") {
        xKey = "recent_network_activity";
        drilldownType = "net";
      } else if (groupBy === "tag") {
        xKey = "tag";
        drilldownType = "tag";
      }

      const kind: "bar" | "pie" = out.kind === "pie" ? "pie" : "bar";
      const p: Panel = { panel_id: newPanelId("p_dist", seq++), title: out.title, kind, spl, xKey, yKey: "count", data, drilldownType };
      pushPanel(p);
      continue;
    }

    if (out.template === "trend") {
      const span = typeof out.span === "string" ? out.span : "5m";
      const split = out.split === "severity" ? "severity" : "none";
      const spl = splTrend(plan.filters, span, split);
      const data = normalizeChartData(await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, 500));
      const seriesKeys = split === "severity" ? ["total", "critical", "warning", "info"] : ["total"];
      const p: Panel = { panel_id: newPanelId("p_trend", seq++), title: out.title, kind: "line", spl, xKey: "time", seriesKeys, data };
      pushPanel(p);
      continue;
    }
  }
}

function formatTimeLabel(date: Date): string {
  return date.toTimeString().slice(0, 5);
}

function buildMinuteSeries(values: number[]) {
  const now = Date.now();
  const start = now - (values.length - 1) * 60 * 1000;
  return values.map((value, idx) => {
    const d = new Date(start + idx * 60 * 1000);
    return { time: formatTimeLabel(d), value };
  });
}

function mockGrafanaSeries(metric: ObservabilityMetric) {
  if (metric === "success_rate") {
    return buildMinuteSeries([100, 100, 98, 95, 92, 85, 75, 60, 45, 30, 20, 10, 5, 2, 0]);
  }
  if (metric === "gpu_utilization") {
    return buildMinuteSeries([42, 45, 48, 50, 55, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76]);
  }
  return buildMinuteSeries([5, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 1, 0, 0, 0]);
}

function mockHubbleRow(): NetworkRow {
  return {
    source: "Hubble MCP (Overlay)",
    nodes: [
      { id: "world", label: "World", status: "ok" },
      { id: "ai-serving/foundation-instruct-vllm", label: "ai-serving/foundation-instruct-vllm", status: "alert" },
    ],
    edges: [{ from: "world", to: "ai-serving/foundation-instruct-vllm", label: "Policy Drop: 20" }],
    stats: { policy_drop: 20 },
  };
}

function mockNdiRow(): NetworkRow {
  const nodes: NetworkNode[] = [
    { id: "world", label: "World", status: "ok" },
    { id: "router-03", label: "Router-03", status: "ok" },
    { id: "leaf-02", label: "Leaf-02", status: "ok" },
    { id: "spine-01", label: "Spine-01", status: "ok" },
    { id: "leaf-01", label: "Leaf-01", status: "ok" },
    { id: "loadbalancer-01", label: "Loadbalancer-01", status: "ok" },
    { id: "leaf01", label: "Leaf01", status: "ok" },
    { id: "spine-02", label: "Spine-02", status: "ok" },
    { id: "leaf-03", label: "Leaf-03", status: "ok" },
    { id: "csco-k8s-03", label: "csco-k8s-03", status: "ok" },
  ];
  const edges: NetworkEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  }
  return {
    source: "NDI MCP (Underlay)",
    nodes,
    edges,
    stats: { anomalies: 0 },
  };
}

async function runObservabilityPanels(plan: ObservabilityPlan, pushPanel: (p: Panel) => void) {
  let seq = 0;
  const networkRows: NetworkRow[] = [];

  for (const req of plan.requests) {
    if (req.viz === "line") {
      const data = mockGrafanaSeries(req.metric);
      const spl = `MCP: Grafana (mock)\nDashboard: ${req.target}\nMetric: ${req.metric}\nRange: ${plan.earliest_time} -> ${plan.latest_time}`;
      const p: Panel = {
        panel_id: newPanelId("p_trend", seq++),
        title: req.title,
        kind: "line",
        spl,
        xKey: "time",
        seriesKeys: ["value"],
        data,
      };
      pushPanel(p);
      continue;
    }

    if (req.viz === "network") {
      if (req.mcp === "hubble") networkRows.push(mockHubbleRow());
      if (req.mcp === "ndi") networkRows.push(mockNdiRow());
    }
  }

  if (networkRows.length > 0) {
    const title =
      plan.language === "zh" ? "\u901a\u4fe1\u5f02\u5e38\uff08Overlay/Underlay\uff09" : "Communication anomalies (Overlay/Underlay)";
    pushPanel({ panel_id: newPanelId("p_net", seq++), title, kind: "network", rows: networkRows });
  }
}

function sseEvent(event: string, dataObj: unknown) {
  const data = JSON.stringify(dataObj);
  return `event: ${event}\ndata: ${data}\n\n`;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultPlan(userMsg: string): Plan {
  const lang = detectLanguage(userMsg);
  const earliest_time = process.env.DEFAULT_EARLIEST_TIME || "-15m";
  const latest_time = process.env.DEFAULT_LATEST_TIME || "now";

  const outputs: OutputSpec[] = [{ kind: "table", title: "Events", template: "table", limit: 50 }];
  if (containsNetworkActivityIntent(userMsg)) {
    outputs.unshift({ kind: "bar", title: "Network Activity", template: "count_by", group_by: "recent_network_activity", limit: 10 });
  } else {
    outputs.unshift({ kind: "bar", title: "Severity", template: "count_by", group_by: "Severity", limit: 10 });
  }

  return { language: lang, earliest_time, latest_time, filters: {}, outputs: outputs.slice(0, 4) };
}

export async function POST(req: Request) {
  const auth = requireAuthIfConfigured(req);
  if (!auth.ok) return auth.resp!;

  const body = (await req.json().catch(() => ({}))) as ClientReq;
  const userMsg = String(body?.message ?? "").trim();
  const stream = body?.stream !== false;
  const workspace = body?.workspace === "observability" ? "observability" : "security";

  if (!userMsg) return new Response(JSON.stringify({ error: "Empty message" }), { status: 400 });
  if (!stream) return new Response(JSON.stringify({ error: "This endpoint expects stream=true" }), { status: 400 });

  const encoder = new TextEncoder();

  const rs = new ReadableStream({
    async start(controller) {
      const write = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      let stage: string = "planning";

      try {
        write("status", { stage });

        const plannerTimeout = clampInt(process.env.PLANNER_TIMEOUT_MS, 2000, 300000, 45000);
        const plannerTokens = clampInt(process.env.PLANNER_MAX_TOKENS, 64, 1500, 256);

        if (workspace === "observability") {
          let plan: ObservabilityPlan | null = null;

          try {
            const plannerRaw = await callQwenNonStream(
              [
                { role: "system", content: observabilityPlannerSystemPrompt() },
                { role: "user", content: userMsg },
              ],
              plannerTokens,
              plannerTimeout,
            );

            const planObj = extractJsonObjectLoose(plannerRaw);
            if (planObj) {
              plan = normalizeObservabilityPlan(planObj, userMsg);
            }
          } catch (e: unknown) {
            const msg = getErrorMessage(e);
            write("status", { stage: "planning_warning", message: msg });
          }

          if (!plan || plan.requests.length === 0) {
            plan = fallbackObservabilityPlan(userMsg);
          }
          plan = enforceObservabilityIntent(plan, userMsg);

          write("plan", plan);

          stage = "querying_mcp";
          write("status", { stage });

          const panels: Panel[] = [];
          await runObservabilityPanels(plan, (p) => {
            panels.push(p);
            write("panel", p);
          });

          stage = "explaining";
          write("status", { stage });

          const evidence = buildEvidenceFromPanels(panels);
          const explainerInput = {
            user: userMsg,
            time: { earliest: plan.earliest_time, latest: plan.latest_time },
            requests: plan.requests,
            evidence,
          };

          const explainerTimeout = clampInt(process.env.EXPLAINER_TIMEOUT_MS, 5000, 300000, 60000);
          const explainerTokens = clampInt(process.env.EXPLAINER_MAX_TOKENS, 128, 3000, 700);

          const sys = explainerSystemPrompt(plan.language);
          const msgs = [
            { role: "system" as const, content: sys },
            { role: "user" as const, content: JSON.stringify(explainerInput) },
          ];

          try {
            for await (const delta of callQwenStream(msgs, explainerTokens, explainerTimeout)) {
              if (delta) write("delta", { text: delta });
            }
            write("done", { llm_ok: true });
          } catch (e: unknown) {
            const msg = getErrorMessage(e);
            const fb = fallbackMarkdown(plan.language, panels);
            write("delta", { text: fb });
            write("done", { llm_ok: false, llm_error: msg });
          }

          controller.close();
          return;
        }

        let plan: Plan | null = null;

        try {
          const plannerRaw = await callQwenNonStream(
            [
              { role: "system", content: plannerSystemPrompt() },
              { role: "user", content: userMsg },
            ],
            plannerTokens,
            plannerTimeout,
          );

          const planObj = extractJsonObjectLoose(plannerRaw);
          if (planObj) {
            plan = normalizePlan(planObj, userMsg);
            ensureGuardrails(plan, userMsg);
          }
        } catch (e: unknown) {
          const msg = getErrorMessage(e);
          write("status", { stage: "planning_warning", message: msg });
        }

        if (!plan) {
          plan = defaultPlan(userMsg);
          ensureGuardrails(plan, userMsg);
        }

        write("plan", plan);

        stage = "querying_splunk";
        write("status", { stage });

        const panels: Panel[] = [];
        await runPanels(plan, (p) => {
          panels.push(p);
          write("panel", p);
        });

        stage = "explaining";
        write("status", { stage });

        const evidence = buildEvidenceFromPanels(panels);
        const explainerInput = {
          user: userMsg,
          time: { earliest: plan.earliest_time, latest: plan.latest_time },
          filters: plan.filters,
          outputs: plan.outputs,
          evidence,
        };

        const explainerTimeout = clampInt(process.env.EXPLAINER_TIMEOUT_MS, 5000, 300000, 60000);
        const explainerTokens = clampInt(process.env.EXPLAINER_MAX_TOKENS, 128, 3000, 700);

        const sys = explainerSystemPrompt(plan.language);
        const msgs = [
          { role: "system" as const, content: sys },
          { role: "user" as const, content: JSON.stringify(explainerInput) },
        ];

        try {
          for await (const delta of callQwenStream(msgs, explainerTokens, explainerTimeout)) {
            if (delta) write("delta", { text: delta });
          }
          write("done", { llm_ok: true });
        } catch (e: unknown) {
          const msg = getErrorMessage(e);
          const fb = fallbackMarkdown(plan.language, panels);
          write("delta", { text: fb });
          write("done", { llm_ok: false, llm_error: msg });
        }

        controller.close();
      } catch (e: unknown) {
        const msg = e instanceof Error && e.name === "AbortError" ? "Request aborted by timeout" : getErrorMessage(e);
        write("error", { stage, message: msg });
        controller.close();
      }
    },
  });

  return new Response(rs, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
