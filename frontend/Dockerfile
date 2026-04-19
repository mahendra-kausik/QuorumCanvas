FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY vite.config.ts ./
COPY eslint.config.js ./
COPY index.html ./
COPY README.md ./
COPY public/ public/
COPY src/ src/
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
