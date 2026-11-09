# mumbo edge (router + model host). Runs on the E2B host with host networking; see ../DESIGN.md.
FROM node:24-bookworm-slim
WORKDIR /edge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY edge.mjs store.mjs sandboxes.mjs projects.mjs template.mjs github.mjs approvals.mjs github-app.mjs approve-page.mjs halt.mjs budget.mjs notify.mjs ./
COPY box/ ./box/
USER node
CMD ["node", "edge.mjs"]
