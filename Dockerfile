FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json eslint.config.js ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    CLAWTOP_HTTP_HOST=0.0.0.0 \
    CLAWTOP_PORT=3333 \
    CLAWTOP_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3333
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "const p=process.env.CLAWTOP_HTTP_PASSWORD;const headers=p?{authorization:'Basic '+Buffer.from((process.env.CLAWTOP_HTTP_USERNAME||'clawtop')+':'+p).toString('base64')}:{};fetch('http://127.0.0.1:'+process.env.CLAWTOP_PORT+'/api/health',{headers}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
