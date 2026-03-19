FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s CMD wget -q -O- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
