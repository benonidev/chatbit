# Build stage
ARG BUILD_BASE_IMAGE="req"
ARG TARGET_BASE_IMAGE="req"

# Create build container
FROM --platform=$BUILDPLATFORM $BUILD_BASE_IMAGE AS builder

# Arguments for build container
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH
ARG CI_JOB_ID
ARG CI_COMMIT_TAG
# Commit and version of the build. The commit names the service worker cache,
# so without it clients never notice an update (there is no git in the build image).
ARG COMMIT=""
ARG VERSION=""

# Set working directory
WORKDIR /app

# Install KS Cert
RUN  apk add --no-cache ca-certificates

RUN update-ca-certificates

# Install Taskfile
RUN go install github.com/go-task/task/v3/cmd/task@latest

# Copy Go modules to Container
COPY go.mod go.sum ./

# Download Go modules
RUN go mod download

# Copy whole repo inside the container
COPY . .

# Build application for target arch
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH COMMIT=$COMMIT VERSION=$VERSION task build:app

# Runner stage
FROM $TARGET_BASE_IMAGE

# Set maintainer as label to the target image
LABEL maintainer="alessandro@kbenoni.dev"

# Set working directory
WORKDIR /app

# Copy application from build container
COPY --from=builder /app/artifacts/chatbit .

# Copy web content
COPY dist ./dist/

# Run as non-root user
RUN addgroup -g 1000 chatbit && \
    adduser -D -u 1000 -G chatbit chatbit && \
    chown -R chatbit:chatbit /app

USER chatbit

ENTRYPOINT ["./chatbit"]