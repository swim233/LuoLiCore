# 天气预警（weather_alert）

某个地点正在生效的官方天气预警，由气象台等机构发布。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `localTime`：`true` 时返回当地时间，未填写时为 UTC。必须填 `true`。
- `lang`：语言，见总说明。预警的内容不一定提供指定的语言。

## 返回

- `metadata.zeroResult`：`true` 表示此地点当前没有预警，此时 `alerts` 为空列表。
- `alerts`：正在生效的预警列表，每条有：
  - `id`：此条预警信息的编号，为一长串数字，以字符串形式返回。
  - `headline`：标题，如「上海中心气象台发布大风蓝色预警信号」。`description`：详细内容。
  - `senderName`：发布机构，可能为空。
  - `eventType.name`：预警的类型，如「大风」「暴雨」；`eventType.code` 为其代码。
  - `severity`：严重程度，从轻到重为 `minor`、`moderate`、`severe`、`extreme`；`unknown` 为未知。
  - `color.code`：预警的颜色。国内的预警按颜色分级，从轻到重为 `blue` 蓝、`yellow` 黄、`orange` 橙、`red` 红；其他地区还可能是 `white`、`gray`、`green`、`amber`、`purple`、`black`。
  - `messageType.code`：此条信息的性质。`alert` 为新发布，`update` 为更新此前的预警，`cancel` 为取消此前的预警。`messageType.supersedes` 列出被其取代的预警的 `id`。
  - `issuedTime` 发布时间，`effectiveTime` 生效时间，`onsetTime` 天气预计开始的时间（可能为空），`expireTime` 失效时间。
  - `urgency` 紧迫程度（`immediate`、`expected`、`future`、`past`、`unknown`），`certainty` 可信程度（`observed`、`likely`、`possible`、`unlikely`、`unknown`），都可能为空。
  - `instruction`：防御指南，可能为空。`criteria`：发布此类预警的标准，仅供参考。

## 注意事项

- 预警更新、取消时会产生一条新的信息，带有新的 `id`，被取代的那条不再返回。因此是否有新情况以 `id` 为准：未出现过的 `id` 即为新信息。
- `cancel` 的信息仅保留一小时。
- 告知预警时说明：预警的类型和颜色、发布机构、有效期、要点。防御指南只说重点，不必全文转述。最后注明来源，如「上海中心气象台发布，数据来自和风天气」。
- 预警按受影响的地理范围发布，不严格对应行政区划，相邻的区可能不同。
- 有人要求持续关注某地的预警、有新预警就通知时，创建监听任务（写法见 read_docs 的 monitor，其中的示例用的就是此接口），监听间隔 10 分钟即可。
