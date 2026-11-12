# Forge project sandbox: one container per project.
# Holds the project's repo at /workspace, runs the Next.js dev server, the agent
# runner, and the green-build checks (tsc, eslint, vitest, Playwright).
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/share/pnpm \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl jq tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# Chromium + its system deps for the green-build smoke test and the QA agent.
RUN npx -y playwright@1 install --with-deps chromium \
 && rm -rf /root/.npm /tmp/*

# procps (pgrep/pkill): the orchestrator uses them to detect the dev server and to stop a run.
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

# Unprivileged user that owns the workspace; the agent never runs as root.
RUN useradd -m -u 10001 forge && mkdir -p /workspace /opt/forge && chown forge:forge /workspace /opt/forge
USER forge
RUN git config --global user.name "Forge Agent" \
 && git config --global user.email "agent@forge.local" \
 && git config --global init.defaultBranch main

# Project template with dependencies pre-installed, so a new project starts by
# copying files instead of downloading packages. Before the runner layers:
# the template changes rarely and its install is the slowest step.
COPY --chown=forge:forge templates/next-app/ /opt/forge/template/
RUN cd /opt/forge/template && pnpm install --frozen-lockfile=false

# Agent runner (Claude Agent SDK). Installed here so npm picks the
# linux binary that matches the container's architecture.
COPY --chown=forge:forge sandbox/runner/package.json /opt/forge/runner/
RUN cd /opt/forge/runner && npm install --omit=dev --no-audit --no-fund && rm -rf /home/forge/.npm
COPY --chown=forge:forge sandbox/runner/runner.mjs /opt/forge/runner/

# Green-build checks (install, typecheck, lint, unit, smoke test in Chromium).
COPY --chown=forge:forge sandbox/checks/package.json /opt/forge/checks/
RUN cd /opt/forge/checks && npm install --omit=dev --no-audit --no-fund && rm -rf /home/forge/.npm
COPY --chown=forge:forge sandbox/checks/checks.mjs /opt/forge/checks/

WORKDIR /workspace

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
