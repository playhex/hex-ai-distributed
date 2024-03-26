FROM node:21-slim

RUN apt update && apt install -y \
    libboost-all-dev \
    build-essential \
    cmake \
    git

# Mohex

RUN apt install -y \
    libdb-dev

# Download Mohex source code
# Go back to an older version, I get a strange AI behaviour on latest version.
# See https://github.com/cgao3/benzene-vanilla-cmake/issues/14
RUN cd /tmp \
    && git clone https://github.com/cgao3/benzene-vanilla-cmake \
    && cd benzene-vanilla-cmake/ \
    && git checkout f888938bc7ab051a04034a9e19a31399a31d2429 \
    && mkdir build \
    && cd build/ \
    && cmake ../ \
    && make -j4 \
    && mv ./src/mohex/mohex /bin/mohex

# Katahex

RUN apt install -y \
    libeigen3-dev \
    libzip-dev

# Katahex selinger
# From https://github.com/selinger/katahex
RUN cd /tmp \
    && git clone https://github.com/selinger/katahex \
    && cd katahex/ \
    && mkdir build \
    && cd build \
    && cmake -DUSE_BACKEND=EIGEN -DMAX_BOARD_LEN=32 ../cpp \
    && make -j4 \
    && mv ./katahex /bin/katahex
