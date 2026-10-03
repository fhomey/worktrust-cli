# Security

## Reporting a problem

Write to **hello@worktrust.io** with "security" in the subject. Please do not open a public issue
for a vulnerability. You will get an answer within three working days.

## What this package can and cannot do

- It writes only the files listed in the README, after showing them and asking. `--dry-run` writes
  nothing and sends nothing.
- It contacts one host: the WorkTrust app (`https://app.worktrust.io` unless you pass `--origin`).
  It downloads nothing when run from npm.
- The key it receives is a WorkTrust coupling for this computer: it can submit work metadata to your
  record and cannot read your record back. Revoke it in WorkTrust at any time.
- Approving requires your WorkTrust session and second factor. A pairing expires after ten minutes
  and gives out its key once.
- By default the key can only reach the terminal on the computer whose browser approved it: the
  browser returns a one-time code to 127.0.0.1, and the key is issued only to the terminal holding
  the matching PKCE verifier (S256). The terminal listens on 127.0.0.1 only, for one answer that
  carries the state it chose.
- The typed-code way (no browser, `--device`) is the one a stranger could try to abuse by asking you
  to type their code. The code is never put in a link; type only a code your own terminal shows.

## Where the key is, and how long it lives

- In `~/.worktrust/key.json`, readable by you alone (600 in a 700 folder). No keychain is used. Not
  in any AI app's settings, unless you chose `--direct`.
- Bound to this computer: every call carries an Ed25519 signature made with a private key that is in
  that file only. WorkTrust refuses a bound key without a fresh signature (two minutes, a nonce that
  is spent once), so a key leaked from a log or a config is useless on its own. Someone who can read
  your home folder can read the file: revoke the computer in WorkTrust if that happens.
- Renewed every week by the computer itself: only the new key's hash is sent, signed, and the old
  key stops working.
- The key can submit metadata to your record and cannot read it back. It ends when you revoke it,
  and by itself 90 days after its last use.

## Verifying a version

Each version is published from the public repository by GitHub Actions with npm provenance.
On npmjs.com the version shows where and from which commit it was built; locally,
`npm audit signatures` checks the signatures of what you installed.
