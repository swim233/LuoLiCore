# 逐小时预报（weather_hourly）

某个地点未来若干小时的逐小时预报。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `hours`：预报的小时数，1 到 240，默认 24。须填写，且不超过 16：`call_service` 的结果最多显示 2 万字符，约为 16 小时的数据，超出的部分会被截断。需要更晚的时段时，改用 `weather_daily`。
- `localTime`：`true` 时返回当地时间，未填写时为 UTC。必须填 `true`。
- `lang`：语言，见总说明。

## 返回

带单位的数值均为 `{ value, unit }` 的形式，下文括号内是单位。

`hours` 是一个列表，每小时一项，按时间先后排列，第一项为下一个整点。每项有：

- `forecastTime`：此项对应的时刻。
- `condition.text`：天气现象的文字描述，如「晴」「小雨」；`condition.code` 为其代码。
- `temperature` 气温，`feelsLike` 体感温度，`dewPoint` 露点温度（°C）。
- `humidity`：相对湿度，0 到 1。
- `wind`：风。
  - `direction.degree` 风向的角度（0 到 359），`direction.compass` 方位（`n` 北、`ne` 东北、`sw` 西南等；`none` 为无风，`vrb` 为风向不定）；
  - `speed` 风速（m/s）；
  - `scale` 蒲福风级，即通常所说的几级风。
- `windGust`：阵风的风速（m/s）。
- `precipitation`：降水。
  - `amount` 此小时内的降水量（mm），`intensity` 降水强度（mm/h）；
  - `probability` 降水概率，0 到 1；
  - `type` 类型：`rain` 雨、`snow` 雪、`ice` 冰粒或冻雨、`mixed` 混合、`none` 无降水、`unknown` 未知。
- `pressure`：海平面气压（hPa）。`visibility`：能见度（m）。
- `cloudCover`：云量，0 到 1。`uvIndex`：紫外线指数，0 到 15。
