FROM scratch

COPY server /

EXPOSE 1883 1884

ENTRYPOINT ["/server"]