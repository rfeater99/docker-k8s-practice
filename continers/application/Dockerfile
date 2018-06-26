FROM node:8.11.3

WORKDIR /app
COPY ./todos/package.json /app/
RUN apt-get update && apt-get install -y vim curl && npm install

COPY ./todos /app

ENTRYPOINT ["npm", "start"]

