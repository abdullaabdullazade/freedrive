FROM golang:1.25-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/freedrive ./cmd/freedrive

FROM alpine:3.22

RUN addgroup -g 1000 -S freedrive && adduser -u 1000 -S -G freedrive freedrive

WORKDIR /app

COPY --from=builder /out/freedrive /usr/local/bin/freedrive

ENV FREEDRIVE_PORT=8080
ENV FREEDRIVE_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R freedrive:freedrive /app

USER freedrive

EXPOSE 8080

CMD ["freedrive"]
