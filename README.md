# Disney Adventure 房間分組工具

一個離線小工具，把 Disney Adventure 郵輪的房號標在甲板平面圖上做分組（多分組、可重疊、條紋顯色），可加備註、可按主題/類別篩選。

打開直接用，所有分組與備註存在瀏覽器 `localStorage`。

## 功能

- **9 個甲板、2111 間客房**（資料來源：Disney 官方甲板圖 + [cruise.com.tw 主題對照](https://cruise.com.tw/blog/disney-adventure-stateroom-themes)）
- **多分組**：一間房可同時屬於多個分組；多組重疊用對角條紋呈現
- **批次輸入**：貼上一串房號（逗號／空白／換行分隔）一次指派
- **指派模式**：點分組顏色圓點 → 高亮 → 點地圖房間直接加/移
- **房間備註**：每間房可加自由文字備註，自動儲存
- **篩選**：主題下拉（如 Frozen、蜘蛛人）與類別代碼下拉（4C、11A …），可同時生效（AND）
- **跳到房號**：右上輸入房號 Enter 自動切到該層並開啟資訊浮層

## 本地開發

```bash
python3 -m http.server 8000
# 開 http://localhost:8000
```

必須走本地 server，不能用 `file://`（fetch JSON 會被擋）。

## 重建資料（少數情況才需要）

`rooms.json` 已隨專案，直接用即可。如果 Disney 改了平面圖要重新抓：

1. 把每層甲板的 HTML 存到 `data/raw/deck-N.html`（檔名以 HTML 內部標記為準，腳本會自動偵測修正）
2. 從 [cruise.com.tw](https://cruise.com.tw/blog/disney-adventure-stateroom-themes) 抓主題對照表存到 `data/raw/themes.html`
3. 跑 `python3 scripts/extract.py`，會重新產生 `rooms.json`

`data/raw/` 不在 git 版本控制裡（檔案大、屬於 Disney/部落格資料）。
