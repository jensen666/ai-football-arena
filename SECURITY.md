# Security Policy

## Supported Versions

This project is developed as a small open-source demo. The latest version on the default branch is the supported version.

## Reporting A Vulnerability

Please do not open a public issue with live secrets, private tokens, local paths, or exploit details.

If GitHub Security Advisories are enabled for the repository, use a private security advisory. Otherwise, open a minimal public issue that describes the affected area without sensitive details, and the maintainers can continue privately if needed.

## Secret Handling

Do not commit API keys or local credentials. Prefer environment variable references such as:

```text
env:DEEPSEEK_API_KEY
env:OPENAI_API_KEY
```

The following local paths are intentionally ignored by Git because they may contain runtime data or private configuration:

- `config/app.json`
- `config/*.local.json`
- `secrets/`
- `matches/`
- `reports/`
- `cache/`
- `.private/`

If a real key was committed or shared by mistake, revoke and rotate it immediately.
