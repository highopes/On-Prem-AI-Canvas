import { Agent } from "undici";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClientReq = {
  message: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  stream?: boolean;
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

type Plan = {
  language: "en" | "zh";
  earliest_time: string;
  latest_time: string;
  filters: Filters;
  outputs: OutputSpec[];
};

type Panel =
  | { panel_id: string; title: string; kind: "single"; spl: string; label: string; value: number }
  | { panel_id: string; title: string; kind: "table"; spl: string; columns: string[]; rows: any[] }
  | {
      panel_id: string;
      title: string;
      kind: "bar" | "pie";
      spl: string;
      xKey: string;
      yKey: string;
      data: any[];
      drilldownType: "severity" | "tag" | "node" | "net";
    }
  | { panel_id: string; title: string; kind: "line"; spl: string; xKey: string; seriesKeys: string[]; data: any[] };

function detectLanguage(msg: string): "en" | "zh" {
  return /[\u4e00-\u9fff]/.test(msg) ? "zh" : "en";
}

function clampInt(n: any, lo: number, hi: number, dflt: number): number {
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

function tryParseJson(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractResultsFromMcpResult(r: any): any[] {
  if (!r) return [];

  const sc = r.structuredContent;
  if (sc) {
    if (Array.isArray(sc.results)) return sc.results;
    if (Array.isArray(sc.data)) return sc.data;
  }

  if (Array.isArray(r.results)) return r.results;

  if (Array.isArray(r.rows) && Array.isArray(r.fields)) {
    return r.rows.map((row: any[]) => {
      const obj: any = {};
      r.fields.forEach((f: string, i: number) => (obj[f] = row?.[i]));
      return obj;
    });
  }

  if (Array.isArray(r.data)) return r.data;

  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c?.type === "json" && Array.isArray(c?.json?.results)) return c.json.results;
      if (c?.type === "text" && typeof c?.text === "string") {
        const obj = tryParseJson(c.text);
        if (!obj) continue;
        if (Array.isArray(obj.results)) return obj.results;
        const sc2 = obj.structuredContent;
        if (sc2 && Array.isArray(sc2.results)) return sc2.results;
        if (Array.isArray(obj)) return obj;
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
    // @ts-ignore
    dispatcher,
  });

  const text = await resp.text();
  const json = tryParseJson(text);

  if (!resp.ok) {
    const bodyPreview = text ? text.slice(0, 800) : "";
    throw new Error(`Splunk MCP HTTP ${resp.status}: ${bodyPreview}`);
  }
  if (!json?.result) return [];
  return extractResultsFromMcpResult(json.result);
}

function escapeSplString(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractJsonObjectLoose(text: string): any | null {
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

function normalizeOutputs(rawOutputs: any): OutputSpec[] {
  const outputsIn = Array.isArray(rawOutputs) ? rawOutputs : [];
  const allowedKind = new Set(["none", "single", "table", "bar", "pie", "line"]);
  const allowedTemplate = new Set(["count", "table", "count_by", "trend"]);
  const allowedGroup = new Set(["Severity", "node_pod_container", "recent_network_activity", "tag"]);
  const allowedSplit = new Set(["none", "severity"]);

  const out: OutputSpec[] = [];
  for (const o of outputsIn) {
    const kind = allowedKind.has(String(o?.kind)) ? (String(o.kind) as VizKind) : "none";
    const template = allowedTemplate.has(String(o?.template)) ? (String(o.template) as Template) : "table";
    const title = typeof o?.title === "string" && o.title.trim() ? o.title.trim() : "Result";

    const spec: OutputSpec = { kind, template, title };

    if (template === "count_by") {
      spec.group_by = allowedGroup.has(String(o?.group_by)) ? (String(o.group_by) as GroupBy) : "Severity";
      spec.limit = clampInt(o?.limit, 3, 50, 10);
      if (spec.kind !== "bar" && spec.kind !== "pie") spec.kind = "bar";
    }

    if (template === "trend") {
      spec.span = typeof o?.span === "string" && o.span.trim() ? o.span.trim() : "5m";
      spec.split = allowedSplit.has(String(o?.split)) ? (String(o.split) as any) : "none";
      spec.kind = "line";
    }

    if (template === "count") spec.kind = "single";
    if (template === "table") {
      spec.kind = "table";
      spec.limit = clampInt(o?.limit, 5, 200, 50);
    }

    out.push(spec);
  }
  return out;
}

function normalizePlan(raw: any, userMsg: string): Plan {
  const lang = detectLanguage(userMsg);

  const earliest_time =
    typeof raw?.earliest_time === "string" && raw.earliest_time.trim()
      ? raw.earliest_time.trim()
      : process.env.DEFAULT_EARLIEST_TIME || "-15m";
  const latest_time =
    typeof raw?.latest_time === "string" && raw.latest_time.trim()
      ? raw.latest_time.trim()
      : process.env.DEFAULT_LATEST_TIME || "now";

  const f: Filters = {};

  const rf = raw?.filters ?? {};

  const sevRaw = rf.severity_exact ?? rf.severity;
  if (Array.isArray(sevRaw)) {
    const cleaned = sevRaw
      .map((x: any) => String(x || "").trim().toUpperCase())
      .filter((x: string) => x === "CRITICAL" || x === "WARNING" || x === "INFO");
    if (cleaned.length) f.severity_exact = cleaned as any;
  }

  if (typeof rf.description_like === "string" && rf.description_like.trim()) f.description_like = rf.description_like.trim();
  if (typeof rf.details_like === "string" && rf.details_like.trim()) f.details_like = rf.details_like.trim();
  if (typeof rf.node_like === "string" && rf.node_like.trim()) f.node_like = rf.node_like.trim();

  if (typeof rf.has_network_activity === "boolean") f.has_network_activity = rf.has_network_activity;

  if (Array.isArray(rf.tags_exact)) {
    const cleaned = rf.tags_exact
      .map((x: any) => String(x || "").trim().toLowerCase())
      .filter((x: string) => /^[a-z0-9._-]+$/.test(x));
    if (cleaned.length) f.tags_exact = cleaned;
  }

  const outputs = normalizeOutputs(raw?.outputs);

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
    const body: any = {
      model,
      messages: msgs,
      max_tokens,
      temperature: 0.0,
      top_p: 1.0,
      stream: false,
      enable_thinking: !disableThinking ? true : false,
      chat_template_kwargs: { enable_thinking: !disableThinking ? true : false },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // @ts-ignore
      dispatcher,
    });

    const text = await resp.text();
    const json = tryParseJson(text);

    if (!resp.ok) {
      const preview = text ? text.slice(0, 800) : "";
      throw new Error(`Qwen HTTP ${resp.status}: ${preview}`);
    }

    const content = String(json?.choices?.[0]?.message?.content ?? "");
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
    const body: any = {
      model,
      messages: msgs,
      max_tokens,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
      enable_thinking: !disableThinking ? true : false,
      chat_template_kwargs: { enable_thinking: !disableThinking ? true : false },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // @ts-ignore
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
          const delta = obj?.choices?.[0]?.delta;

          const content = delta?.content ?? "";
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
  const ev: any[] = [];
  for (const p of panels) {
    if (p.kind === "single") ev.push({ kind: "single", title: p.title, value: p.value });
    else if (p.kind === "bar" || p.kind === "pie") ev.push({ kind: p.kind, title: p.title, xKey: p.xKey, yKey: p.yKey, top: (p.data || []).slice(0, 10) });
    else if (p.kind === "line") ev.push({ kind: "line", title: p.title, xKey: p.xKey, seriesKeys: p.seriesKeys, tail: (p.data || []).slice(-12) });
    else if (p.kind === "table") ev.push({ kind: "table", title: p.title, columns: p.columns, sample: (p.rows || []).slice(0, 6), totalRows: (p.rows || []).length });
  }
  return ev;
}

function fallbackMarkdown(lang: "en" | "zh", panels: Panel[]) {
  const single = panels.find((p) => p.kind === "single") as any;
  const cnt = single?.value ?? null;

  if (lang === "zh") {
    const head = cnt != null ? `**\u8fd4\u56de\u6570\u91cf\uff1a${cnt}\u6761**` : `**\u5df2\u8fd4\u56de\u56fe\u8868\u4e0e\u8868\u683c**`;
    return `${head}\n\n\u6a21\u578b\u89e3\u91ca\u9636\u6bb5\u5931\u8d25\uff0c\u4f46 Splunk \u6570\u636e\u9762\u677f\u5df2\u7ecf\u8fd4\u56de\u3002`;
  }

  const headEn = cnt != null ? `**Returned: ${cnt} events**` : `**Charts and tables returned**`;
  return `${headEn}\n\nThe explanation stage failed, but Splunk panels are already returned.`;
}

async function runPanels(plan: Plan, pushPanel: (p: Panel) => void) {
  let seq = 0;

  for (const out of plan.outputs) {
    if (out.kind === "none") continue;

    if (out.template === "count") {
      const spl = splCount(plan.filters);
      const rows = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, 5);
      const v = Number(rows?.[0]?.value ?? 0);
      const p: Panel = { panel_id: newPanelId("p_single", seq++), title: out.title, kind: "single", spl, label: "count", value: v };
      pushPanel(p);
      continue;
    }

    if (out.template === "table") {
      const limit = clampInt(out.limit, 5, 200, 50);
      const spl = splTable(plan.filters, limit);
      const rows = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, limit);
      const columns = ["Time", "Severity", "Description", "Tags", "Details", "Recent Network Activity", "Node: Pod/Container"];
      const p: Panel = { panel_id: newPanelId("p_table", seq++), title: out.title, kind: "table", spl, columns, rows };
      pushPanel(p);
      continue;
    }

    if (out.template === "count_by") {
      const groupBy = out.group_by || "Severity";
      const limit = clampInt(out.limit, 3, 50, 10);
      const spl = splCountBy(plan.filters, groupBy, limit);
      const data = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, limit);

      let xKey = "Severity";
      let drilldownType: any = "severity";
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

      const kind: any = out.kind === "pie" ? "pie" : "bar";
      const p: Panel = { panel_id: newPanelId("p_dist", seq++), title: out.title, kind, spl, xKey, yKey: "count", data, drilldownType };
      pushPanel(p);
      continue;
    }

    if (out.template === "trend") {
      const span = typeof out.span === "string" ? out.span : "5m";
      const split = out.split === "severity" ? "severity" : "none";
      const spl = splTrend(plan.filters, span, split);
      const data = await callSplunkMcp(spl, plan.earliest_time, plan.latest_time, 500);
      const seriesKeys = split === "severity" ? ["total", "critical", "warning", "info"] : ["total"];
      const p: Panel = { panel_id: newPanelId("p_trend", seq++), title: out.title, kind: "line", spl, xKey: "time", seriesKeys, data };
      pushPanel(p);
      continue;
    }
  }
}

function sseEvent(event: string, dataObj: any) {
  const data = JSON.stringify(dataObj);
  return `event: ${event}\ndata: ${data}\n\n`;
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

  if (!userMsg) return new Response(JSON.stringify({ error: "Empty message" }), { status: 400 });
  if (!stream) return new Response(JSON.stringify({ error: "This endpoint expects stream=true" }), { status: 400 });

  const encoder = new TextEncoder();

  const rs = new ReadableStream({
    async start(controller) {
      const write = (event: string, data: any) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      let stage: string = "planning";

      try {
        write("status", { stage });

        const plannerTimeout = clampInt(process.env.PLANNER_TIMEOUT_MS, 2000, 300000, 45000);
        const plannerTokens = clampInt(process.env.PLANNER_MAX_TOKENS, 64, 1500, 256);

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
        } catch (e: any) {
          const msg = String(e?.message || e);
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
        } catch (e: any) {
          const msg = String(e?.message || e);
          const fb = fallbackMarkdown(plan.language, panels);
          write("delta", { text: fb });
          write("done", { llm_ok: false, llm_error: msg });
        }

        controller.close();
      } catch (e: any) {
        const msg = String(e?.name === "AbortError" ? "Request aborted by timeout" : e?.message || e);
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

