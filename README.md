# 本地版 AI Canvas 開發說明

## 一、開發目標

- 透過在 MCP Client 端加入較為精細且可控的硬編碼處理邏輯，使本地部署的小型語言模型（如 Qwen 系列）亦能穩定實現類似 AI Canvas 的互動分析與可視化效果。
- 在不依賴大型雲端模型的前提下，確保整體行為可預期、可管控，並符合企業內部部署與資安要求。

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
    - 呼叫 Qwen 等本地模型進行語意規劃（Planning）與結果解讀（Explaining）
    - 透過 Splunk MCP 介面查詢資料
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
- 所有以下工作皆集中於後端 API：
  - 查詢資料
  - 語意推理
  - SPL 組合
  - 呼叫 Splunk
- 前端透過 `/api/chat` 發起一次分析請求後，後端會將「圖表面板」與「文字解讀」一邊產生、一邊以串流方式回傳。
- 設計上的關鍵取捨在於：
  - **不允許小型模型直接生成 SPL**
  - 小模型僅負責輸出「結構化的分析計畫（JSON）」
  - 實際的 SPL 由後端依固定模板產生  
  → 使整體行為更穩定、可控，並避免模型幻覺（Hallucination）。

## 三、應用實作流程

### 3.1 整體流程

- 使用者於左側 Chat 區輸入自然語言問題
- 前端 `page.tsx` 以 `POST /api/chat` 呼叫後端（並攜帶 Access Token 以進行存取控管）
- 後端 `route.ts` 進入三階段處理流程，並即時將狀態回傳前端

### 3.2 後端三階段處理流程

#### （一）Planning：語意規劃階段

- 呼叫 Qwen 本地模型，透過提示詞工程（Prompt Engineering）解析使用者意圖
- 輸出一份標準化 JSON，內容包含：
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

- 目前僅支援單一功能（資安事件可視化）。未來將擴充為多功能架構，於此階段額外回傳一個 savedsearch 欄位。目前系統預設使用 Event_Table，後續規劃改由環境變數定義一組 Savedsearch 對應表，每一個 Savedsearch 皆包含其對應的欄位定義與說明註解，並由小型語言模型自其中進行選擇，回傳欲使用的 Savedsearch。
- 規劃中的擴充方向：
  - 未來在 JSON 中新增 `savedsearch` 欄位
  - 透過環境變數定義一組 Savedsearch 對應表
  - 每個 Savedsearch 對應一組欄位定義與說明
  - 由小模型「多選一」回傳欲使用的 Savedsearch

#### （二）Querying：Splunk 查詢階段

- 後端依據 Planning 階段產出的 JSON：
  - 套用既定的 SPL 模板
  - 以指定的 savedsearch 作為查詢基底
- 透過 Splunk MCP 拉取資料
- 將查詢結果轉換為多個 Panel：
  - 單值（Single Value）
  - 表格（Table）
  - 長條圖（Bar）
  - 圓餅圖（Pie）
  - 折線圖（Line）

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
