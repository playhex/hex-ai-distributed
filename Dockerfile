# One image per engine, build with:
#
#   docker build --target katahex -t playhex/worker-katahex .
#   docker build --target katahex -t playhex/worker-katahex --build-context katahex-src=../katahex .   # local katahex checkout
#   docker build --target mohex -t playhex/worker-mohex .
#   docker build --target davies -t playhex/worker-davies .
#
# Katahex image requires the model in katahex/ folder, see README.

ARG NODE_IMAGE=node:22-slim


#
# Worker app, compiled, with production dependencies only
#
FROM ${NODE_IMAGE} AS app

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json config.ts .env.dist ./
COPY src src
RUN yarn tsc \
    && cp .env.dist dist/ \
    && yarn install --frozen-lockfile --production --ignore-scripts \
    && yarn cache clean


#
# Engines builds.
# Shared libraries used by engine binaries (except system ones) are copied to /engine-libs,
# to not install build dependencies in final images.
#
FROM ${NODE_IMAGE} AS engine-build

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git


FROM engine-build AS mohex-build

RUN apt-get install -y libboost-all-dev libdb-dev

# Fork with 14x14 support. Pinned to the last working commit: more recent ones are buggy.
ARG MOHEX_COMMIT=9f247ad72cc0cd23dabdc9f62bd40b0721ebcb35

RUN cd /tmp \
    && git clone https://github.com/playhex/benzene-vanilla-cmake.git \
    && cd benzene-vanilla-cmake/ \
    && git checkout ${MOHEX_COMMIT} \
    && mkdir build \
    && cd build/ \
    && cmake ../ \
    && make -j4 \
    && mv ./src/mohex/mohex /bin/mohex \
    && mkdir /engine-libs \
    && ldd /bin/mohex | awk '/=> \// { print $3 }' | grep -vE '/(libc|libm|libstdc\+\+|libgcc_s|libpthread|libdl|librt|ld-linux[^/]*)\.so' | xargs -I{} cp -L {} /engine-libs/


# Katahex sources. Cloned from git by default, must contain kata-raw-nn-batch GTP command, used to analyze games.
# Override with --build-arg to build from a fork or a given commit,
# or with a local checkout: --build-context katahex-src=../katahex
FROM engine-build AS katahex-clone

ARG KATAHEX_REPO=https://github.com/playhex/katahex
ARG KATAHEX_REF=Hex2024

RUN git clone ${KATAHEX_REPO} /katahex \
    && cd /katahex \
    && git checkout ${KATAHEX_REF}


# Same layout as a katahex checkout, replaced by --build-context katahex-src=...
FROM scratch AS katahex-src

COPY --from=katahex-clone /katahex/cpp /cpp


FROM engine-build AS katahex-build

RUN apt-get install -y libeigen3-dev libzip-dev zlib1g-dev

# Only cpp/ sources, to not copy local build folders
COPY --from=katahex-src cpp /tmp/katahex/cpp

RUN cd /tmp/katahex \
    && mkdir build \
    && cd build \
    && cmake -DUSE_BACKEND=EIGEN -DMAX_BOARD_LEN=32 -DNO_GIT_REVISION=1 ../cpp \
    && make -j4 \
    && mv ./katahex /bin/katahex \
    && mkdir /engine-libs \
    && ldd /bin/katahex | awk '/=> \// { print $3 }' | grep -vE '/(libc|libm|libstdc\+\+|libgcc_s|libpthread|libdl|librt|ld-linux[^/]*)\.so' | xargs -I{} cp -L {} /engine-libs/


#
# Final images
#
FROM ${NODE_IMAGE} AS worker-base

WORKDIR /app

COPY --from=app /app/dist dist
COPY --from=app /app/node_modules node_modules
COPY --from=app /app/package.json package.json

CMD ["node", "dist/src/worker"]


FROM worker-base AS davies

ENV ENGINE=davies


FROM worker-base AS mohex

COPY --from=mohex-build /engine-libs/ /usr/local/lib/mohex/
COPY --from=mohex-build /bin/mohex /bin/mohex

# Mohex data files, looked up at the path where it has been built
COPY --from=mohex-build /tmp/benzene-vanilla-cmake/share /tmp/benzene-vanilla-cmake/share
RUN echo /usr/local/lib/mohex > /etc/ld.so.conf.d/mohex.conf && ldconfig

ENV ENGINE=mohex
ENV MOHEX_BIN="/bin/mohex --seed 1"


FROM worker-base AS katahex

COPY --from=katahex-build /engine-libs/ /usr/local/lib/katahex/
COPY --from=katahex-build /bin/katahex /bin/katahex
RUN echo /usr/local/lib/katahex > /etc/ld.so.conf.d/katahex.conf && ldconfig

COPY katahex/config.cfg katahex/katahex_model_20220618.bin.gz /app/katahex/

ENV ENGINE=katahex
ENV KATAHEX_BIN="/bin/katahex gtp -config /app/katahex/config.cfg -model /app/katahex/katahex_model_20220618.bin.gz"
