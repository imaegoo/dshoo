# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=0.1.0
# CGO is off: the SQLite driver is pure Go, so the result runs in a minimal
# image with no libc.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/dshoo ./cmd/dshoo \
    && mkdir -p /out/data \
    && touch /out/data/.keep

# ---- runtime ---------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build --chown=nonroot:nonroot /out/dshoo /usr/local/bin/dshoo
# The data directory must pre-exist with the runtime user's ownership, otherwise
# a fresh named volume is created as root and SQLite cannot write to it.
COPY --from=build --chown=nonroot:nonroot /out/data/.keep /data/.keep

ENV DSHOO_ADDR=:9830 \
    DSHOO_DATA=/data

VOLUME ["/data"]
EXPOSE 9830

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/dshoo"]
