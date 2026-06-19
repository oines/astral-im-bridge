FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.cargo/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    curl \
    git \
    build-essential \
    libsqlite3-dev \
    libssl-dev \
    lld \
    pkg-config \
    protobuf-compiler \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable

COPY docker/start-astral-app-server.sh /usr/local/bin/start-astral-app-server
RUN chmod +x /usr/local/bin/start-astral-app-server

WORKDIR /workspace

CMD ["/usr/local/bin/start-astral-app-server"]
