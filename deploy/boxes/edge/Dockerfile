# mumbo edge (router + model host). Runs on the E2B host with host networking; see ../DESIGN.md.
FROM node:24-bookworm-slim
WORKDIR /edge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY edge.mjs store.mjs template.mjs ./
USER node
CMD ["node", "edge.mjs"]
