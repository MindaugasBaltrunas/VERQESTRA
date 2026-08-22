# Changelog

All notable changes to `taskctl` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-03-11

### Added

- `--store <path>` flag and the `TASKCTL_STORE` environment variable.
- `taskctl list --priority <label>` filter.

### Fixed

- `taskctl done` no longer rewrites the whole file when the id is unknown.

## [0.1.0] - 2026-01-20

### Added

- First release: `init`, `add`, `list` and `done`.
