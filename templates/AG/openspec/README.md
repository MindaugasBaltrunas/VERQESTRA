# OpenSpec Workflow

OpenSpec stores product intent and change proposals for this project.

## Structure

```text
AG/openspec/
├── README.md
├── project.md
├── changes/
│   ├── _template/
│   │   ├── proposal.md
│   │   ├── tasks.md
│   │   ├── design.md
│   │   └── spec.md
│   └── archive/
└── specs/
    └── README.md
```

## VERQESTRA Integration

- Tasks may reference `AG/openspec/changes/<change-id>/`.
- VERQESTRA loads bounded context from the referenced change and touched specs.
- Keep specs concise and product-focused.
- Do not store runtime logs or generated state in OpenSpec.

