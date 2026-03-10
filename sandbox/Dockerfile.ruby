# Example sandbox image for Ruby/Rails projects.
# Reference from .gooseherd.yml:
#   sandbox:
#     dockerfile: sandbox/Dockerfile.ruby
#
# Or use in your own repo's .gooseherd.yml:
#   sandbox:
#     dockerfile: .docker/sandbox.Dockerfile

FROM ruby:3.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential libpq-dev nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install bundler
RUN gem install bundler

WORKDIR /work
CMD ["sleep", "infinity"]
