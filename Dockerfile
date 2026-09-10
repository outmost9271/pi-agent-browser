# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim

LABEL maintainer="pi-agent-browser"
LABEL description="agent-browser + Chrome for Testing + CDP gateway + hardened"

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG AGENT_BROWSER_VERSION=0.36.0
ENV TZ=Asia/Shanghai

# Install system deps + ffmpeg for recording, + minimal Chrome deps
RUN set -eu; build_http_proxy="$HTTP_PROXY"; build_https_proxy="$HTTPS_PROXY"; \
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY ALL_PROXY all_proxy \
    && apt-get update && apt-get install -y --no-install-recommends \
        tzdata ca-certificates curl gnupg wget jq \
        fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
        libnss3 libatk-bridge2.0-0 libatk1.0-0 libgbm1 libasound2 \
        libxss1 libxtst6 libxrandr2 libxdamage1 libxcomposite1 \
        libpango-1.0-0 libcairo2 libdrm2 libxkbcommon0 \
        tini dumb-init xvfb libnss3-tools \
        libcups2 libgtk-3-0 libxcursor1 libxfixes3 libxi6 \
        libxrender1 libxtst6 libgdk-pixbuf-2.0-0 libatspi2.0-0 \
        ffmpeg \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
    && ffmpeg -version | head -1 \
    && export http_proxy="$build_http_proxy" https_proxy="$build_https_proxy" HTTP_PROXY="$build_http_proxy" HTTPS_PROXY="$build_https_proxy" \
    && npm install -g agent-browser@${AGENT_BROWSER_VERSION} --no-audit --no-fund \
    && agent-browser install \
    && agent-browser --version \
    && npm cache clean --force \
    && rm -rf /tmp/* /root/.npm /var/log/* \
    && rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/* /usr/share/locale/* \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1001 -s /bin/bash agent \
    && mkdir -p /home/agent/.agent-browser /profiles /downloads /screenshots /home/agent/workspace /tmp/piab-staging /opt/piab /etc/agent-browser \
    && cp -r /root/.agent-browser /home/agent/ \
    && if [ -d /root/.cache ]; then cp -r /root/.cache /home/agent/.cache; fi \
    && chown -R agent:agent /home/agent /profiles /downloads /screenshots /tmp/piab-staging

# Container agent (CDP gateway + supervisor)
COPY container-agent/cdp-gateway.mjs /opt/piab/cdp-gateway.mjs
COPY container-agent/gateway-utils.mjs /opt/piab/gateway-utils.mjs
COPY container-agent/supervisor.mjs /opt/piab/supervisor.mjs
COPY container-agent/chrome-wrapper.sh /tmp/chrome-wrapper.sh
COPY container-agent/package.json /opt/piab/package.json
RUN set -eu; cd /opt/piab \
    && http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" npm install --omit=dev --no-audit --no-fund \
    && chrome=$(find /root/.agent-browser/browsers -type f -name chrome | sort | head -n 1) \
    && test -n "$chrome" \
    && mkdir -p /opt/piab/browser \
    && cp -a "$(dirname "$chrome")/." /opt/piab/browser/ \
    && mv /opt/piab/browser/chrome /opt/piab/browser/chrome.real \
    && cp /tmp/chrome-wrapper.sh /opt/piab/browser/chrome \
    && chmod +x /opt/piab/browser/chrome /opt/piab/*.mjs \
    && chown -R agent:agent /opt/piab \
    && rm -f /tmp/chrome-wrapper.sh

EXPOSE 9222
USER agent
WORKDIR /home/agent

ENV TZ=Asia/Shanghai \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/piab/browser/chrome \
    CHROME_BIN=/opt/piab/browser/chrome \
    AGENT_BROWSER_SOCKET_DIR=/home/agent/.agent-browser \
    AGENT_BROWSER_IDLE_TIMEOUT_MS=3600000 \
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS=30000 \
    AGENT_BROWSER_STATE_EXPIRE_DAYS=30 \
    AGENT_BROWSER_CONFIG=/etc/agent-browser/config.json \
    PIAB_REQUIRE_SANDBOX=1 \
    PIAB_CDP_INTERNAL_PORT=9223 \
    PIAB_CDP_GATEWAY_PORT=9222

ENTRYPOINT ["/usr/bin/tini", "--"]
# Supervisor manages CDP gateway and keeps container alive; main work still via docker exec agent-browser
CMD ["node", "/opt/piab/supervisor.mjs"]
