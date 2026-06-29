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
RUN cd /tmp \
    && git clone https://github.com/playhex/benzene-vanilla-cmake.git \
    && cd benzene-vanilla-cmake/ \
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
