# Contributing to Gooseherd

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/chocksy/gooseherd.git
cd gooseherd
npm install
cp .env.example .env   # edit with your tokens
npm run dev
```

## Running Tests

```bash
npm run check    # TypeScript type check
npm run build    # Compile
npm test         # Run test suite
```

## Submitting Changes

1. Fork the repo and create a feature branch from `main`.
2. Make your changes — keep commits focused and atomic.
3. Ensure `npm run check && npm run build && npm test` all pass.
4. Open a pull request against `main` with a clear description.

## Reporting Bugs

Use the [bug report template](https://github.com/chocksy/gooseherd/issues/new?template=bug_report.md).

## Requesting Features

Use the [feature request template](https://github.com/chocksy/gooseherd/issues/new?template=feature_request.md).

## Code Style

- TypeScript with strict mode
- No default exports
- Prefer `async/await` over raw promises
- Follow existing patterns in the codebase

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
