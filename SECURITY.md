# Security policy

## Supported versions

Only the latest release receives fixes. Please update before reporting.

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/Jxkss/overclip/security/advisories/new)
instead. You'll get a reply as soon as possible, and credit in the release notes if you'd like.

## Scope notes

- Overclip makes no network requests of its own, other than opening links in your browser when
  you click them.
- The UI can only call the backend commands it needs; file operations are limited to paths
  inside your configured clip and screenshot folders, and deletions go to the Recycle Bin.
