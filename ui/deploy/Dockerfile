FROM nginx:1.27-alpine

ENV PORT=8080

COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY . /usr/share/nginx/html
RUN rm -rf /usr/share/nginx/html/deploy /usr/share/nginx/html/tests

EXPOSE 8080
