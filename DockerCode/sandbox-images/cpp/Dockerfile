FROM gcc:14
RUN groupadd -g 10001 runner && useradd -u 10001 -g runner -m runner
WORKDIR /workspace
USER 10001:10001
