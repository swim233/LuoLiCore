FROM python:3.12-slim
# procps：`python:3.12-slim` 里连 `ps` 都没有。一次性容器下这只是不方便，持久容器下
# 「我起的那个服务还活着吗」是个日常问题，而 `docker top` 只有 owner 那几个工具够得着。
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep jq curl git ca-certificates procps && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir requests pandas numpy matplotlib
RUN useradd -m -u 1000 sandbox
USER sandbox
WORKDIR /workspace
