# 天气预警（weather_alert）

某个地点正在生效的官方天气预警，是气象台等机构发布的。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `localTime`：`true` 返回当地时间，不写是 UTC。一定写 `true`。
- `lang`：语言，见总说明。预警的内容不一定有指定的语言。

## 返回

- `metadata.zeroResult`：`true` 表示这个地点现在没有预警，这时 `alerts` 是空的列表。
- `alerts`：正在生效的预警的列表，每条有：
  - `id`：这条预警信息的编号，是一串很长的数字，写成字符串。
  - `headline`：标题，如「上海中心气象台发布大风蓝色预警信号」。`description`：详细内容。
  - `senderName`：发布机构，可能为空。
  - `eventType.name`：预警的种类，如「大风」「暴雨」；`eventType.code` 是它的代码。
  - `severity`：严重程度，从轻到重是 `minor`、`moderate`、`severe`、`extreme`；`unknown` 是不清楚。
  - `color.code`：预警的颜色。国内的预警按颜色分级，从轻到重是 `blue` 蓝、`yellow` 黄、`orange` 橙、`red` 红；别的地方还可能是 `white`、`gray`、`green`、`amber`、`purple`、`black`。
  - `messageType.code`：这条信息的性质。`alert` 是新发布的，`update` 是更新了以前的预警，`cancel` 是取消了以前的预警。`messageType.supersedes` 列出被它取代的预警的 `id`。
  - `issuedTime` 发布时间，`effectiveTime` 生效时间，`onsetTime` 天气预计开始的时间（可能为空），`expireTime` 失效时间。
  - `urgency` 紧迫程度（`immediate`、`expected`、`future`、`past`、`unknown`），`certainty` 可信程度（`observed`、`likely`、`possible`、`unlikely`、`unknown`），都可能为空。
  - `instruction`：防御指南，可能为空。`criteria`：发这种预警的标准，仅供参考。

## 要注意

- 预警更新、取消时来的是一条新的信息，有新的 `id`，被取代的那条不再返回。所以有没有新情况看 `id`：没见过的 `id` 就是新的信息。
- `cancel` 的信息只保留一小时。
- 说预警时讲清楚：什么预警（种类、颜色）、谁发布的、到什么时候、要点是什么。防御指南挑要紧的说，不用全念。最后带上来源，如「上海中心气象台发布，数据来自和风天气」。
- 预警是按受影响的地理范围发布的，不严格按行政区划，相邻的区可能不一样。
- 有人要你盯着某地的预警、有新的就说时，建监视任务（写法见 read_docs 的 monitor，那里的例子用的就是这个接口），10 分钟查一次就够。
