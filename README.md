# 小吃店外帶取餐叫號系統

顧客自助點餐後，店員可以依出餐進度叫號。A002 的鍋貼先做好時，顧客畫面同時顯示 A002 可取餐與 A001 準備中。

## 本機啟動

安裝 Docker 與 Docker Compose，在專案目錄執行：

```sh
docker compose up --build
```

開啟 [單分頁展示](http://127.0.0.1:5000/demo)。左側為顧客點餐和取餐狀態，右側為店員操作。

1. 分別送出一份水餃和一份鍋貼，取得 A001 與 A002。
2. 在店員區先叫 A002，顧客區會即時更新。
3. 按「確認取餐」後，A002 會從顧客區移除。
4. 按「重新開始」可開啟新場次，下一筆從 A001 發號。

## 系統架構

瀏覽器以 HTML、CSS 與 JavaScript 呈現介面，透過 HTTP 呼叫 Flask 的 JSON API。Flask 透過 redis-py 讀寫 Redis，並用 SSE 通知畫面查詢最新狀態。

| Redis 功能 | 指令與用途 |
| --- | --- |
| List | 使用 `RPUSH` 與 `LRANGE` 保留與取得接單順序。 |
| Pub/Sub | 使用 `PUBLISH` 與 `SUBSCRIBE` 通知 Flask 訂單變更。 |
| Pipeline | 將多筆 `HGETALL` 一起送出，減少網路往返。 |
| Lua | 在同一次執行中發號並寫入訂單，更新狀態前先驗證目前狀態。 |

## 測試資料

`redis-export.resp` 內含虛構訂單。啟動 Docker 服務後，可在 cmd、macOS 或 Linux shell 匯入空的 Redis DB 1：

```sh
docker compose exec -T redis redis-cli -n 1 --pipe < redis-export.resp
docker compose exec -T redis redis-cli -n 1 LRANGE takeout:orders 0 -1
```

本專案為本機展示版。店員介面尚未加入登入，Docker 連接埠預設只映射至回送介面。
