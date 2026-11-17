# 实时天气（weather_now）

某个地点当前的天气。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `localTime`：`true` 时返回当地时间，未填写时为 UTC。必须填 `true`。
- `lang`：语言，见总说明。

## 返回

带单位的数值均为 `{ value, unit }` 的形式，下文括号内是单位。

- `validTime`：此数据对应的时间。
- `condition.text`：天气现象的文字描述，如「少云」「小雨」；`condition.code` 为其代码。
- `temperature` 气温，`feelsLike` 体感温度，`dewPoint` 露点温度（°C）。
- `humidity`：相对湿度，0 到 1。
- `wind`：风。
  - `direction.degree` 风向的角度（0 到 359），`direction.compass` 方位（`n` 北、`ne` 东北、`sw` 西南等；`none` 为无风，`vrb` 为风向不定）；
  - `speed` 风速（m/s）；
  - `scale` 蒲福风级，即通常所说的几级风。
- `windGust`：阵风的风速（m/s）。
- `precipitation`：降水。
  - `amount` 过去一小时的降水量（mm），`intensity` 降水强度（mm/h）；
  - `type` 类型：`rain` 雨、`snow` 雪、`ice` 冰粒或冻雨、`mixed` 混合、`none` 无降水、`unknown` 未知。
- `pressure`：海平面气压（hPa）。`visibility`：能见度（m）。
- `cloudCover`：云量，0 到 1。`uvIndex`：紫外线指数，0 到 15。
