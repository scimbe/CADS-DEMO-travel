# Plain Node.js -- zero external npm dependencies (node:http + node:test only, matches
# CADS-DEMO-sort/bridge's house style). No Rust build stages needed here: unlike sort's bridge,
# this one never shells out to a channel-grant binary or ct-agent -- its only external calls are
# plain HTTPS to Nominatim/OSRM/LiteLLM.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app
COPY bridge/package.json ./
COPY bridge/server.js bridge/server.lib.js ./
COPY bridge/lib ./lib
RUN chown -R node:node /app
USER node
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8789/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
