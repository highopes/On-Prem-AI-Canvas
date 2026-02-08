# 本地版 AI Canvas 開發說明

## 一、開發目標

- 透過在 MCP Client 端加入可控的規劃與驗證邏輯，讓本地部署的小型語言模型（如 Qwen 系列）能同時支援「資安分析」與「觀測性（Observability）」兩種工作空間，維持 AI Canvas 式互動與可視化體驗。
- 在不依賴大型雲端模型的前提下，確保資料查詢與輸出行為可預期、可管控，並符合企業內部部署與資安要求。

## 二、應用架構與實作原理

### 2.1 框架與技術棧

#### 核心框架

- **Next.js（基於 React）**
  - 可在同一專案中同時實作「網頁前端」與「後端 API」。
  - 前端負責：
    - 使用者介面（UI）
    - 互動行為
    - 圖表與視覺化元件渲染
    - 將後端回傳的資料呈現在畫面上
  - 後端負責：
    - 接收前端請求
    - 依據工作空間（Security / Observability）呼叫 Qwen 進行規劃（Planning）與結果解讀（Explaining）
    - 透過 MCP 介面查詢資料（資安使用 Splunk MCP；觀測性可對接 Grafana / Hubble / NDI 類 MCP）
    - 以串流方式將結果回傳給前端

#### 語言與開發模式

- **TypeScript**
  - 在 JavaScript 基礎上加入型別系統，降低低階錯誤風險，提升可維護性。
- **App Router 架構（`src/app/...`）**
  - 將頁面（Page）與 API Route 統一放在同一目錄結構中，利於模組化與理解整體流程。

#### UI 與視覺化元件

- **Tailwind CSS**
  - 透過 Utility Class 快速完成版型與樣式設計。
- **shadcn/ui**
  - 預先封裝的 UI 元件集合（按鈕、卡片、對話框等），可快速組裝產品級介面。
- **Recharts**
  - 用於實作長條圖、圓餅圖、折線圖等常見資料視覺化。
- **react-markdown + remark-gfm**
  - 將模型輸出的 Markdown 內容渲染為結構化且易讀的富文字。
- **lucide-react**
  - 圖示元件庫（如 Sun / Moon / Settings / Trash / Clipboard 等）。

#### 網路與後端通訊

- **undici**
  - 穩定的 HTTP Client，並可支援自簽憑證（Self-signed HTTPS）的使用情境。
- **HTTP SSE（Server-Sent Events）**
  - 採用 SSE 風格的串流回傳方式，用於：
    - 狀態更新（Planning / Querying / Explaining）
    - 視覺化 Panel 即時渲染
    - 動態文字逐步生成

### 2.2 原理概述

- 瀏覽器端（前端）僅負責顯示與互動，不直接處理資料查詢或推理邏輯。
- 所有核心流程集中於後端 API：
  - 依工作空間決定規劃與查詢邏輯
  - 進行語意規劃與推理
  - 呼叫 MCP 來源取得資料
- 前端透過 `/api/chat` 發起一次分析請求後，後端會將「圖表面板」與「文字解讀」一邊產生、一邊以串流方式回傳。
- 設計上的關鍵取捨在於：
  - **不允許小型模型直接生成 SPL 或任意 MCP 指令**
  - 模型僅輸出結構化的分析計畫（JSON）
  - 後端依固定模板與白名單做查詢與組合  
  → 使整體行為更穩定、可控，並避免模型幻覺（Hallucination）。

## 三、應用實作流程

### 3.1 整體流程

- 使用者於左側 Chat 區輸入自然語言問題
- 在 UI 上切換工作空間（Security / Observability）
- 前端 `page.tsx` 以 `POST /api/chat` 呼叫後端（並攜帶 Access Token 以進行存取控管）
- 後端 `route.ts` 進入三階段處理流程，並即時將狀態回傳前端

### 3.2 後端三階段處理流程

#### （一）Planning：語意規劃階段

- 依工作空間呼叫 Qwen 本地模型，透過提示詞工程（Prompt Engineering）解析使用者意圖
- 產生標準化 JSON，並交由後端做嚴格驗證與修正

**Security（資安）工作空間：**
- JSON 內容包含：
  - 視覺化圖表類型
  - 資料過濾條件
  - 查詢時間範圍
  - 其他分析參數
- 範例如下：

```json
{
  "earliest_time": "-24h@h",
  "latest_time": "now",
  "filters": {
    "severity_exact": ["CRITICAL", "WARNING"],
    "description_contains": ["reverse_shell"],
    "details_contains": ["python", "bash"],
    "node_pod_container_contains": ["csco-k8s-01"],
    "has_network_activity": true
  },
  "outputs": [
    {
      "panel_id": "p1",
      "title": "Severity distribution",
      "template": "count_by",
      "group_by": "severity",
      "chart": "pie",
      "limit": 6
    },
    {
      "panel_id": "p2",
      "title": "Top nodes/containers by event count",
      "template": "count_by",
      "group_by": "node_pod_container",
      "chart": "bar",
      "limit": 10
    },
    {
      "panel_id": "p3",
      "title": "Event trend (split by severity)",
      "template": "trend",
      "span": "5m",
      "split_by": "severity"
    },
    {
      "panel_id": "p4",
      "title": "Recent events (evidence table)",
      "template": "table",
      "limit": 50,
      "columns": [
        "time",
        "severity",
        "node_pod_container",
        "recent_network_activity",
        "description",
        "details",
        "tags"
      ]
    }
  ]
}
```

**Observability（觀測性）工作空間：**
- JSON 內容包含：
  - MCP 類型（Grafana / Hubble / NDI）
  - 工具名稱（如 metrics 查詢或異常事件）
  - 指標與目標服務/儀表板
  - 圖表類型（折線 / 網路拓樸）
  - 查詢時間範圍
- 系統會套用白名單規則，僅允許特定 mcp/tool/metric/target/viz 組合，避免模型產生不可控指令。

#### （二）Querying：Splunk 查詢階段

**Security（資安）工作空間：**
- 後端依據 Planning 產出的 JSON：
  - 套用既定的 SPL 模板
  - 透過 Splunk MCP 拉取資料
- 將查詢結果轉換為多個 Panel：
  - 單值（Single Value）
  - 表格（Table）
  - 長條圖（Bar）
  - 圓餅圖（Pie）
  - 折線圖（Line）

**Observability（觀測性）工作空間：**
- 後端依據 Planning 產出的 JSON：
  - 透過 Grafana / Hubble / NDI 類 MCP 取得指標或網路拓樸資料
  - 依需求產出折線圖或 Overlay/Underlay 網路拓樸面板

#### （三）Explaining：結果解讀階段

- 後端將各 Panel 的「證據摘要」提供給小模型
- 由模型產生一段 Markdown 格式的分析解讀文字
- 解讀內容以串流方式逐步回傳前端

### 3.3 前端即時更新行為

- 前端持續接收後端透過 HTTP SSE 傳回的事件流
- 即時更新 UI，包括：
  - 當前處理狀態（Planning / Querying / Explaining）
  - 右側 Canvas 區逐步顯示新的視覺化 Panel
  - 左側 Assistant 回覆內容逐字成長（Streaming Delta）
