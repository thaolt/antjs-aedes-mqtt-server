# Builder image: Ant runtime on Alpine. The installer detects
# /etc/alpine-release and fetches the linux-musl build, so `ant compile`
# produces a statically linked binary suitable for `FROM scratch` images.
FROM alpine:3.24

RUN apk add --no-cache bash curl ca-certificates \
 && curl -fsSL https://antjs.org/install | bash \
 && ln -s /root/.ant/bin/ant /usr/local/bin/ant

# Source tree is mounted here at build time (`docker run -v "$PWD:/src"`).
WORKDIR /src

ENTRYPOINT ["ant"]
CMD ["compile", "server.js"]
