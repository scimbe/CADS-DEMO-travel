# Byte-identical pin to every sibling demo's Caddy.Dockerfile (CADS-DEMO-sort, CADS-a2a-demo,
# CADS-auction-demo) -- plain Caddy, no custom build, cert issued CORE-side and mounted in.
FROM caddy:2@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d

RUN addgroup -g 1001 -S caddy && adduser -u 1001 -S -G caddy -H -s /sbin/nologin caddy
USER caddy

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -ksf https://localhost/ || exit 1
