# 逐天预报（weather_daily）

某个地点未来 1 到 10 天的逐天预报，每天分白天和夜间。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `days`：预报的天数，1 到 10，默认 7。返回的内容较长，只取需要的天数。
- `localTime`：`true` 时返回当地时间，未填写时为 UTC。必须填 `true`：否则第一项的开始时间会写成前一天的 16:00Z（即北京时间 0 点），容易误认为是昨天。
- `lang`：语言，见总说明。

## 返回

带单位的数值均为 `{ value, unit }` 的形式，下文括号内是单位。

`days` 是一个列表，每天一项，按日期先后排列，第一项为当地的今天。每项有：

- `forecastStartTime`、`forecastEndTime`：此项覆盖的起止时间（当地 0 点到次日 0 点，不含结束的时刻）。判断哪一项是「今天」「明天」以这两个时间为准。
- `temperatureMax`、`temperatureMin`、`temperatureAvg`：最高、最低、平均气温（°C）。
- `uvIndexMax`：最大紫外线指数，0 到 15。
- `daytime`（白天，当地 07:00 到 19:00）和 `nighttime`（夜间，19:00 到次日 07:00），各自有：
  - `condition.text` 天气现象的文字描述；
  - `temperatureMax`、`temperatureMin`；
  - `humidity` 相对湿度（0 到 1），`cloudCover` 云量（0 到 1）；
  - `wind`（`direction`、`speed`、`scale`，同实时天气），`windGustMax` 最大阵风；
  - `precipitation`：`amount` 降水量（mm），`type` 类型（同实时天气），`probability` 降水概率（0 到 1）。
- `astro`：日出 `sunrise`、日落 `sunset`、月出 `moonrise`、月落 `moonset`、月相 `moonPhase`（`new-moon` 新月、`waxing-crescent` 蛾眉月、`first-quarter` 上弦月、`waxing-gibbous` 盈凸月、`full-moon` 满月、`waning-gibbous` 亏凸月、`last-quarter` 下弦月、`waning-crescent` 残月），以及晨昏的几个时刻。
