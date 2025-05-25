# Use official Node.js image with build tools (debian based)
FROM node:18-bullseye

# Install Go (latest stable)
ENV GO_VERSION=1.21.1

RUN apt-get update && apt-get install -y wget git \
  && wget https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz \
  && rm -rf /usr/local/go \
  && tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz \
  && rm go${GO_VERSION}.linux-amd64.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

# Set Go workspace directory for user root
ENV GOPATH=/root/go
ENV PATH="${GOPATH}/bin:${PATH}"

# Install gowitness using go install
RUN go install github.com/sensepost/gowitness@latest


# Install chromium (headless chrome)
RUN apt-get update && apt-get install -y chromium

# Optional: symlink chromium to google-chrome
RUN ln -s /usr/bin/chromium /usr/bin/google-chrome
 
ENV TZ=Africa/Johannesburg
RUN apt-get update && apt-get install -y tzdata && \
    ln -fs /usr/share/zoneinfo/Africa/Johannesburg /etc/localtime && \
    dpkg-reconfigure -f noninteractive tzdata

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all app files
COPY . .

# Expose your app port
EXPOSE 3000

# Start your app
CMD ["node", "webui.js"]

