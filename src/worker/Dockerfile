FROM node:18

RUN apt update && apt install -y \
    libboost-all-dev \
    build-essential \
    libdb-dev \
    build-essential \
    cmake \
    git

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
