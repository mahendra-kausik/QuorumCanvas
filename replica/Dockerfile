# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- runtime stage: prod deps only, non-root, no source/toolchain ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
# Named volume mounts inherit ownership from the image dir they mount over on first use —
# pre-create it owned by the non-root `node` user we run as, or DATA_DIR writes get EACCES.
RUN mkdir -p /app/instance && chown node:node /app/instance
USER node
CMD ["node", "dist/index.js"]
