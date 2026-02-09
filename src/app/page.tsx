"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { Moon, Sun, Settings, Trash2, Clipboard, X } from "lucide-react";

type ChatMsg = { id: string; role: "user" | "assistant"; text: string };

type ChartDatum = Record<string, string | number>;
type TableRow = Record<string, string | number | null | undefined>;

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

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function detectLang(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

const CHART_PALETTE = [
  "#60A5FA",
  "#34D399",
  "#FBBF24",
  "#F472B6",
  "#A78BFA",
  "#22D3EE",
  "#FB7185",
  "#F97316",
];

function stageLabel(stage: string, lang: "zh" | "en") {
  const zh: Record<string, string> = {
    planning: "\u6b63\u5728\u89c4\u5212\u8f93\u51fa...",
    querying_splunk: "\u6b63\u5728\u67e5\u8be2 Splunk...",
    querying_mcp: "\u6b63\u5728\u67e5\u8be2 MCP...",
    explaining: "\u6b63\u5728\u751f\u6210\u89e3\u91ca...",
    planning_warning: "\u89c4\u5212\u8b66\u544a\uff0c\u5df2\u4f7f\u7528\u9ed8\u8ba4\u8ba1\u5212...",
  };
  const en: Record<string, string> = {
    planning: "Planning...",
    querying_splunk: "Querying Splunk...",
    querying_mcp: "Querying MCPs...",
    explaining: "Explaining...",
    planning_warning: "Planning warning, using fallback plan...",
  };
  return (lang === "zh" ? zh : en)[stage] || (lang === "zh" ? "\u5904\u7406\u4e2d..." : "Working...");
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground/80" />
      <div className="animate-pulse">{label}</div>
    </div>
  );
}

function MarkdownBlock({ text, tone }: { text: string; tone: "light" | "dark" }) {
  const baseText = tone === "dark" ? "text-primary-foreground" : "text-foreground";
  const linkText = tone === "dark" ? "text-primary-foreground/90" : "text-muted-foreground";
  const codeBg = tone === "dark" ? "bg-black/20" : "bg-muted";

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className={cn("text-sm leading-6 mb-2", baseText)}>{children}</p>,
        ul: ({ children }) => <ul className={cn("list-disc pl-5 text-sm mb-2", baseText)}>{children}</ul>,
        ol: ({ children }) => <ol className={cn("list-decimal pl-5 text-sm mb-2", baseText)}>{children}</ol>,
        li: ({ children }) => <li className="mb-1">{children}</li>,
        strong: ({ children }) => <strong className={cn("font-semibold", baseText)}>{children}</strong>,
        code: ({ children }) => (
          <code className={cn("rounded px-1 py-0.5 text-xs", codeBg, baseText)}>{children}</code>
        ),
        h1: ({ children }) => <h1 className={cn("text-base font-semibold mb-2", baseText)}>{children}</h1>,
        h2: ({ children }) => <h2 className={cn("text-sm font-semibold mb-2", baseText)}>{children}</h2>,
        hr: () => <hr className="my-3 border-border/80" />,
        a: ({ children, href }) => (
          <a className={cn("underline underline-offset-2", linkText)} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function QueryDetails({ query, label = "Query / MCP" }: { query: string; label?: string }) {
  const s = String(query || "").trim();
  if (!s) return null;

  return (
    <details className="mt-3 rounded-xl border border-border/70 bg-card/60 backdrop-blur">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted-foreground">{label}</summary>
      <pre className="px-3 pb-3 pt-0 text-[11px] leading-5 text-foreground/90 whitespace-pre-wrap break-words">
        {s}
      </pre>
    </details>
  );
}

function IconButton({
  onClick,
  title,
  children,
  variant = "ghost",
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  variant?: "ghost" | "solid";
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center rounded-xl border px-3 py-2 text-sm shadow-sm transition",
        variant === "solid"
          ? "border-transparent bg-primary text-primary-foreground hover:opacity-90"
          : "border-border/70 bg-card/60 text-foreground hover:bg-card/80",
      )}
    >
      {children}
    </button>
  );
}

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 backdrop-blur shadow-xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <button
          onClick={onClose}
          className="h-8 w-8 rounded-xl border border-border/60 bg-card/70 hover:bg-card/90 text-muted-foreground transition"
          aria-label="Close"
          title="Close"
        >
          <X className="h-4 w-4 mx-auto" />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function SinglePanel({ p }: { p: Extract<Panel, { kind: "single" }> }) {
  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-4xl font-bold text-foreground tracking-tight">
            {Number.isFinite(p.value) ? p.value : 0}
          </div>
          <div className="text-xs text-muted-foreground mt-1">{p.label}</div>
        </div>
      </div>
      <QueryDetails query={p.spl} />
    </div>
  );
}

function rechartsTooltipStyle() {
  return {
    backgroundColor: "hsl(var(--card))",
    borderColor: "hsl(var(--border))",
    color: "hsl(var(--foreground))",
    borderRadius: 12,
  } as const;
}

function BarPanel({ p }: { p: Extract<Panel, { kind: "bar" }> }) {
  const data = Array.isArray(p.data) ? p.data : [];
  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 12, right: 18, top: 8, bottom: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="4 4" opacity={0.65} />
            <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <YAxis
              type="category"
              dataKey={p.xKey}
              width={170}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            />
            <Tooltip contentStyle={rechartsTooltipStyle()} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar dataKey={p.yKey} radius={[10, 10, 10, 10]} barSize={16}>
              {data.map((_, idx) => (
                <Cell key={idx} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <QueryDetails query={p.spl} />
    </div>
  );
}

function PiePanel({ p }: { p: Extract<Panel, { kind: "pie" }> }) {
  const data = Array.isArray(p.data) ? p.data : [];
  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip contentStyle={rechartsTooltipStyle()} />
            <Legend wrapperStyle={{ color: "hsl(var(--muted-foreground))" }} />
            <Pie data={data} dataKey={p.yKey} nameKey={p.xKey} outerRadius={110} stroke="hsl(var(--border))">
              {data.map((_, idx) => (
                <Cell key={idx} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <QueryDetails query={p.spl} />
    </div>
  );
}

function LinePanel({ p }: { p: Extract<Panel, { kind: "line" }> }) {
  const data = Array.isArray(p.data) ? p.data : [];
  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ left: 12, right: 18, top: 8, bottom: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="4 4" opacity={0.65} />
            <XAxis dataKey={p.xKey} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <Tooltip contentStyle={rechartsTooltipStyle()} />
            <Legend wrapperStyle={{ color: "hsl(var(--muted-foreground))" }} />
            {p.seriesKeys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                dot={false}
                stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                strokeWidth={2.2}
                opacity={k === "total" ? 1 : 0.95}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <QueryDetails query={p.spl} />
    </div>
  );
}

function TablePanel({ p }: { p: Extract<Panel, { kind: "table" }> }) {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const cols = Array.isArray(p.columns) ? p.columns : [];
  return (
    <div className="w-full">
      <div className="mb-2 text-xs text-muted-foreground">Rows: {rows.length}</div>
      <div className="max-h-80 overflow-auto rounded-xl border border-border/70 bg-card/40">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card/80 backdrop-blur border-b border-border/70">
            <tr>
              {cols.map((c) => (
                <th key={c} className="text-left px-3 py-2 font-semibold text-foreground whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr
                key={idx}
                className={cn(
                  "border-b border-border/40 hover:bg-card/60 transition",
                  idx % 2 === 0 ? "bg-transparent" : "bg-card/20",
                )}
              >
                {cols.map((c) => (
                  <td key={c} className="px-3 py-2 align-top">
                    <div className="break-words whitespace-normal max-w-[380px] text-foreground/90">
                      {String(r?.[c] ?? "")}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <QueryDetails query={p.spl} />
    </div>
  );
}

function NetworkPanel({ p }: { p: Extract<Panel, { kind: "network" }> }) {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const [zoomByRow, setZoomByRow] = useState<Record<string, number>>({});

  return (
    <div className="space-y-6">
      {rows.map((row, idx) => {
        const rowKey = `${row.source}-${idx}`;
        const zoom = zoomByRow[rowKey] ?? 1;
        return (
          <div key={rowKey} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-muted-foreground">{row.source}</div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setZoomByRow((prev) => ({ ...prev, [rowKey]: Math.max(0.6, zoom - 0.1) }))}
                  className="h-6 w-6 rounded-md border border-border/70 bg-card/60 text-sm text-foreground hover:bg-card/80 transition leading-none"
                  aria-label="Zoom out"
                >
                  -
                </button>
                <div className="text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</div>
                <button
                  type="button"
                  onClick={() => setZoomByRow((prev) => ({ ...prev, [rowKey]: Math.min(2, zoom + 0.1) }))}
                  className="h-6 w-6 rounded-md border border-border/70 bg-card/60 text-sm text-foreground hover:bg-card/80 transition leading-none"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            </div>
            <NetworkRowViz row={row} zoom={zoom} />
          </div>
        );
      })}
    </div>
  );
}

function NetworkRowViz({ row, zoom }: { row: NetworkRow; zoom: number }) {
  const nodes = row.nodes || [];
  const edges = row.edges || [];
  const annotations = row.annotations || [];
  const isOverlay = row.source.toLowerCase().includes("hubble");
  const spacing = isOverlay ? 180 : 160;
  const viewWidth = Math.max(420, (nodes.length - 1) * spacing + 240);
  const viewHeight = 240;
  const y = viewHeight / 2;
  const nodeRadius = 14;
  const labelFont = 16;
  const edgeFont = 14;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, idx) => {
    const x = nodes.length === 1 ? viewWidth / 2 : idx * spacing + 100;
    positions.set(node.id, { x, y });
  });

  const scaledWidth = viewWidth / zoom;
  const scaledHeight = viewHeight / zoom;
  const offsetX = (viewWidth - scaledWidth) / 2;
  const offsetY = (viewHeight - scaledHeight) / 2;

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-3 overflow-x-auto">
      <svg viewBox={`${offsetX} ${offsetY} ${scaledWidth} ${scaledHeight}`} style={{ width: viewWidth }} className="h-64">
        {edges.map((edge, idx) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          return (
            <g key={`${edge.from}-${edge.to}-${idx}`}>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="hsl(var(--border))"
                strokeWidth={2}
              />
              {edge.label ? (
                <text x={midX} y={midY - 12} textAnchor="middle" fontSize={edgeFont} fill="hsl(var(--muted-foreground))">
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const fill = node.status === "alert" ? "#ef4444" : "#22c55e";
          return (
            <g key={node.id}>
              <circle cx={pos.x} cy={pos.y} r={nodeRadius} fill={fill} />
              <text
                x={pos.x}
                y={pos.y + 30}
                textAnchor="middle"
                fontSize={labelFont}
                fill="hsl(var(--foreground))"
              >
                {node.label}
              </text>
            </g>
          );
        })}
        {annotations.map((ann, idx) => {
          const pos = positions.get(ann.nodeId);
          if (!pos) return null;
          return (
            <text
              key={`${ann.nodeId}-${idx}`}
              x={pos.x + 6}
              y={pos.y - 14}
              fontSize={12}
              fill="hsl(var(--muted-foreground))"
            >
              {ann.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function parseSseBlocks(buf: string) {
  const parts = buf.split("\n\n");
  const complete = parts.slice(0, -1);
  const rest = parts[parts.length - 1] || "";
  const events: Array<{ event: string; data: unknown }> = [];

  for (const block of complete) {
    const lines = block.split("\n");
    let ev = "message";
    let dataStr = "";
    for (const ln of lines) {
      if (ln.startsWith("event:")) ev = ln.slice(6).trim();
      if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
    }
    if (!dataStr) continue;
    try {
      events.push({ event: ev, data: JSON.parse(dataStr) });
    } catch {
      events.push({ event: ev, data: { text: dataStr } });
    }
  }
  return { events, rest };
}

type TokenStorageMode = "session" | "local";

function getStoredToken(): { token: string; mode: TokenStorageMode } {
  try {
    const modeRaw = localStorage.getItem("ai_canvas_token_mode");
    const localTok = localStorage.getItem("ai_canvas_token") || "";
    const sessTok = sessionStorage.getItem("ai_canvas_token") || "";

    let mode: TokenStorageMode = modeRaw === "local" ? "local" : "session";

    // Backward/robust behavior:
    // If mode is missing but a local token exists, treat it as remembered.
    if (!modeRaw && localTok) mode = "local";

    if (mode === "local") return { token: localTok, mode };
    return { token: sessTok, mode };
  } catch {
    return { token: "", mode: "session" };
  }
}

function storeToken(token: string, mode: TokenStorageMode) {
  try {
    localStorage.setItem("ai_canvas_token_mode", mode);

    const t = (token || "").trim();
    if (!t) {
      clearStoredToken();
      return;
    }

    if (mode === "local") {
      localStorage.setItem("ai_canvas_token", t);
      sessionStorage.removeItem("ai_canvas_token");
    } else {
      sessionStorage.setItem("ai_canvas_token", t);
      localStorage.removeItem("ai_canvas_token");
    }
  } catch {
    // ignore
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem("ai_canvas_token");
    sessionStorage.removeItem("ai_canvas_token");
  } catch {
    // ignore
  }
}

function ConfigModal({
  open,
  onClose,
  onSaveToken,
  onClearToken,
  tokenSet,
  storageMode,
  setStorageMode,
}: {
  open: boolean;
  onClose: () => void;
  onSaveToken: (t: string) => void;
  onClearToken: () => void;
  tokenSet: boolean;
  storageMode: TokenStorageMode;
  setStorageMode: (m: TokenStorageMode) => void;
  }) {
  const [draft, setDraft] = useState("");

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      setDraft((t || "").trim());
    } catch {
      // ignore
    }
  }

  function handleClose() {
    setDraft("");
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border/70 bg-card/80 backdrop-blur shadow-2xl">
        <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Config</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Access token is not displayed. You can paste a new one or clear the stored token.
            </div>
          </div>
          <button
            onClick={handleClose}
            className="h-9 w-9 rounded-xl border border-border/60 bg-card/70 hover:bg-card/90 text-muted-foreground transition"
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4 mx-auto" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-xl border border-border/70 bg-card/50 p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground">Access Token</div>
              <div className={cn("text-xs", tokenSet ? "text-foreground" : "text-muted-foreground")}>
                {tokenSet ? "Stored: set" : "Stored: not set"}
              </div>
            </div>

            <div className="mt-2 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Paste new token here"
                type="password"
                autoComplete="off"
                spellCheck={false}
                onCopy={(e) => e.preventDefault()}
                className="w-full rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/50"
              />
              <button
                onClick={pasteFromClipboard}
                className="shrink-0 rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-sm text-foreground hover:bg-card/80 transition"
                title="Paste from clipboard"
                aria-label="Paste from clipboard"
              >
                <Clipboard className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Storage:</span>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    checked={storageMode === "session"}
                    onChange={() => setStorageMode("session")}
                  />
                  <span>Session</span>
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input type="radio" checked={storageMode === "local"} onChange={() => setStorageMode("local")} />
                  <span>Remember</span>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    onClearToken();
                    setDraft("");
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-sm text-foreground hover:bg-card/80 transition"
                  title="Clear stored token"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear
                </button>

                <button
                  onClick={() => {
                    onSaveToken(draft.trim());
                    setDraft("");
                  }}
                  disabled={!draft.trim()}
                  className={cn(
                    "rounded-xl px-4 py-2 text-sm font-semibold transition",
                    draft.trim()
                      ? "bg-primary text-primary-foreground hover:opacity-90"
                      : "bg-muted text-muted-foreground cursor-not-allowed",
                  )}
                >
                  Save
                </button>
              </div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            Tip: if clipboard paste does not work (browser permissions), click the input and paste with keyboard.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("planning");

  // Token storage: load once on client, then write only after ready.
  const [storageReady, setStorageReady] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [tokenMode, setTokenMode] = useState<TokenStorageMode>("session");

  const [configOpen, setConfigOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [workspace, setWorkspace] = useState<"security" | "observability">("security");

  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: uid("a"),
      role: "assistant",
      text:
        "\u8bf7\u7528\u81ea\u7136\u8bed\u8a00\u4e0e\u6211\u4ea4\u6d41\uff0c\u6211\u5c06\u7528\u53ef\u89c6\u5316\u7684\u6570\u636e\u56de\u7b54\u3002\n\nPlease talk to me in natural language, and I will answer with visualized data.\n",
    },
  ]);

  const [panels, setPanels] = useState<Panel[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);

  useEffect(() => {
    const { token, mode } = getStoredToken();
    setAccessToken(token);
    setTokenMode(mode);
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    storeToken(accessToken, tokenMode);
  }, [storageReady, tokenMode, accessToken]);

  const lang = useMemo(
    () => detectLang(messages.filter((m) => m.role === "user").slice(-1)[0]?.text || input),
    [messages, input],
  );

  const promptChips = useMemo(() => {
    if (workspace === "observability") {
      const zh = [
        "vLLM fdtn-ai/Foundation-Sec-8B-Instruct\u572815\u5206\u949f\u5185\u7684\u6210\u529f\u6b21\u6570\u66f2\u7ebf",
        "\u5fae\u670d\u52a1ai-serving/foundation-instruct-vllm\u572815\u5206\u949f\u5185\u7684\u6210\u529f\u7387\u53d8\u5316\u66f2\u7ebf",
        "\u4ece\u5916\u90e8\u4e16\u754c\u5230\u9ed8\u8ba4\u96c6\u7fa4\u5fae\u670d\u52a1ai-serving/foundation-instruct-vllm\u768415\u5206\u949f\u5185\u7684\u901a\u4fe1\u5f02\u5e38",
      ];
      const en = [
        "vLLM fdtn-ai/Foundation-Sec-8B-Instruct success count trend in the last 15 minutes",
        "Microservice ai-serving/foundation-instruct-vllm success rate trend in the last 15 minutes",
        "Communication anomalies from the external world to ai-serving/foundation-instruct-vllm in the default cluster over the last 15 minutes",
      ];
      return [zh[0], en[0], zh[1], en[1], zh[2], en[2]];
    }

    const zh = [
      "\u6700\u8fd130\u5206\u949f\u5404\u7c7b\u544a\u8b66\u968f\u65f6\u95f4\u7684\u53d8\u5316\u66f2\u7ebf",
      "\u6bd4\u8f83\u6700\u8fd115\u5206\u949f\u7684\u5404\u4e2a\u8282\u70b9\u7684\u544a\u8b66\u5206\u5e03",
      "\u6700\u8fd110\u5206\u949f\u7f51\u7edc\u6d3b\u52a8\u6700\u591a\u7684\u8282\u70b9\u7684\u7f51\u7edc\u6d3b\u52a8\u5217\u8868",
    ];

    const en = [
      "Time series of alert categories over the last 30 minutes",
      "Compare alert distribution across nodes in the last 15 minutes",
      "List network activity for the node with the most network activity in the last 10 minutes",
    ];

    return [zh[0], en[0], zh[1], en[1], zh[2], en[2]];
  }, [workspace]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMsg = { id: uid("u"), role: "user", text };
    const assistantId = uid("a");
    const assistantStub: ChatMsg = { id: assistantId, role: "assistant", text: "" };

    setMessages((prev) => [...prev, userMsg, assistantStub]);
    setInput("");
    setLoading(true);
    setStage("planning");

    const history = messages.map((m) => ({ role: m.role, text: m.text }));

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text, history, stream: true, workspace }),
      });

      if (resp.status === 401) {
        setConfigOpen(true);
        throw new Error("Unauthorized (401).");
      }

      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }

      if (!resp.body) throw new Error("Missing response stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        const parsed = parseSseBlocks(buf);
        buf = parsed.rest;

        for (const ev of parsed.events) {
          if (ev.event === "status") {
            const dataObj = ev.data && typeof ev.data === "object" ? (ev.data as { stage?: unknown }) : {};
            const nextStage = String(dataObj.stage || "planning");
            setStage(nextStage);
          } else if (ev.event === "panel") {
            setPanels((prev) => [...prev, ev.data as Panel]);
          } else if (ev.event === "delta") {
            const dataObj = ev.data && typeof ev.data === "object" ? (ev.data as { text?: unknown }) : {};
            const d = String(dataObj.text ?? "");
            if (d) setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + d } : m)));
          } else if (ev.event === "error") {
            const dataObj = ev.data && typeof ev.data === "object" ? (ev.data as { stage?: unknown; message?: unknown }) : {};
            const stageName = String(dataObj.stage || "unknown");
            const msg = String(dataObj.message || "Unknown error");
            throw new Error(`[${stageName}] ${msg}`);
          }
        }

        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 10);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      const errZh = [
        `\u8bf7\u6c42\u5931\u8d25\uff1a${msg}`,
        "",
        msg.includes("401")
          ? "\u8be5\u6f14\u793a\u5df2\u542f\u7528\u8bbf\u95ee\u4fdd\u62a4\uff0c\u8bf7\u5728 Config \u4e2d\u7c98\u8d34 Token\u3002"
          : "\u8bf7\u68c0\u67e5\u540e\u7aef stage \u4ee5\u5b9a\u4f4d planning/querying/explaining \u54ea\u4e00\u6bb5\u5931\u8d25\u3002",
      ].join("\n");

      const errEn = [
        `Request failed: ${msg}`,
        "",
        msg.includes("401")
          ? "This demo is protected. Please paste an access token in Config."
          : "Check backend stage to locate the failing step (planning/querying/explaining).",
      ].join("\n");

      setMessages((prev) =>
        prev.map((m) => (m.role === "assistant" && m.text === "" ? { ...m, text: lang === "zh" ? errZh : errEn } : m)),
      );
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  function closePanel(id: string) {
    setPanels((prev) => prev.filter((p) => p.panel_id !== id));
  }

  function clearPanels() {
    setPanels([]);
  }

  function saveToken(t: string) {
    const v = (t || "").trim();
    if (!v) return;
    setAccessToken(v);
    storeToken(v, tokenMode);
    setConfigOpen(false);
  }

  function clearToken() {
    setAccessToken("");
    clearStoredToken();
  }

  const tokenSet = !!accessToken;

  return (
    <div className="min-h-screen">
      <ConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaveToken={saveToken}
        onClearToken={clearToken}
        tokenSet={tokenSet}
        storageMode={tokenMode}
        setStorageMode={setTokenMode}
      />

      <div className="mx-auto max-w-[1440px] px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-primary text-primary-foreground grid place-items-center shadow">
              <span className="text-sm font-bold">AI</span>
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">AI Canvas On-prem</div>
              <div className="mt-1">
                <label className="sr-only" htmlFor="workspace-select">
                  Workspace
                </label>
                <select
                  id="workspace-select"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value === "observability" ? "observability" : "security")}
                  className="rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-xs text-muted-foreground hover:bg-card/80"
                >
                  <option value="security">Security analytics workspace</option>
                  <option value="observability">Observability analytics workspace</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <IconButton onClick={() => setDark((v) => !v)} title={dark ? "Switch to light" : "Switch to dark"}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              <span className="ml-2 hidden sm:inline">{dark ? "Light" : "Dark"}</span>
            </IconButton>

            <IconButton onClick={clearPanels} title="Clear panels">
              <Trash2 className="h-4 w-4" />
              <span className="ml-2 hidden sm:inline">Clear</span>
            </IconButton>

            <IconButton onClick={() => setConfigOpen(true)} title="Open config">
              <Settings className="h-4 w-4" />
              <span className="ml-2 hidden sm:inline">Config</span>
            </IconButton>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-4">
            <div className="flex h-[720px] flex-col rounded-2xl border border-border/70 bg-card/70 backdrop-blur shadow-xl">
              <div className="px-4 py-3 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-foreground">Chat</div>
                  <div className="text-xs text-muted-foreground">
                    {tokenSet ? "Protected: token set" : "Protected: token not set"}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {promptChips.map((p) => (
                    <button
                      key={p}
                      onClick={() => setInput(p)}
                      className="max-w-full rounded-full border border-border/70 bg-card/50 px-3 py-1 text-xs text-foreground hover:bg-card/80 break-words whitespace-normal text-left transition"
                      title={p}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-auto px-4 py-3">
                {messages.map((m) => {
                  const isUser = m.role === "user";
                  return (
                    <div key={m.id} className={cn("mb-3", isUser ? "text-right" : "text-left")}>
                      <div
                        className={cn(
                          "inline-block max-w-[92%] rounded-2xl px-3 py-2 shadow-sm border",
                          isUser
                            ? "bg-primary text-primary-foreground border-transparent"
                            : "bg-card/60 text-foreground border-border/60",
                        )}
                      >
                        <MarkdownBlock text={m.text || "\u00a0"} tone={isUser ? "dark" : "light"} />
                      </div>
                    </div>
                  );
                })}

                {loading && (
                  <div className="mb-3 text-left">
                    <div className="inline-block rounded-2xl bg-card/60 px-3 py-2 shadow-sm border border-border/60">
                      <Spinner label={stageLabel(stage, lang)} />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <div className="px-4 py-3 border-t border-border/60">
                <div className="flex gap-2">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Ask about alerts, network activity, nodes, tags..."
                    className="w-full rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/50"
                  />
                  <button
                    onClick={send}
                    disabled={loading}
                    className={cn(
                      "rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition",
                      loading
                        ? "bg-muted text-muted-foreground cursor-not-allowed"
                        : "bg-primary text-primary-foreground hover:opacity-90",
                    )}
                  >
                    Send
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <div>Tip: open Config to paste/clear token (token value is hidden).</div>
                  <button
                    onClick={() => setConfigOpen(true)}
                    className="inline-flex items-center gap-2 hover:text-foreground transition"
                    title="Open config"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    <span>Config</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="col-span-12 lg:col-span-8">
            <div className="flex h-[720px] flex-col rounded-2xl border border-border/70 bg-card/70 p-4 shadow-xl backdrop-blur">
              <div className="flex-1 overflow-auto">
                <div className="grid grid-cols-1 gap-4">
                  {panels.map((p) => (
                    <PanelShell key={p.panel_id} title={`${p.title} · ${p.kind}`} onClose={() => closePanel(p.panel_id)}>
                      {p.kind === "single" && <SinglePanel p={p} />}
                      {p.kind === "bar" && <BarPanel p={p} />}
                      {p.kind === "pie" && <PiePanel p={p} />}
                      {p.kind === "line" && <LinePanel p={p} />}
                      {p.kind === "network" && <NetworkPanel p={p} />}
                      {p.kind === "table" && <TablePanel p={p} />}
                    </PanelShell>
                  ))}
                  {panels.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/50 p-10 text-muted-foreground shadow-sm backdrop-blur">
                      No panels yet. Ask a question to generate charts and tables.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 text-xs text-muted-foreground">Designed and Developed by Wei Hang</div>
      </div>
    </div>
  );
}
