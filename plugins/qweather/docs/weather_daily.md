# 逐天预报（weather_daily）

某个地点今后 1 到 10 天每天的预报，每天分白天和夜间。

## 参数

- `latitude`（必填）：纬度，最多两位小数，如 `39.92`。
- `longitude`（必填）：经度，最多两位小数，如 `116.41`。
- `days`：要几天，1 到 10，默认 7。返回的内容比较长，只要用得到的天数。
- `localTime`：`true` 返回当地时间，不写是 UTC。一定写 `true`：不写的话第一项的开始会写成前一天的 16:00Z（北京时间的 0 点），看起来像昨天。
- `lang`：语言，见总说明。

## 返回

带单位的数都写成 `{ value, unit }`，下面括号里是单位。

`days` 是一个列表，一天一项，按日期先后排，第一项是当地的今天。每项有：

- `forecastStartTime`、`forecastEndTime`：这一项管的是从什么时候到什么时候（当地的 0 点到第二天 0 点，不含结束的那一刻）。哪一项是「今天」「明天」以这两个时间为准。
- `temperatureMax`、`temperatureMin`、`temperatureAvg`：最高、最低、平均气温（°C）。
- `uvIndexMax`：最大紫外线指数，0 到 15。
- `daytime`（白天，当地 07:00 到 19:00）和 `nighttime`（夜间，19:00 到第二天 07:00），各自有：
  - `condition.text` 天气现象的文字；
  - `temperatureMax`、`temperatureMin`；
  - `humidity` 相对湿度（0 到 1），`cloudCover` 云量（0 到 1）；
  - `wind`（`direction`、`speed`、`scale`，同实时天气），`windGustMax` 最大阵风；
  - `precipitation`：`amount` 降水量（mm），`type` 类型（同实时天气），`probability` 降水概率（0 到 1）。
- `astro`：日出 `sunrise`、日落 `sunset`、月出 `moonrise`、月落 `moonset`、月相 `moonPhase`（`new-moon` 新月、`waxing-crescent` 蛾眉月、`first-quarter` 上弦月、`waxing-gibbous` 盈凸月、`full-moon` 满月、`waning-gibbous` 亏凸月、`last-quarter` 下弦月、`waning-crescent` 残月），还有晨昏的几个时刻。
