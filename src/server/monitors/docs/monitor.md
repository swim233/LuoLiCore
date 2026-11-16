# 监视任务怎么写

监视任务是让程序替你定时去查一个服务的接口，查到新的东西再叫你。不用你每次自己去查；没有新东西时你不会收到任何消息。

适合：有人说「某地有新的预警就说一声」「某某更新了告诉我」，而且有一个服务的接口能查到这件事，返回里是一个列表，每条有自己的编号。

不适合：只查一次的事，直接用 call_service；到某个时刻做一件事，建定时任务。

## 步骤

1. 用 read_docs 读那个服务的文档，找到要盯的接口，弄清它的参数和返回里的字段。
2. 参数里有要先查的东西（比如把地名查成经纬度），先用 call_service 查好，写进描述。以后每次查都用这组参数。
3. 写好描述，用 try_monitor 试跑。程序会照描述真的查一次，告诉你取到几条、每条有哪些字段、哪几条符合条件。不对就改了再试。
4. 用 create_task 建任务：kind 写 monitor，monitor 里放这份描述，action 写到点时要做什么。建的时候程序会照描述再查一次，查不通就不建。
5. 直接建，不用先问人。建完告诉对方你建了什么：盯的是什么、多久查一次、什么情况下会说。

## 描述里写什么

{{fields}}

## 字段怎么指

items、key、title、show，还有 where 里的 field，写的都是「路径」：一层一层用点连起来，如 `messageType.code`。

- items 从整个返回开始数；返回本身就是列表时写空字符串。
- key、title、show、field 从每一条的里面开始数。

## 只要哪些（where）

不写 where，每一条新的都算。写了，只有符合条件的新条目才到点。

一个条件写成 `{ "field": 路径, "op": 比法, "value": 值 }`。比法有这些：

{{ops}}

contains 找的是一段字，不管是不是一个完整的词：找「AI」也会找到 email、maintain。在意的话在 action 里写明到点时再自己筛一遍。

几个条件用 all（都要满足）或 any（满足一个就行）包起来，里面还可以再套：

```
{ "all": [ 条件, 条件, { "any": [ 条件, 条件 ] } ] }
```

## 到点是什么样

- 刚建好时已经有的条目不算新的，不会到点。
- 之后查到新的条目（key 没见过的）而且符合 where，程序把它们合成一条 `<event type="monitor">` 写进这个会话，里面有 action 和每条的 show 字段。一次新的条数多时只写前几条的内容，其余只列标题（几条见下面的「上限」）。
- mode 是 reply：这条事件会触发你回复一次，照 action 去做。
- mode 是 record：只写进会话，不触发你。下次有人找你时你能看到它。
- 条目的内容变了不算新的，条目没了也不管。
- where 只在第一次查到这一条时算一次：当时不符合的，以后内容变了（比如得分、评论数涨上来了）也不会再到点。所以不要拿会随时间变的字段做条件；「涨到多少才说」这种事监视做不了，照实告诉对方。

## 上限

{{limits}}

## 例子

盯上海的天气预警，新发布的和更新的都说，取消的不说：

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

action 可以写「上海（31.23, 121.47）有新的天气预警时告诉小明：是什么预警、谁发布的、到什么时候」。对谁说照实际写：让你盯的人，或者群里的大家。地名写进 action，以后看这条任务的人才知道盯的是哪里。

只要橙色和红色的，就把 where 换成：

```
{ "all": [
  { "field": "messageType.code", "op": "in", "value": ["alert", "update"] },
  { "field": "color.code", "op": "in", "value": ["orange", "red"] }
] }
```

例子里的服务不一定装着，有哪些服务看 read_docs 的说明。

## 建好以后

- 改用 update_task，monitor 里只写要改的字段；params、where、show 写了就整个换成新的，要写全。改 interval_minutes、where、title、show、mode、action 马上生效。改 service、endpoint、params、items、key 时程序会重新查一次，查通了才生效；刚换时已经有的条目不算新的。
- 改 mode 时看一眼 action 还对不对得上：原来写「说一声」、现在改成只记录，就把 action 一起改了。
- 取消用 cancel_task。看有哪些任务、上次查得怎么样，用 list_tasks。
- 查不到（网络不通、账号有问题、今天的额度用完）时程序会自己隔一阵再试，不用你管。连续 6 小时都查不到，你会收到一条 `<event type="monitor-failed">`，那时告诉这个会话里的人。
- 每个会话最多 20 个进行中的任务，监视任务也算在里面。CLI 会话不能建。
- 查得越勤，花的请求越多，每个服务每天的请求数有上限。没有特别的理由，用服务文档里建议的间隔。
