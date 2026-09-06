FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY bot.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]