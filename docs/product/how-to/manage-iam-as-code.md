# How to manage IAM as code (GitOps)

*Make YAML the source of truth for users, groups, and OAuth providers — reviewed in pull requests, reconciled into the encrypted DB on every apply.*

Switch to declarative mode when IAM changes should be code review: every grant in `git log`, replicas converging from one file, and admin-API IAM mutations locked out (they return `403 {"error": "iam_declarative"}`), so runtime drift cannot happen. Stay in GUI mode if the admin UI is your daily driver — see [GUI-managed vs declarative IAM](../explanation/security-model.md#gui-managed-vs-declarative-iam) for the trade-off.

## 1. Export the current state

Seed your GitOps file from the live DB. The dedicated export endpoint projects current users, groups, providers, and mapping rules into a ready-to-paste `access:` fragment with `iam_mode: declarative` already set:

```bash
curl -s -c /tmp/dgp.cookies -X POST https://s3.acme.example/_/api/admin/login \
  -H 'Content-Type: application/json' -d '{"password": "<bootstrap-password>"}'

curl -s -b /tmp/dgp.cookies \
  https://s3.acme.example/_/api/admin/config/declarative-iam-export > iam.yaml
```

Secrets are redacted on the way out (`secret_access_key: ""`, `client_secret: null`) — re-inject them before applying (step 4). Entities reference each other **by name**, never by DB id:

```yaml
access:
  iam_mode: declarative
  iam_groups:
    - name: Engineering
      permissions:
        - effect: Allow
          actions: ["read", "list"]
          resources: ["releases/*", "downloads/*"]
  iam_users:
    - name: ci-uploader
      access_key_id: AKIACIUP00001
      secret_access_key: ""        # redacted — re-inject before apply
      enabled: true
      groups: ["Engineering"]
      permissions:
        - effect: Allow
          actions: ["write"]
          resources: ["releases/firmware/*"]
```

If you're starting from scratch instead, author this shape by hand — the full wire format is in the [declarative IAM reference](../reference/declarative-iam.md).

## 2. Preview the diff

Dry-run before every apply. `POST /_/api/admin/config/section/access/validate` (same body as the PUT) runs the same diff the live apply would, with zero DB writes, and returns a preview line in `warnings`:

```
declarative IAM preview: users(+1/~2/-0) groups(+0/~1/-0) providers(+0/~0/-0) mapping_rules=keep
```

In the admin UI the ApplyDialog surfaces the same line under Warnings, so you see exactly how many users will be created, updated, and **deleted** before clicking Apply:

![Declarative IAM diff preview in the ApplyDialog](/_/screenshots/declarative-iam-diff.jpg)

If you flip from `gui` to `declarative` with no `iam_users`/`iam_groups` in the YAML, the preview warns that the live apply will **refuse** — the empty-YAML gate exists so a careless toggle can't wipe a populated DB. That warning is the system working; add your IAM state to the YAML and re-validate.

Validation is all-or-nothing: duplicate access keys, unknown group references, or invalid permissions fail the whole apply with zero state change.

## 3. Apply

From CI or your workstation, push the full document with the CLI:

```bash
export DGP_BOOTSTRAP_PASSWORD=...   # env var, not a flag — argv leaks via ps
deltaglider_proxy config apply deltaglider_proxy.yaml --server https://s3.acme.example
```

Exit `0` means applied **and** persisted; the reconcile summary (`declarative IAM reconciled: ...`) is echoed to stderr, and every mutation lands in the audit log as `iam_reconcile_*`.

To apply just the access section over the API instead, `PUT /_/api/admin/config/section/access` with the section body (RFC 7396 merge-patch: omitted keys are preserved, `null` deletes).

Because the diff matches entities by name, an edited `access_key_id` on an existing user is an UPDATE that preserves the DB row — so OAuth identity bindings survive key rotations.

## 4. Keep secrets out of git

Use `${env:NAME}` references in the committed file:

```yaml
  iam_users:
    - name: ci-uploader
      access_key_id: AKIACIUP00001
      secret_access_key: "${env:CI_UPLOADER_SECRET}"
```

`config apply` expands `${env:NAME}` against the *operator's* environment before sending, and the server expands it when loading the config file from disk at startup. `config lint` fails loudly on an unset variable with no default — run it in CI to catch missing secrets before the apply. Two caveats: raw admin-API bodies (the section PUT) are **not** expanded — render secrets into the payload yourself on that path — and a `${env:NAME:-default}` default applies when the variable is unset. If you must keep a rendered file with plaintext secrets on disk, `chmod 0600` it and keep it out of the image and the repo.

## 5. Switch back to GUI mode

Set `access.iam_mode: gui` and apply. The flip is a no-op on the DB — all state is preserved — and admin-API IAM mutations unlock again. Mode transitions are audit-logged.

## Verify

1. Re-apply the unchanged file: the preview reports `no IAM changes (idempotent apply)` and no `iam_reconcile_*` audit entries appear — your YAML and the DB agree.
2. Try a GUI mutation (**Settings → Access → Users** → edit): expect `403 iam_declarative`.
3. Sign a request as a YAML-defined user (`ci-uploader`) — expect normal IAM evaluation.

## Related

- [Declarative IAM reference](../reference/declarative-iam.md) — wire shape, diff semantics, the empty-YAML gate, adversarial edges.
- [Configuration reference](../reference/configuration.md) — `${env:NAME}` expansion and the sectioned YAML format.
- [CLI reference](../reference/cli.md) — `config apply` / `config lint` exit codes.
- [How to create IAM users and groups](create-iam-users.md) — the GUI-mode equivalent.
