# Contributing

Thanks for your interest in improving this project.

## Ways to contribute
- Open an Issue for bugs, questions, or feature requests.
- Submit a Pull Request (PR) with fixes or improvements.
- Share feedback from real deployments (optional but appreciated).

If you build a derivative or deploy internally, feel free to open an Issue to let us know (optional).

## Pull Request workflow (recommended)
1. Fork the repo (or create a branch if you have write access).
2. Create a feature branch:
   - feature/<short-name>
   - fix/<short-name>
3. Keep changes focused and small when possible.
4. Ensure the app starts and basic flows work:
   - pnpm install
   - pnpm dev
5. Submit a PR to main with a clear description.

## Security and secrets
- Do NOT commit secrets (tokens, passwords, internal URLs, private IPs).
- Use placeholders in docs and examples (e.g., <YOUR_TOKEN>).
- Use /etc/ai-canvas-dev.env (systemd EnvironmentFile) or a local .env.local (ignored) for real values.

If you believe you found a security issue, please avoid filing a public issue with sensitive details. Share a minimal report via a private channel.

## License
By contributing, you agree that your contributions will be licensed under the project's LICENSE.
