# Two images from one build: the server and the signer.
#
# They are separate images because they are separate trust domains. The signer
# holds the key; the server must not be able to reach it. Building them from one
# source tree keeps them on the same version of the receipt format.
#
#   docker build -f deploy/Dockerfile --target server -t sigillo-server .
#   docker build -f deploy/Dockerfile --target signer -t sigillo-signer .
#
# The base image is pinned by digest, so that two builds of the same commit
# start from the same bytes. To take a newer Node 22 (security updates do
# arrive this way), look up the digest of node:22-bookworm-slim, for example
# with `docker buildx imagetools inspect node:22-bookworm-slim`, and replace it
# in the three FROM lines together.

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /src

RUN corepack enable

# better-sqlite3 builds from source where no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/verifier/package.json packages/verifier/
COPY apps/server/package.json apps/server/
COPY apps/signer/package.json apps/signer/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
COPY scripts scripts
RUN pnpm build

# Only what runs in production, without the toolchain that built it.
#
# --legacy is required from pnpm 10 on: without it `deploy` refuses a workspace
# that does not set inject-workspace-packages, and exits before writing any
# node_modules, so the image would be built around three dependency-less
# directories. pnpm's own error names this flag as the way to keep the previous
# behaviour, which is what is wanted here: resolve the workspace packages into
# the deployed tree.
RUN pnpm --filter @sigillo/server --prod --legacy deploy /out/server \
 && pnpm --filter @sigillo/signer --prod --legacy deploy /out/signer \
 && pnpm --filter @sigillo/verifier --prod --legacy deploy /out/verifier


FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS server
# openssl builds the RFC 3161 timestamp requests and verifies the tokens.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/server ./
COPY --from=build /out/verifier /verifier
COPY apps/server/proto ./proto
COPY deploy/backup.sh ./backup.sh

# The database, the backups and the socket directory are volumes; the key is
# not here at all. Each directory is created here, owned by node, because a
# fresh named volume takes the ownership of the directory it is mounted on: a
# directory the image does not have would come up owned by root, and the
# server, which runs as node, could not write to it.
RUN install -d -o node -g node /var/lib/sigillo /var/lib/sigillo-backups /run/sigillo
USER node
ENV SIGILLO_DB=/var/lib/sigillo/sigillo.db \
    SIGILLO_SIGNER_SOCKET=/run/sigillo/signer.sock \
    SIGILLO_HOST=0.0.0.0 \
    SIGILLO_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]


FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS signer
WORKDIR /app
COPY --from=build /out/signer ./

# The key lives on a volume mounted only here.
RUN install -d -o node -g node /var/lib/sigillo-key /run/sigillo
USER node
ENV SIGILLO_KEY=/var/lib/sigillo-key/signer.key \
    SIGILLO_SIGNER_SOCKET=/run/sigillo/signer.sock
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--key", "/var/lib/sigillo-key/signer.key", "--socket", "/run/sigillo/signer.sock"]
