# Getting started

`taskctl` is a command-line task tracker. It stores everything in a single JSON
file and needs no server.

## Install

```bash
npm install --global taskctl
```

## First run

```bash
taskctl init            # creates ./tasks.json
taskctl add "Write the report" --priority high
taskctl list
taskctl done <id>
```

## Where the data lives

By default `taskctl` reads and writes `./tasks.json`. Point it elsewhere with
`--store <path>` or the `TASKCTL_STORE` environment variable; the flag wins when
both are set.

## Next steps

- [Configuration](./configuration.md) — every setting and its default.
