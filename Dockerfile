FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="/usr/local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gosu \
        jq \
        nodejs \
        npm \
        openssh-client \
        tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex

ARG USERNAME=agent
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid "${USER_GID}" "${USERNAME}" \
    && useradd --uid "${USER_UID}" --gid "${USER_GID}" -m "${USERNAME}"

WORKDIR /workspace

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/agentd.sh /usr/local/bin/agentd
COPY scripts/agentctl.sh /usr/local/bin/agentctl
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/agentd /usr/local/bin/agentctl

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["agentd"]
