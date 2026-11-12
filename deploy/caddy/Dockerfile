# Caddy with the Azure DNS plugin, for Let's Encrypt wildcard certificates via
# the DNS challenge (works for VPN-only servers).
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/azure

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
