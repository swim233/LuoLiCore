FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep jq curl git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir requests pandas numpy matplotlib
RUN useradd -m -u 1000 sandbox
USER sandbox
WORKDIR /workspace
