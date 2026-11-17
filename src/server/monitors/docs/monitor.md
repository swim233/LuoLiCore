# 监听任务的写法

监听任务由引擎按固定的间隔执行一个服务接口的请求，出现新条目时触发、通知你。没有新条目时你不会收到任何消息。

适用：有人要求「某地有新的预警就说一声」「某某更新了告诉我」，且有服务的接口能查到这件事，返回数据是一个列表，每个条目有自己的编号。

不适用：只查一次的，直接用 call_service；到某个时刻做一件事的，创建定时任务。

## 步骤

1. 用 read_docs 读取该服务的文档，确定要监听的接口，了解它的参数和返回的字段。
2. 参数需要预先查询时（如把地名查成经纬度），先用 call_service 查好，填入描述。之后每次执行都使用这组参数。
3. 写好描述后用 try_monitor 测试。引擎会按描述实际执行一次请求，返回获取到的条目数、每个条目有哪些字段、哪些条目符合条件。有问题就修改后重新测试。
4. 用 create_task 创建任务：kind 填 monitor，monitor 填这份描述，action 填触发时要做什么。创建时引擎会按描述再执行一次请求，失败则不创建。
5. 直接创建，无需事先询问。创建后告诉对方：监听对象、监听间隔、什么情况下会通知。

## 描述的字段

{{fields}}

## 字段的路径

items、key、title、show 以及 where 里的 field，填的都是「路径」：各层的字段名用点连接，如 `messageType.code`。

- items 的路径从返回数据的最外层算起；返回数据本身就是列表时填空字符串。
- key、title、show、field 的路径从每个条目的内部算起。

## 监听范围（where）

未填写 where 时，所有新条目都会触发；填写后，仅符合条件的新条目才触发。

单个条件写作 `{ "field": 路径, "op": 比较方式, "value": 值 }`。比较方式有：

{{ops}}

contains 按文本片段匹配，不区分是否为完整的词：匹配「AI」时也会匹配到 email、maintain。需要精确匹配时，在 action 里写明触发后再自行筛选一遍。

多个条件用 all（全部满足）或 any（满足任意一个）组合，可以嵌套：

```
{ "all": [ 条件, 条件, { "any": [ 条件, 条件 ] } ] }
```

## 触发规则

- 创建时已存在的条目不算新条目，不会触发。
- 之后出现新条目（key 未出现过）且符合 where 时，引擎把它们合并成一条 `<event type="monitor">` 写入此会话，其中有 action 和每个条目的 show 字段。一次新条目较多时只写前几条的内容，其余仅列标题（条数见下文「上限」）。
- mode 为 reply：此事件触发你回复一次，照 action 去做。
- mode 为 record：仅写入会话，不触发回复。下次有人找你时你能看到它。
- 条目的内容变化不算新条目，条目消失也不处理。
- where 仅在条目首次出现时判断一次：当时不符合的，之后内容变化（如得分、评论数上涨）也不会再触发。因此不要用随时间变化的字段作条件；「涨到多少再通知」这类需求监听任务做不到，如实告诉对方。

## 上限

{{limits}}

## 示例

监听上海的天气预警，新发布的和更新的都通知，取消的不通知：

```
{
  "service": "qweather",
  "endpoint": "weather_alert",
  "params": { "latitude": 31.23, "longitude": 121.47, "localTime": true },
  "interval_minutes": 10,
  "items": "alerts",
  "key": "id",
  "where": { "field": "messageType.code", "op": "in", "value": ["alert", "update"] },
  "title": "headline",
  "show": ["headline", "description", "senderName", "severity", "expireTime", "instruction"],
  "mode": "reply"
}
```

action 可以写「上海（31.23, 121.47）有新的天气预警时告诉小明：是什么预警、谁发布的、到什么时候」。通知对象按实际情况写：要求监听的人，或者群里的所有人。地名要写进 action，之后查看此任务的人才知道监听的是哪里。

仅需橙色和红色预警时，把 where 改为：

```
{ "all": [
  { "field": "messageType.code", "op": "in", "value": ["alert", "update"] },
  { "field": "color.code", "op": "in", "value": ["orange", "red"] }
] }
```

示例中的服务不一定已安装，当前可用服务见 read_docs 的工具说明。

## 创建之后

- 修改用 update_task，monitor 里仅填写要修改的字段；params、where、show 一经填写即整体替换，须填写完整。修改 interval_minutes、where、title、show、mode、action 立即生效。修改 service、endpoint、params、items、key 时引擎会重新执行一次请求，成功后才生效；更换时已存在的条目不算新条目。
- 修改 mode 时确认 action 是否仍然对应：原来写的是「说一声」、现在改为仅记录的，同时修改 action。
- 取消用 cancel_task。查看有哪些任务、上次执行的情况，用 list_tasks。
- 执行失败（网络不通、账号异常、当天额度用完）时引擎会自动间隔重试，无需处理。连续失败满 6 小时，你会收到一条 `<event type="monitor-failed">`，届时把情况告诉此会话里的人。
- 每个会话最多 20 个进行中的任务，监听任务计算在内。CLI 会话不能创建。
- 监听间隔越短，消耗的请求越多，而每个服务每天的请求次数有上限。没有特殊理由时，使用服务文档建议的间隔。
