FROM node:18-bullseye

ENV GO_VERSION=1.21.1

# Install prerequisites
RUN apt-get update && apt-get install -y \
    wget \
    git \
    gcc \
    g++ \
    libc6-dev \
    make \
    chromium \
    tzdata

# Detect system architecture and download correct Go binary
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) GOARCH=amd64 ;; \
      aarch64) GOARCH=arm64 ;; \
      *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    wget https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz && \
    rm -rf /usr/local/go && \
    tar -C /usr/local -xzf go${GO_VERSION}.linux-${GOARCH}.tar.gz && \
    rm go${GO_VERSION}.linux-${GOARCH}.tar.gz

# Set Go environment
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH=/root/go
ENV PATH="${GOPATH}/bin:${PATH}"

# Install gowitness
RUN go install github.com/sensepost/gowitness@latest

# Chromium path symlink
RUN ln -s /usr/bin/chromium /usr/bin/google-chrome

# Set timezone
ENV TZ=Africa/Johannesburg
RUN ln -fs /usr/share/zoneinfo/Africa/Johannesburg /etc/localtime && \
    dpkg-reconfigure -f noninteractive tzdata

# Set app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

EXPOSE 3000

CMD ["node", "webui.js"]

