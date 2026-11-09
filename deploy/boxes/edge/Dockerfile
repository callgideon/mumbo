# mumbo edge (router + model host). Runs on the E2B host with host networking; see ../DESIGN.md.
FROM node:24-bookworm-slim
WORKDIR /edge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Sign-in page (edge authUi): the supabase-js browser build pinned as in the retired web image (deploy/Dockerfile), and
# auth-ui/index.html, a copy of deploy/auth-ui/index.html, which is outside this build context (auth-ui.test.mjs checks).
RUN cd /tmp && npm pack @supabase/supabase-js@2.118.0 --silent && tar xzf supabase-supabase-js-2.118.0.tgz package/dist/umd/supabase.js \
 && echo "ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3  package/dist/umd/supabase.js" | sha256sum -c - \
 && install -D -m 0644 package/dist/umd/supabase.js /edge/auth-ui/supabase.js && rm -rf /tmp/package /tmp/*.tgz
COPY auth-ui/index.html auth-ui/consent.js ./auth-ui/
COPY *.mjs ./
COPY box/ ./box/
USER node
# Every module and file main() loads must be in the image: a missing one crashes the task at start and ECS rolls back.
# The check (edge.mjs imageCheck) imports every module, the dynamically imported ones too, and reads runtimeFiles(), as
# the runtime user.
RUN node edge.mjs --check
CMD ["node", "edge.mjs"]
